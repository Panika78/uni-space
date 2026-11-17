"""Failure-safe synchronous PDF issuance in a transaction after approval."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.applications import storage as attachment_storage
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.documents import pdf, storage
from app.models import Application, IssuedDocument, ServiceType, Student, User
from app.permissions import PermissionCode, get_application_scope, get_authorization_context

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DocumentState:
    review_status: str
    document_status: str
    version: int
    document: dict | None


def _metadata(document: IssuedDocument | None) -> dict | None:
    if document is None:
        return None
    return {
        "id": str(document.id),
        "filename": document.filename,
        "issued_at": document.issued_at,
    }


def _authorize(
    db: Session,
    application: Application,
    *,
    actor_kind: str,
    actor_id: int,
) -> None:
    actor = db.scalar(
        select(User).where(User.id == actor_id).execution_options(populate_existing=True)
    )
    if actor is None or not actor.is_active:
        raise HTTPException(401, "session_invalid")
    if actor_kind == "owner":
        student = db.scalar(select(Student).where(Student.user_id == actor_id))
        if actor.role != "student" or student is None or student.id != application.student_id:
            raise HTTPException(404, "not_found")
        return
    if actor_kind != "staff":
        raise HTTPException(403, "forbidden")
    context = get_authorization_context(db, actor)
    allowed_scopes = {
        int(permission.scope_org_unit_id)
        for permission in context.permissions
        if permission.permission_code == PermissionCode.APPLICATIONS_REVIEW
        and permission.scope_org_unit_id is not None
    }
    application_scope = db.scalar(
        select(get_application_scope()).where(Application.id == application.id)
    )
    if application_scope is None or application_scope not in allowed_scopes:
        raise HTTPException(404, "not_found")


def _read_state(application_id: int) -> DocumentState:
    with SessionLocal() as db:
        row = db.execute(
            select(Application, IssuedDocument)
            .outerjoin(IssuedDocument, IssuedDocument.application_id == Application.id)
            .where(Application.id == application_id)
        ).one_or_none()
        if row is None:
            raise HTTPException(404, "not_found")
        application, document = row
        return DocumentState(
            application.review_status,
            application.document_status,
            application.version,
            _metadata(document),
        )


def issue_document(
    application_id: int,
    *,
    actor_kind: str,
    actor_id: int,
) -> DocumentState:
    """Issue once; serialization spans the shared PDF directory and DB commit."""
    published_key: str | None = None
    commit_attempted = False
    try:
        attachment_root = Path(get_settings().attachment_storage_path)
        pdf_root = storage.issued_root(attachment_root)
        coordination = attachment_storage.coordination_lock(pdf_root, timeout_seconds=10)
        coordination.__enter__()
    except (OSError, TimeoutError):
        logger.exception("issued PDF storage is temporarily unavailable")
        try:
            return _read_state(application_id)
        except Exception:
            logger.exception("could not read application during PDF storage outage")
            return DocumentState("approved", "pending", 0, None)
    try:
        with SessionLocal() as db:
            application = db.scalar(
                select(Application)
                .where(Application.id == application_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if application is None:
                raise HTTPException(404, "not_found")
            _authorize(db, application, actor_kind=actor_kind, actor_id=actor_id)
            service = db.get(ServiceType, application.service_type_id)
            if service is None or not service.produces_document:
                raise HTTPException(409, "document_not_available")
            existing = db.scalar(
                select(IssuedDocument).where(IssuedDocument.application_id == application.id)
            )
            if application.document_status == "ready":
                if existing is None:
                    logger.error("ready application %s has no issued document", application.id)
                    raise HTTPException(503, "document_unavailable")
                try:
                    with storage.open_key(pdf_root, existing.storage_key) as stream:
                        if stream.read(5) != b"%PDF-":
                            raise OSError("stored PDF is invalid")
                except OSError as exc:
                    logger.exception("issued PDF unavailable for application %s", application.id)
                    raise HTTPException(503, "document_unavailable") from exc
                return DocumentState(
                    application.review_status,
                    application.document_status,
                    application.version,
                    _metadata(existing),
                )
            if existing is not None:
                logger.error("application %s has a document without ready status", application.id)
                raise HTTPException(503, "document_unavailable")
            if application.review_status != "approved" or application.document_status not in {
                "pending",
                "failed",
            }:
                raise HTTPException(409, "invalid_transition")

            document_number = f"US-DEMO-{uuid.uuid4().hex[:12].upper()}"
            snapshot = pdf.get_document_snapshot(db, application, document_number)
            content = pdf.render_pdf(snapshot)
            if not content or not content.startswith(b"%PDF-"):
                raise ValueError("PDF renderer returned invalid content")
            key = storage.create_key()
            storage.publish_bytes(pdf_root, key, content)
            published_key = key
            filename = f"{service.code}-{application.id}.pdf"
            document = IssuedDocument(
                application_id=application.id,
                storage_key=key,
                filename=filename,
                snapshot_data=snapshot,
            )
            db.add(document)
            db.flush()
            application.document_status = "ready"
            application.version += 1
            application.updated_at = func.statement_timestamp()
            db.flush()
            commit_attempted = True
            db.commit()
            return DocumentState(
                application.review_status,
                application.document_status,
                application.version,
                _metadata(document),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("PDF issuance failed for application %s", application_id)
        # Resolve a possibly successful COMMIT before touching a published file.
        known_unreferenced = False
        outcome: DocumentState | None = None
        if commit_attempted:
            try:
                outcome = _read_state(application_id)
                if outcome.document_status == "ready" and outcome.document is not None:
                    return outcome
                known_unreferenced = outcome.document is None and outcome.document_status != "ready"
            except Exception:
                logger.exception("could not resolve PDF commit for application %s", application_id)
        else:
            known_unreferenced = True
        if published_key and known_unreferenced:
            storage.delete_key(pdf_root, published_key)
        try:
            with SessionLocal() as failed_db:
                application = failed_db.scalar(
                    select(Application).where(Application.id == application_id).with_for_update()
                )
                if application and application.review_status == "approved":
                    document = failed_db.scalar(
                        select(IssuedDocument).where(
                            IssuedDocument.application_id == application_id
                        )
                    )
                    if document:
                        if application.document_status != "ready":
                            logger.error(
                                "application %s has an unready issued document",
                                application.id,
                            )
                            raise HTTPException(503, "document_unavailable")
                        return DocumentState(
                            application.review_status,
                            application.document_status,
                            application.version,
                            _metadata(document),
                        )
                    if application.document_status != "failed":
                        application.document_status = "failed"
                        application.version += 1
                        application.updated_at = func.statement_timestamp()
                        failed_db.commit()
                    return DocumentState(
                        application.review_status,
                        application.document_status,
                        application.version,
                        None,
                    )
        except SQLAlchemyError:
            logger.exception("could not persist failed PDF state for %s", application_id)
        # The durable approval is never converted to a failed request response.
        try:
            return _read_state(application_id)
        except Exception:
            logger.exception("could not read application after PDF failure")
            return DocumentState("approved", "pending", 1, None)
    finally:
        coordination.__exit__(None, None, None)
