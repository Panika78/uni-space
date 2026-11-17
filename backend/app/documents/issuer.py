"""Failure-safe synchronous PDF issuance in a transaction after approval."""

from __future__ import annotations

import io
import logging
import multiprocessing
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException
from pypdf import PdfReader
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
ISSUANCE_OPERATION_TIMEOUT_SECONDS = 10


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
        if application.document_status == "ready" and document is None:
            logger.error("ready application %s has no issued document", application_id)
            raise HTTPException(503, "document_unavailable")
        if application.document_status != "ready" and document is not None:
            logger.error("application %s has an unready issued document", application_id)
            raise HTTPException(503, "document_unavailable")
        return DocumentState(
            application.review_status,
            application.document_status,
            application.version,
            _metadata(document),
        )


def _validate_pdf(content: bytes, snapshot: dict) -> None:
    """Reject malformed, unreadable, or incomplete renderer output before publish."""
    if not isinstance(content, bytes) or not content or len(content) > storage.MAX_PDF_BYTES:
        raise ValueError("PDF renderer returned empty or oversized content")
    if not content.startswith(b"%PDF-"):
        raise ValueError("PDF renderer returned an invalid header")
    reader = PdfReader(io.BytesIO(content), strict=True)
    if reader.is_encrypted or not reader.pages:
        raise ValueError("PDF must contain at least one readable page")
    extracted = " ".join(" ".join((page.extract_text() or "").split()) for page in reader.pages)
    required = [
        snapshot.get("document_number"),
        snapshot.get("issued_at"),
        snapshot.get("full_name"),
        pdf.DEMO_MARK,
    ]
    code = snapshot.get("service_code")
    if code == "study_certificate":
        required.extend(
            snapshot.get(field)
            for field in ("group", "program", "direction", "place_of_submission")
        )
        status = {
            "enrolled": "обучается",
            "academic_leave": "находится в академическом отпуске",
            "expelled": "отчислен",
            "graduated": "завершил обучение",
        }.get(snapshot.get("academic_status"), "статус не установлен")
        required.append(status)
    elif code == "academic_transcript":
        required.append((snapshot.get("term") or {}).get("name"))
    elif code == "accounting_certificate":
        required.append(snapshot.get("example_statement"))
        if snapshot.get("purpose") is not None:
            required.append(snapshot.get("purpose"))
    if any(
        not isinstance(value, str) or not value.strip() or " ".join(value.split()) not in extracted
        for value in required
    ):
        raise ValueError("PDF is missing required readable document fields")


def _execute_issued_filesystem_operation(connection, name: str, args: tuple[object, ...]) -> None:
    try:
        if name == "prepare_root":
            storage.issued_root(Path(args[0]))
        elif name == "render_publish":
            snapshot, root, key, renderer = args
            content = (renderer or pdf.render_pdf)(snapshot)
            _validate_pdf(content, snapshot)
            storage.publish_bytes(Path(root), key, content)
        elif name == "delete":
            storage.delete_key(Path(args[0]), args[1])
        elif name == "validate_ready":
            attachment_root, key, snapshot = args
            root = storage.existing_issued_root(Path(attachment_root))
            with storage.open_key(root, key) as stream:
                content = stream.read(storage.MAX_PDF_BYTES + 1)
            _validate_pdf(content, snapshot)
        else:
            raise ValueError("unknown issued-document filesystem operation")
        connection.send((True, None))
    except BaseException as exc:
        with suppress(BrokenPipeError, OSError):
            connection.send((False, f"{type(exc).__name__}: {exc}"))
    finally:
        connection.close()


