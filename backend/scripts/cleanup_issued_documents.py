"""Remove only stale unreferenced issued-PDF objects after a database check."""

from pathlib import Path

from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.documents.storage import cleanup_orphans
from app.models import Application, IssuedDocument, ServiceType


def referenced_keys() -> set[str]:
    with SessionLocal() as session, session.begin():
        # Issuance holds this application row lock from before publication
        # through COMMIT. NOWAIT makes cleanup stop if a COMMIT is unresolved.
        session.scalars(
            select(Application.id)
            .join(ServiceType)
            .where(
                Application.review_status == "approved",
                Application.document_status.in_(("pending", "failed")),
                ServiceType.produces_document.is_(True),
            )
            .with_for_update(nowait=True, of=Application)
        ).all()
        return set(session.scalars(select(IssuedDocument.storage_key)).all())


if __name__ == "__main__":
    attachment_root = Path(get_settings().attachment_storage_path)
    print(f"Removed {cleanup_orphans(attachment_root, referenced_keys)} stale issued PDFs")
