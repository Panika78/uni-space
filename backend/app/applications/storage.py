"""Private, content-addressed attachment storage with crash-safe staging."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from fastapi import HTTPException

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES = 5
MAX_TOTAL_BYTES = 50 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png"}
_SAFE_EXTENSION = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png"}


@dataclass(frozen=True)
class StagedAttachment:
    stage_path: Path
    storage_key: str
    filename: str
    mime_type: str
    size_bytes: int


def detect_mime(header: bytes, filename: str) -> str:
    if header.startswith(b"%PDF-") and filename.lower().endswith(".pdf"):
        return "application/pdf"
    if header.startswith(b"\xff\xd8\xff") and filename.lower().endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n") and filename.lower().endswith(".png"):
        return "image/png"
    return "application/octet-stream"


def _safe_filename(filename: str) -> str:
    value = Path(filename.replace("\\", "/")).name
    value = re.sub(r"[^\w.() -]", "_", value, flags=re.UNICODE).strip(" .")
    return value[:200] or "attachment"


def stage_upload(source: BinaryIO, filename: str, root: Path) -> StagedAttachment:
    """Copy from a spooled upload in bounded chunks; never trust client MIME/name."""
    filename = _safe_filename(filename)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    staging = root / ".staging"
    staging.mkdir(mode=0o700, exist_ok=True)
    staging.chmod(0o700)
    fd, temporary_name = tempfile.mkstemp(prefix="upload-", dir=staging)
    path = Path(temporary_name)
    os.fchmod(fd, 0o600)
    digest = hashlib.sha256()
    size = 0
    prefix = b""
    try:
        with os.fdopen(fd, "wb") as target:
            while chunk := source.read(CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(413, "request_too_large")
                if len(prefix) < 16:
                    prefix += chunk[: 16 - len(prefix)]
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        if size == 0:
            raise HTTPException(422, "invalid_attachment")
        mime = detect_mime(prefix, filename)
        if mime not in ALLOWED_TYPES:
            raise HTTPException(422, "invalid_attachment")
        # Basic structural checks catch truncated common files without claiming semantic review.
        with path.open("rb") as saved:
            saved.seek(max(0, size - 1024))
            trailer = saved.read()
        if mime == "application/pdf" and b"%%EOF" not in trailer:
            raise HTTPException(422, "invalid_attachment")
        if mime == "image/jpeg" and not trailer.endswith(b"\xff\xd9"):
            raise HTTPException(422, "invalid_attachment")
        if mime == "image/png" and not trailer.endswith(b"IEND\xaeB`\x82"):
            raise HTTPException(422, "invalid_attachment")
        extension = _SAFE_EXTENSION[mime]
        key = f"{uuid.uuid4().hex}{extension}"
        return StagedAttachment(path, key, filename, mime, size)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def publish(staged: StagedAttachment, root: Path) -> Path:
    destination = root / staged.storage_key
    # link() is atomic and refuses to overwrite an existing key.
    os.link(staged.stage_path, destination)
    staged.stage_path.unlink()
    directory_fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return destination


def discard(staged: StagedAttachment) -> None:
    staged.stage_path.unlink(missing_ok=True)


def delete_key(root: Path, storage_key: str) -> None:
    # Keys originate from UUIDs; reject path separators even for corrupt DB values.
    if not re.fullmatch(r"[a-f0-9]{32}\.(?:pdf|jpg|png)", storage_key):
        return
    (root / storage_key).unlink(missing_ok=True)


def open_key(root: Path, storage_key: str):
    if not re.fullmatch(r"[a-f0-9]{32}\.(?:pdf|jpg|png)", storage_key):
        raise FileNotFoundError
    descriptor = os.open(root / storage_key, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    return os.fdopen(descriptor, "rb")


def cleanup_orphans(
    root: Path, referenced_keys: set[str], *, older_than_seconds: int = 3600
) -> int:
    """Idempotently remove stale staging/orphan files; active recent uploads are retained."""
    import time

    cutoff = time.time() - older_than_seconds
    removed = 0
    staging = root / ".staging"
    if staging.exists():
        for path in staging.iterdir():
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
                    removed += 1
            except FileNotFoundError:
                continue
    for path in root.iterdir():
        try:
            if (
                path.is_file()
                and path.name not in referenced_keys
                and path.stat().st_mtime < cutoff
            ):
                path.unlink(missing_ok=True)
                removed += 1
        except FileNotFoundError:
            continue
    return removed
