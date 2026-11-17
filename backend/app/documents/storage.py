"""Private persistent storage for issued PDFs, isolated from attachment cleanup."""

from __future__ import annotations

import os
import re
import tempfile
import uuid
from pathlib import Path

from app.applications import storage as attachment_storage

KEY_RE = re.compile(r"[a-f0-9]{32}\.pdf\Z")
MAX_PDF_BYTES = 10 * 1024 * 1024


def issued_root(attachment_root: Path) -> Path:
    root = attachment_root / "issued_documents"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    return root


def existing_issued_root(attachment_root: Path) -> Path:
    """Return the private issued directory without creating or changing it."""
    root = attachment_root / "issued_documents"
    info = root.lstat()
    if not root.is_dir() or root.is_symlink() or info.st_mode & 0o077:
        raise PermissionError("issued document directory is unavailable or not private")
    return root


def create_key() -> str:
    return f"{uuid.uuid4().hex}.pdf"


def publish_bytes(root: Path, key: str, content: bytes) -> Path:
    if not KEY_RE.fullmatch(key) or not content or len(content) > MAX_PDF_BYTES:
        raise ValueError("invalid issued PDF")
    root = issued_root(root.parent) if root.name != "issued_documents" else root
    fd, name = tempfile.mkstemp(prefix="issue-", dir=root)
    staged = Path(name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        destination = root / key
        os.link(staged, destination)  # atomic and refuses overwrite
        staged.unlink()
        directory_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return destination
    except BaseException:
        staged.unlink(missing_ok=True)
        raise


def open_key(root: Path, key: str):
    if not KEY_RE.fullmatch(key):
        raise FileNotFoundError
    descriptor = os.open(root / key, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    return os.fdopen(descriptor, "rb")


def delete_key(root: Path, key: str) -> None:
    if KEY_RE.fullmatch(key):
        (root / key).unlink(missing_ok=True)


def cleanup_orphans(attachment_root: Path, referenced_keys, *, older_than_seconds: int = 3600):
    """Remove stale, unreferenced PDFs under the shared publication lock."""
    root = issued_root(attachment_root)
    return attachment_storage.cleanup_orphans(
        root, referenced_keys, older_than_seconds=older_than_seconds
    )