def _run_issued_filesystem_operation(
    operation: str,
    *arguments: object,
    renderer: Callable[[dict], bytes] | None = None,
) -> None:
    """Run PDF and filesystem work in a killable process with a hard deadline."""
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    operation_arguments = arguments + ((renderer,) if operation == "render_publish" else ())
    process = context.Process(
        target=_execute_issued_filesystem_operation,
        args=(child, operation, operation_arguments),
    )
    deadline = time.monotonic() + ISSUANCE_OPERATION_TIMEOUT_SECONDS
    try:
        process.start()
        child.close()
        remaining = max(0, deadline - time.monotonic())
        if not parent.poll(remaining):
            raise TimeoutError(f"issued-document {operation} timed out")
        succeeded, error = parent.recv()
        process.join(max(0, deadline - time.monotonic()))
        if process.is_alive():
            raise TimeoutError(f"issued-document {operation} did not stop")
        if not succeeded or process.exitcode != 0:
            raise OSError(error or f"issued-document {operation} failed")
    except BaseException:
        if process.pid is not None and process.is_alive():
            process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join()
        raise
    finally:
        parent.close()
        child.close()


def _preflight(application_id: int, *, actor_kind: str, actor_id: int) -> DocumentState:
    """Validate access and retryability before touching storage coordination."""
    with SessionLocal() as db:
        application = db.get(Application, application_id)
        if application is None:
            raise HTTPException(404, "not_found")
        _authorize(db, application, actor_kind=actor_kind, actor_id=actor_id)
        service = db.get(ServiceType, application.service_type_id)
        if service is None or not service.produces_document:
            raise HTTPException(409, "document_not_available")
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == application.id)
        )
        if application.document_status == "ready":
            if application.review_status != "approved" or document is None:
                raise HTTPException(503, "document_unavailable")
            return DocumentState(
                application.review_status,
                application.document_status,
                application.version,
                _metadata(document),
            )
        if application.review_status != "approved" or application.document_status not in {
            "pending",
            "failed",
        }:
            raise HTTPException(409, "invalid_transition")
        if document is not None:
            raise HTTPException(503, "document_unavailable")
        return DocumentState(
            application.review_status,
            application.document_status,
            application.version,
            None,
        )


def issue_document(
    application_id: int,
    *,
    actor_kind: str,
    actor_id: int,
    render_pdf_fn: Callable[[dict], bytes] | None = None,
) -> DocumentState:
    """Issue once; serialization spans the shared PDF directory and DB commit."""
    preflight = _preflight(application_id, actor_kind=actor_kind, actor_id=actor_id)
    if preflight.document_status == "ready":
        try:
            with SessionLocal() as db:
                document = db.scalar(
                    select(IssuedDocument).where(IssuedDocument.application_id == application_id)
                )
                if document is None:
                    raise HTTPException(503, "document_unavailable")
                attachment_root = str(Path(get_settings().attachment_storage_path))
                _run_issued_filesystem_operation(
                    "validate_ready", attachment_root, document.storage_key, document.snapshot_data
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("ready issued PDF is unavailable for application %s", application_id)
            raise HTTPException(503, "document_unavailable") from exc
        return preflight

    published_key: str | None = None
    commit_attempted = False
    try:
        attachment_root = Path(get_settings().attachment_storage_path)
        _run_issued_filesystem_operation("prepare_root", str(attachment_root))
        pdf_root = attachment_root / "issued_documents"
        coordination = attachment_storage.coordination_lock(pdf_root, timeout_seconds=10)
        coordination.__enter__()
    except (OSError, TimeoutError) as exc:
        logger.exception("issued PDF storage is temporarily unavailable")
        raise HTTPException(503, "document_unavailable") from exc
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
            key = storage.create_key()
            published_key = key
            _run_issued_filesystem_operation(
                "render_publish", snapshot, str(pdf_root), key, renderer=render_pdf_fn
            )
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
            try:
                _run_issued_filesystem_operation("delete", str(pdf_root), published_key)
            except Exception:
                logger.exception(
                    "could not remove orphan issued PDF for application %s; cleanup will retry",
                    application_id,
                )
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
        except Exception as state_error:
            logger.exception("could not read application after PDF failure")
            raise HTTPException(503, "temporarily_unavailable") from state_error
    finally:
        coordination.__exit__(None, None, None)
