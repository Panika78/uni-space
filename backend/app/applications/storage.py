"""Private, content-addressed attachment storage with crash-safe staging."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import os
import re
import tempfile
import time
import uuid
import warnings
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from fastapi import HTTPException
from PIL import Image
from pypdf import PdfReader

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES = 5
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
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
    lock_fd: int


@contextmanager
def coordination_lock(root: Path, *, timeout_seconds: float = 10) -> Iterator[None]:
    """Serialize publication/commit and orphan cleanup across API processes."""
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    descriptor = os.open(root / ".coordination.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("storage coordination timed out") from None
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _valid_document(path: Path, mime_type: str) -> bool:
    try:
        if mime_type == "application/pdf":
            reader = PdfReader(path, strict=False)
            if reader.is_encrypted:
                return False
            return len(reader.pages) > 0
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format not in {"JPEG", "PNG"}:
                    return False
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    return False
                image.verify()
            with Image.open(path) as image:
                image.load()
        return True
    except OSError as exc:
        # Image/PDF parsers may use errno-less OSError for malformed content;
        # real filesystem failures carry an errno and must reach the API mapper.
        if exc.errno is not None:
            raise
        return False
    except Exception:
        return False


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
    lock_fd = None
    digest = hashlib.sha256()
    size = 0
    prefix = b""
    try:
        os.fchmod(fd, 0o600)
        lock_fd = os.dup(fd)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        target = os.fdopen(fd, "wb")
        fd = None
        with target:
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
        if not _valid_document(path, mime):
            raise HTTPException(422, "invalid_attachment")
        extension = _SAFE_EXTENSION[mime]
        key = f"{uuid.uuid4().hex}{extension}"
        return StagedAttachment(path, key, filename, mime, size, lock_fd)
    except BaseException:
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)
        if fd is not None:
            with contextlib.suppress(OSError):
                os.close(fd)
        if lock_fd is not None:
            with contextlib.suppress(OSError):
                os.close(lock_fd)
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
    os.close(staged.lock_fd)
    return destination


def discard(staged: StagedAttachment) -> None:
    try:
        with contextlib.suppress(OSError):
            staged.stage_path.unlink(missing_ok=True)
    finally:
        with contextlib.suppress(OSError):
            os.close(staged.lock_fd)


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
    root: Path,
    referenced_keys: set[str] | Callable[[], set[str]],
    *,
    older_than_seconds: int = 3600,
) -> int:
    """Delete old orphans while holding the same cross-process publication lock."""
    import time

    cutoff = time.time() - older_than_seconds
    removed = 0
    with coordination_lock(root):
        references = referenced_keys() if callable(referenced_keys) else referenced_keys
        staging = root / ".staging"
        if staging.exists():
            for path in staging.iterdir():
                try:
                    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                    try:
                        try:
                            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            continue
                        if os.fstat(descriptor).st_mtime < cutoff:
                            path.unlink(missing_ok=True)
                            removed += 1
                    finally:
                        os.close(descriptor)
                except FileNotFoundError:
                    continue
        for path in root.iterdir():
            if path.name.startswith("."):
                continue
            try:
                if path.is_file() and path.name not in references and path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
                    removed += 1
            except FileNotFoundError:
                continue
    return removed
