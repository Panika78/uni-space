"""Remove stale staged/unreferenced attachment objects after an interrupted write."""

from pathlib import Path

from sqlalchemy import select

from app.applications.storage import cleanup_orphans
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import ApplicationAttachment

if __name__ == "__main__":
    root = Path(get_settings().attachment_storage_path)

    def referenced_keys() -> set[str]:
        with SessionLocal() as session:
            return set(
                session.scalars(
                    select(ApplicationAttachment.storage_key).where(
                        ApplicationAttachment.is_current.is_(True)
                    )
                )
            )

    print(f"Removed {cleanup_orphans(root, referenced_keys)} stale attachment objects")
