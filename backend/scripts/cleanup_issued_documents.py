"""Remove only stale unreferenced issued-PDF objects after a database check."""

from pathlib import Path

from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.documents.storage import cleanup_orphans
from app.models import IssuedDocument

if __name__ == "__main__":
    attachment_root = Path(get_settings().attachment_storage_path)

    def referenced_keys() -> set[str]:
        with SessionLocal() as session:
            return set(session.scalars(select(IssuedDocument.storage_key)))

    print(f"Removed {cleanup_orphans(attachment_root, referenced_keys)} stale issued PDFs")
