import json
import logging
import os
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import Select, select, tuple_
from sqlalchemy.orm import Session

# Shared RBAC contract from #60; no client-supplied organizational scope.
from app.applications import service as workflow
from app.applications import storage
from app.applications.schemas import (
    ApplicationHistoryEvent,
    ApplicationHistoryPage,
    ApplicationPage,
    ApplicationResponse,
    AttachmentMetadata,
    CreateApplicationRequest,
    IssuedDocumentMetadata,
    ResubmitApplicationRequest,
    ReviewApplicationRequest,
    Service,
    ServiceList,
    StaffApplicationPage,
    StaffApplicationResponse,
)
from app.core.body_limit import RequestTooLarge
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import ApiError, Id, PaginationParams, RequestModel
from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.documents import issuer
from app.documents import storage as issued_storage
from app.models import (
    Application,
    ApplicationAttachment,
    ApplicationHistory,
    IssuedDocument,
    ServiceType,
    Student,
    User,
)
from app.permissions import (
    PermissionCode,
    get_application_scope,
    get_authorization_context,
    require_application_review,
)

router = APIRouter(prefix="/api/v1", tags=["services", "applications"])
logger = logging.getLogger(__name__)
WORKFLOW_ERRORS = {code: {"model": ApiError} for code in (401, 403, 404, 409, 422, 413, 503)}


def validate_services_query(request: Request) -> None:
    invalid_names = list(request.query_params)
    if invalid_names:
        raise RequestValidationError(
            [{"type": "extra_forbidden", "loc": ("query", name)} for name in invalid_names]
        )


@router.get(
    "/services",
    response_model=ServiceList,
    responses={code: {"model": ApiError} for code in (401, 403, 422)},
)
def list_services(
    _student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _validated_query: Annotated[None, Depends(validate_services_query)],
) -> ServiceList:
    services = db.scalars(
        select(ServiceType)
        .where(ServiceType.code.in_(workflow.APPLICATION_FORMS))
        .order_by(ServiceType.code)
    ).all()
    items = []
    for service in services:
        available, reason = workflow.get_service_availability(db, service, _student)
        description, requirements = workflow.SERVICE_DETAILS[service.code]
        items.append(
            Service(
                id=str(service.id),
                code=service.code,
                title=service.title,
                description=description,
                processing_mode=service.processing_mode,
                produces_document=service.produces_document,
                action_available=available,
                unavailable_reason=reason,
                requirements=requirements,
            )
        )
    return ServiceList(items=items)


def attachment_metadata_batch(
    db: Session, application_ids: list[int]
) -> dict[int, list[AttachmentMetadata]]:
    if not application_ids:
        return {}
    rows = db.scalars(
        select(ApplicationAttachment)
        .where(
            ApplicationAttachment.application_id.in_(application_ids),
            ApplicationAttachment.is_current.is_(True),
        )
        .order_by(ApplicationAttachment.application_id, ApplicationAttachment.id)
    ).all()
    grouped: dict[int, list[AttachmentMetadata]] = {}
    for row in rows:
        grouped.setdefault(row.application_id, []).append(
            AttachmentMetadata(
                id=str(row.id),
                original_filename=row.original_filename,
                mime_type=row.mime_type,
                size_bytes=row.size_bytes,
            )
        )
    return grouped


def attachment_metadata(db: Session, application_id: int) -> list[AttachmentMetadata]:
    return attachment_metadata_batch(db, [application_id]).get(application_id, [])


def issued_document_metadata(db: Session, application_id: int) -> IssuedDocumentMetadata | None:
    row = db.execute(
        select(Application, IssuedDocument)
        .outerjoin(IssuedDocument, IssuedDocument.application_id == Application.id)
        .where(Application.id == application_id)
        .execution_options(populate_existing=True)
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
    if document is None:
        return None
    return IssuedDocumentMetadata(
        id=str(document.id), filename=document.filename, issued_at=document.issued_at
    )


def _issue_after_business_commit(application_id: int, *, actor_kind: str, actor_id: int) -> None:
    """Document availability must not change the result of a committed business action."""
    try:
        issuer.issue_document(application_id, actor_kind=actor_kind, actor_id=actor_id)
    except HTTPException as exc:
        if exc.status_code != 503 or exc.detail not in {
            "document_unavailable",
            "temporarily_unavailable",
        }:
            raise
        logger.warning("document issuance deferred for committed application %s", application_id)


def resolve_published_after_commit_error(
    root: Path,
    storage_keys: list[str],
    *,
    commit_attempted: bool,
    rollback_confirmed: bool,
) -> None:
    """Compensate only a confirmed pre-commit rollback; defer uncertain outcomes."""
    if not storage_keys or commit_attempted or not rollback_confirmed:
        return
    for storage_key in storage_keys:
        with suppress(OSError):
            storage.delete_key(root, storage_key)


async def parse_submission(request: Request, *, resubmit: bool = False):
    content_type = request.headers.get("content-type", "").lower()
    if not content_type.startswith("multipart/form-data"):
        try:
            payload = await request.json()
            parsed = TypeAdapter(
                ResubmitApplicationRequest if resubmit else CreateApplicationRequest
            )
            return parsed.validate_python(payload), []
        except ValidationError as exc:
            raise RequestValidationError(exc.errors()) from exc
        except ValueError as exc:
            raise HTTPException(422, "validation_error") from exc
    try:
        form = await request.form(max_files=5, max_fields=3, max_part_size=8192)
    except RequestTooLarge as exc:
        raise HTTPException(413, "request_too_large") from exc
    except Exception as exc:
        raise HTTPException(422, "validation_error") from exc
    expected = {"form_data", "files"} | (
        {"expected_version", "keep_attachment_ids"} if resubmit else set()
    )
    if set(form.keys()) - expected:
        raise HTTPException(422, "validation_error")
    try:
        data = json.loads(str(form.get("form_data", "")))
        if not isinstance(data, dict):
            raise ValueError
        if resubmit:
            payload = {
                "form_data": data,
                "expected_version": int(str(form.get("expected_version", ""))),
                "keep_attachment_ids": json.loads(str(form.get("keep_attachment_ids", "[]"))),
            }
            parsed = ResubmitApplicationRequest.model_validate(payload)
        else:
            parsed = TypeAdapter(CreateApplicationRequest).validate_python(
                {"service_code": "academic_leave", "form_data": data}
            )
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc
    except ValueError as exc:
        raise HTTPException(422, "validation_error") from exc
    files = [item for item in form.getlist("files") if getattr(item, "file", None) is not None]
    if len(files) != len(form.getlist("files")):
        raise HTTPException(422, "validation_error")
    return parsed, files


@router.post(
    "/applications",
    response_model=ApplicationResponse,
    status_code=201,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {
                        "oneOf": [
                            {
                                "type": "object",
                                "required": ["service_code", "form_data"],
                                "properties": {
                                    "service_code": {"const": "study_certificate"},
                                    "form_data": {
                                        "$ref": "#/components/schemas/StudyCertificateFormData"
                                    },
                                },
                            },
                            {
                                "type": "object",
                                "required": ["service_code", "form_data"],
                                "properties": {
                                    "service_code": {"const": "academic_transcript"},
                                    "form_data": {"type": "object"},
                                },
                            },
                            {
                                "type": "object",
                                "required": ["service_code", "form_data"],
                                "properties": {
                                    "service_code": {"const": "academic_leave"},
                                    "form_data": {
                                        "$ref": "#/components/schemas/AcademicLeaveFormData"
                                    },
                                },
                            },
                            {
                                "type": "object",
                                "required": ["service_code", "form_data"],
                                "properties": {
                                    "service_code": {"const": "accounting_certificate"},
                                    "form_data": {
                                        "$ref": "#/components/schemas/AccountingCertificateFormData"
                                    },
                                },
                            },
                        ]
                    }
                },
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["form_data", "files"],
                        "properties": {
                            "form_data": {
                                "type": "string",
                                "description": "JSON form_data академического отпуска",
                            },
                            "files": {
                                "type": "array",
                                "items": {"type": "string", "format": "binary"},
                            },
                        },
                    }
                },
            },
        }
    },
    responses={
        201: {"headers": {"Location": {"schema": {"type": "string"}}}},
        **WORKFLOW_ERRORS,
    },
)
async def submit_application(
    request: Request,
    response: Response,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> ApplicationResponse:
    submission, uploaded = await parse_submission(request)
    service = db.scalar(select(ServiceType).where(ServiceType.code == submission.service_code))
    if service is None:
        raise HTTPException(422, "validation_error")
    stored_form, assigned_org_unit_id = workflow.validate_and_store_form(
        db, service, submission.form_data.model_dump(), student=student
    )
    available, _reason = workflow.get_service_availability(db, service, student)
    if not available:
        raise HTTPException(409, "service_unavailable")
    if service.code == "academic_leave" and not uploaded:
        raise HTTPException(422, "attachment_required")
    if service.code != "academic_leave" and uploaded:
        raise HTTPException(422, "validation_error")
    if len(uploaded) > storage.MAX_FILES:
        raise HTTPException(422, "attachment_limit_exceeded")
    root = Path(get_settings().attachment_storage_path)
    staged = []
    try:
        for item in uploaded:
            staged.append(storage.stage_upload(item.file, item.filename or "attachment", root))
        if sum(item.size_bytes for item in staged) > storage.MAX_TOTAL_BYTES:
            raise HTTPException(422, "attachment_limit_exceeded")
    except OSError as exc:
        for item in staged:
            storage.discard(item)
        raise HTTPException(503, "temporarily_unavailable") from exc
    except Exception:
        for item in staged:
            storage.discard(item)
        raise
    application = Application(
        student_id=student.id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="not_required" if service.code == "academic_leave" else "pending",
        form_data=stored_form,
        assigned_org_unit_id=assigned_org_unit_id,
        feedback=None,
        version=1,
    )
    automatic_document = service.processing_mode == "automatic" and service.produces_document
    coordination = storage.coordination_lock(root) if staged else None
    coordination_acquired = False
    commit_attempted = False
    recovered_commit = False
    try:
        if coordination is not None:
            try:
                coordination.__enter__()
            except OSError as exc:
                raise HTTPException(503, "temporarily_unavailable") from exc
            coordination_acquired = True
        for item in staged:
            try:
                storage.publish(item, root)
            except OSError as exc:
                raise HTTPException(503, "temporarily_unavailable") from exc
        db.add(application)
        db.flush()
        for item in staged:
            db.add(
                ApplicationAttachment(
                    application_id=application.id,
                    storage_key=item.storage_key,
                    original_filename=item.filename,
                    mime_type=item.mime_type,
                    size_bytes=item.size_bytes,
                    is_current=True,
                )
            )
        db.add(
            ApplicationHistory(
                application_id=application.id,
                actor_user_id=student.user_id,
                from_status=None,
                to_status="submitted",
                comment=None,
            )
        )
        if automatic_document:
            application.review_status = "approved"
            application.version = 2
            application.updated_at = datetime.now(UTC)
            db.add(
                ApplicationHistory(
                    application_id=application.id,
                    actor_user_id=None,
                    from_status="submitted",
                    to_status="approved",
                    comment=None,
                )
            )
        description, requirements = workflow.SERVICE_DETAILS[service.code]
        payload = ApplicationResponse(
            id=str(application.id),
            service=Service(
                id=str(service.id),
                code=service.code,
                title=service.title,
                description=description,
                processing_mode=service.processing_mode,
                produces_document=service.produces_document,
                action_available=False,
                unavailable_reason=None,
                requirements=requirements,
            ),
            form_data=stored_form,
            review_status=application.review_status,
            document_status=application.document_status,
            feedback=None,
            created_at=application.created_at,
            updated_at=application.updated_at,
            version=application.version,
            attachments=[],
            document=None,
        )
        db.flush()
        payload.attachments = attachment_metadata(db, application.id)
        commit_attempted = True
        db.commit()
    except Exception as exc:
        rollback_confirmed = False
        with suppress(Exception):
            db.rollback()
            rollback_confirmed = True
        resolve_published_after_commit_error(
            root,
            [item.storage_key for item in staged],
            commit_attempted=commit_attempted,
            rollback_confirmed=rollback_confirmed,
        )
        for item in staged:
            storage.discard(item)
        if automatic_document and commit_attempted:
            try:
                with SessionLocal() as recovery_db:
                    recovered = recovery_db.execute(
                        select(Application, ServiceType)
                        .join(ServiceType)
                        .where(
                            Application.id == application.id,
                            Application.student_id == student.id,
                        )
                    ).one_or_none()
                    if recovered is not None and recovered[0].review_status == "approved":
                        payload = serialize_application(recovery_db, *recovered)
                        recovered_commit = True
            except Exception as recovery_error:
                logger.exception("could not resolve application commit result")
                raise HTTPException(503, "temporarily_unavailable") from recovery_error
            if not recovered_commit:
                raise HTTPException(503, "temporarily_unavailable") from exc
        else:
            raise
    finally:
        if coordination_acquired:
            coordination.__exit__(None, None, None)
    response.headers["Location"] = f"/api/v1/applications/{application.id}"
    if automatic_document:
        _issue_after_business_commit(
            application.id, actor_kind="owner", actor_id=student.user_id
        )
        with SessionLocal() as response_db:
            row = response_db.execute(
                select(Application, ServiceType)
                .join(ServiceType, Application.service_type_id == ServiceType.id)
                .where(
                    Application.id == application.id,
                    Application.student_id == student.id,
                )
            ).one()
            return serialize_application(response_db, *row)
    return payload


def serialize_application(
    db: Session,
    application: Application,
    service: ServiceType,
    *,
    attachments: list[AttachmentMetadata] | None = None,
    document: IssuedDocument | None | object = ...,
) -> ApplicationResponse:
    if document is ...:
        row = db.execute(
            select(Application, ServiceType, IssuedDocument)
            .join(ServiceType, Application.service_type_id == ServiceType.id)
            .outerjoin(IssuedDocument, IssuedDocument.application_id == Application.id)
            .where(Application.id == application.id)
            .execution_options(populate_existing=True)
        ).one_or_none()
        if row is None:
            raise HTTPException(404, "not_found")
        application, service, document = row
    if application.document_status == "ready" and document is None:
        logger.error("ready application %s has no issued document", application.id)
        raise HTTPException(503, "document_unavailable")
    if application.document_status != "ready" and document is not None:
        logger.error("application %s has an unready issued document", application.id)
        raise HTTPException(503, "document_unavailable")
    description, requirements = workflow.SERVICE_DETAILS.get(service.code, ("", []))
    return ApplicationResponse(
        id=str(application.id),
        service=Service(
            id=str(service.id),
            code=service.code,
            title=service.title,
            description=description,
            processing_mode=service.processing_mode,
            produces_document=service.produces_document,
            action_available=False,
            unavailable_reason=None,
            requirements=requirements,
        ),
        form_data=application.form_data,
        review_status=application.review_status,
        document_status=application.document_status,
        feedback=application.feedback,
        created_at=application.created_at,
        updated_at=application.updated_at,
        version=application.version,
        attachments=(
            attachment_metadata(db, application.id) if attachments is None else attachments
        ),
        document=(
            IssuedDocumentMetadata(
                id=str(document.id), filename=document.filename, issued_at=document.issued_at
            )
            if document is not None
            else None
        ),
    )


def validate_application_query(request: Request) -> None:
    if any(len(request.query_params.getlist(name)) != 1 for name in request.query_params):
        raise HTTPException(422, "validation_error")


@router.get(
    "/applications",
    response_model=ApplicationPage,
    responses={401: {"model": ApiError}, 403: {"model": ApiError}, 422: {"model": ApiError}},
)
def list_student_applications(
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
    _query: Annotated[None, Depends(validate_application_query)],
) -> ApplicationPage:
    statement = (
        select(Application, ServiceType, IssuedDocument)
        .join(ServiceType, Application.service_type_id == ServiceType.id)
        .outerjoin(IssuedDocument, IssuedDocument.application_id == Application.id)
        .where(Application.student_id == student.id)
    )
    return list_application_page(db, statement, pagination)


def list_application_page(
    db: Session,
    statement: Select[tuple[Application, ServiceType, IssuedDocument | None]],
    pagination: PaginationParams,
    *,
    staff: bool = False,
) -> ApplicationPage | StaffApplicationPage:
    boundary = decode_page_cursor(pagination.cursor, key_types=(str, int), direction="desc")
    if boundary is not None:
        created_at, application_id = boundary
        try:
            timestamp = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if (
                timestamp.utcoffset() is None
                or not 1 <= application_id <= 9_223_372_036_854_775_807
            ):
                raise ValueError
        except (ValueError, TypeError, OverflowError) as exc:
            raise InvalidCursorError("Invalid application cursor") from exc
        statement = statement.where(
            tuple_(Application.created_at, Application.id) < (timestamp, application_id)
        )
    rows = db.execute(
        statement.order_by(Application.created_at.desc(), Application.id.desc()).limit(
            pagination.limit + 1
        ).execution_options(populate_existing=True)
    ).all()
    page_rows = rows[: pagination.limit]
    metadata = attachment_metadata_batch(db, [application.id for application, _, _ in page_rows])
    page = paginate_results(
        [
            serialize_staff_application(
                db,
                application,
                service,
                attachments=metadata.get(application.id, []),
                document=document,
            )
            if staff
            else serialize_application(
                db,
                application,
                service,
                attachments=metadata.get(application.id, []),
                document=document,
            )
            for application, service, document in rows
        ],
        key=lambda item: (item.created_at.isoformat(), int(item.id)),
        key_types=(str, int),
        direction="desc",
        limit=pagination.limit,
    )
    page_type = StaffApplicationPage if staff else ApplicationPage
    return page_type(items=page.items, next_cursor=page.next_cursor)


@router.get(
    "/applications/{id}",
    response_model=ApplicationResponse,
    responses={
        401: {"model": ApiError},
        403: {"model": ApiError},
        404: {"model": ApiError},
        422: {"model": ApiError},
    },
)
def get_student_application(
    id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> ApplicationResponse:
    if len(id) > 19 or int(id) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    row = db.execute(
        select(Application, ServiceType, IssuedDocument)
        .join(ServiceType, Application.service_type_id == ServiceType.id)
        .outerjoin(IssuedDocument, IssuedDocument.application_id == Application.id)
        .where(Application.student_id == student.id, Application.id == int(id))
        .execution_options(populate_existing=True)
    ).one_or_none()
    if row is None:
        raise HTTPException(404, "not_found")
    return serialize_application(db, *row[:2], document=row[2])


def attachment_download(
    db: Session, attachment_id: int, *, student: Student | None = None, user: User | None = None
):
    scope_ids = None
    if user is not None:
        context = get_authorization_context(db, user)
        scope_ids = [
            int(permission.scope_org_unit_id)
            for permission in context.permissions
            if permission.permission_code == PermissionCode.APPLICATIONS_REVIEW
            and permission.scope_org_unit_id is not None
        ]
        if not scope_ids:
            raise HTTPException(404, "not_found")
    statement = (
        select(ApplicationAttachment, Application)
        .join(Application, Application.id == ApplicationAttachment.application_id)
        .where(
            ApplicationAttachment.id == attachment_id, ApplicationAttachment.is_current.is_(True)
        )
    )
    if scope_ids is not None:
        statement = statement.where(get_application_scope().in_(scope_ids))
    row = db.execute(statement).one_or_none()
    if row is None:
        raise HTTPException(404, "not_found")
    attachment, application = row
    if student is not None and application.student_id != student.id:
        raise HTTPException(404, "not_found")
    try:
        handle = storage.open_key(
            Path(get_settings().attachment_storage_path), attachment.storage_key
        )
    except OSError as exc:
        raise HTTPException(503, "temporarily_unavailable") from exc

    def chunks():
        try:
            while block := handle.read(storage.CHUNK_BYTES):
                yield block
        finally:
            handle.close()

    filename = quote(attachment.original_filename, safe="")
    return StreamingResponse(
        chunks(),
        media_type=attachment.mime_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Content-Length": str(attachment.size_bytes),
        },
    )


@router.get(
    "/applications/{id}/attachments",
    response_model=list[AttachmentMetadata],
    responses=WORKFLOW_ERRORS,
)
def list_student_attachments(
    id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application = workflow.get_owned_application(db, student, parse_application_id(id))
    return attachment_metadata(db, application.id)


@router.get(
    "/applications/attachments/{attachment_id}/download",
    responses={
        **WORKFLOW_ERRORS,
        200: {
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            }
        },
    },
)
def download_student_attachment(
    attachment_id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    return attachment_download(db, parse_application_id(attachment_id), student=student)


@router.get(
    "/staff/applications/{id}/attachments",
    response_model=list[AttachmentMetadata],
    responses=WORKFLOW_ERRORS,
)
def list_staff_attachments(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application = require_application_review(db, user, parse_application_id(id))
    return attachment_metadata(db, application.id)


@router.get(
    "/staff/applications/attachments/{attachment_id}/download",
    responses={
        **WORKFLOW_ERRORS,
        200: {
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            }
        },
    },
)
def download_staff_attachment(
    attachment_id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    return attachment_download(db, parse_application_id(attachment_id), user=user)


def parse_application_id(identifier: str) -> int:
    if len(identifier) > 19 or int(identifier) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    return int(identifier)


def serialize_staff_application(
    db: Session,
    application: Application,
    service: ServiceType,
    *,
    attachments: list[AttachmentMetadata] | None = None,
    document: IssuedDocument | None | object = ...,
) -> StaffApplicationResponse:
    return StaffApplicationResponse(
        **serialize_application(
            db, application, service, attachments=attachments, document=document
        ).model_dump(),
        student_id=str(application.student_id),
        reviewer_user_id=str(application.reviewer_user_id)
        if application.reviewer_user_id
        else None,
    )


@router.get("/staff/applications", response_model=StaffApplicationPage, responses=WORKFLOW_ERRORS)
def list_staff_applications(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
    _query: Annotated[None, Depends(validate_application_query)],
) -> StaffApplicationPage:
    context = get_authorization_context(db, user)
    scopes = [
        int(p.scope_org_unit_id)
        for p in context.permissions
        if p.permission_code == PermissionCode.APPLICATIONS_REVIEW
        and p.scope_org_unit_id is not None
    ]
    if not scopes:
        raise HTTPException(403, "forbidden")
    statement = (
        select(Application, ServiceType, IssuedDocument)
        .join(ServiceType)
        .outerjoin(IssuedDocument, IssuedDocument.application_id == Application.id)
        .where(get_application_scope().in_(scopes))
    )
    return list_application_page(db, statement, pagination, staff=True)


@router.get(
    "/staff/applications/{id}", response_model=StaffApplicationResponse, responses=WORKFLOW_ERRORS
)
def get_staff_application(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> StaffApplicationResponse:
    application = require_application_review(db, user, parse_application_id(id))
    return serialize_staff_application(
        db, application, db.get(ServiceType, application.service_type_id)
    )


@router.post(
    "/staff/applications/{id}/review",
    response_model=StaffApplicationResponse,
    responses=WORKFLOW_ERRORS,
)
def review_application(
    id: Id,
    request: ReviewApplicationRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> StaffApplicationResponse:
    application_id = parse_application_id(id)
    commit_attempted = False
    try:
        application = workflow.review_application(db, user, application_id, request)
        application_id = application.id
        should_issue = (
            request.action == "approve"
            and db.get(ServiceType, application.service_type_id).code == "accounting_certificate"
        )
        commit_attempted = True
        db.commit()
    except Exception:
        db.rollback()
        should_issue = False
        if request.action == "approve" and commit_attempted:
            try:
                with SessionLocal() as recovery_db:
                    recovered = recovery_db.get(Application, application_id)
                    approval_event = recovery_db.scalar(
                        select(ApplicationHistory.id).where(
                            ApplicationHistory.application_id == application_id,
                            ApplicationHistory.actor_user_id == user.id,
                            ApplicationHistory.from_status == "in_review",
                            ApplicationHistory.to_status == "approved",
                        )
                    )
                    if (
                        recovered is not None
                        and recovered.review_status == "approved"
                        and recovered.version == request.expected_version + 1
                        and approval_event is not None
                    ):
                        service = recovery_db.get(ServiceType, recovered.service_type_id)
                        should_issue = service.code == "accounting_certificate"
                    else:
                        raise HTTPException(503, "temporarily_unavailable")
            except HTTPException:
                raise
            except Exception as recovery_error:
                logger.exception("could not resolve application review commit result")
                raise HTTPException(503, "temporarily_unavailable") from recovery_error
        else:
            raise
    if should_issue:
        _issue_after_business_commit(application_id, actor_kind="staff", actor_id=user.id)
    with SessionLocal() as response_db:
        application = require_application_review(response_db, user, application_id)
        return serialize_staff_application(
            response_db,
            application,
            response_db.get(ServiceType, application.service_type_id),
        )


def _document_response(db: Session, application: Application, service: ServiceType):
    if application.document_status != "ready" or application.review_status != "approved":
        raise HTTPException(409, "document_not_ready")
    document = db.scalar(
        select(IssuedDocument).where(IssuedDocument.application_id == application.id)
    )
    if document is None:
        logger.error("ready application %s has no issued document", application.id)
        raise HTTPException(503, "document_unavailable")
    root = None
    handle = None
    try:
        root = issued_storage.existing_issued_root(Path(get_settings().attachment_storage_path))
        handle = issued_storage.open_key(root, document.storage_key)
        import stat

        size = os.fstat(handle.fileno()).st_size
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode) or size <= 0:
            raise OSError("stored PDF is not a regular file")
        if size > issued_storage.MAX_PDF_BYTES:
            raise OSError("stored PDF exceeds maximum size")
        content = handle.read(size + 1)
        issuer._validate_pdf(content, document.snapshot_data)
        handle.seek(0)
    except Exception as exc:
        if handle is not None:
            handle.close()
        logger.exception("issued PDF unavailable for application %s", application.id)
        raise HTTPException(503, "document_unavailable") from exc

    def chunks():
        try:
            while block := handle.read(storage.CHUNK_BYTES):
                yield block
        finally:
            handle.close()

    filename = quote(document.filename, safe="")
    return StreamingResponse(
        chunks(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{filename}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Content-Length": str(size),
        },
    )


@router.get(
    "/applications/{id}/document",
    response_class=StreamingResponse,
    responses={
        **WORKFLOW_ERRORS,
        200: {
            "description": "The immutable issued PDF.",
            "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}},
        },
    },
)
def download_student_issued_document(
    id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application = workflow.get_owned_application(db, student, parse_application_id(id))
    service = db.get(ServiceType, application.service_type_id)
    return _document_response(db, application, service)


@router.get(
    "/staff/applications/{id}/document",
    response_class=StreamingResponse,
    responses={
        **WORKFLOW_ERRORS,
        200: {
            "description": "The immutable issued PDF.",
            "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}},
        },
    },
)
def download_staff_issued_document(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application = require_application_review(db, user, parse_application_id(id))
    service = db.get(ServiceType, application.service_type_id)
    return _document_response(db, application, service)


@router.post(
    "/applications/{id}/document/retry",
    response_model=ApplicationResponse,
    responses=WORKFLOW_ERRORS,
)
def retry_student_document(
    id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application = workflow.get_owned_application(db, student, parse_application_id(id))
    issuer.issue_document(application.id, actor_kind="owner", actor_id=student.user_id)
    db.expire_all()
    row = db.execute(
        select(Application, ServiceType)
        .join(ServiceType)
        .where(Application.id == application.id, Application.student_id == student.id)
    ).one()
    return serialize_application(db, *row)


@router.post(
    "/staff/applications/{id}/document/retry",
    response_model=StaffApplicationResponse,
    responses=WORKFLOW_ERRORS,
)
def retry_staff_document(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application = require_application_review(db, user, parse_application_id(id))
    issuer.issue_document(application.id, actor_kind="staff", actor_id=user.id)
    db.expire_all()
    application = require_application_review(db, user, application.id)
    service = db.get(ServiceType, application.service_type_id)
    return serialize_staff_application(db, application, service)


@router.post(
    "/applications/{id}/document/process",
    response_model=ApplicationResponse,
    responses=WORKFLOW_ERRORS,
)
def process_legacy_automatic_document(
    id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
):
    application_id = parse_application_id(id)
    application = workflow.get_owned_application(db, student, application_id)
    service = db.get(ServiceType, application.service_type_id)
    if service.processing_mode != "automatic" or not service.produces_document:
        raise HTTPException(409, "document_not_available")
    try:
        locked = db.scalar(
            select(Application)
            .where(Application.id == application_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if locked.review_status == "submitted" and locked.document_status == "pending":
            canonical, _ = workflow.validate_and_store_form(
                db, service, locked.form_data, student=student, existing=locked.form_data
            )
            if canonical != locked.form_data:
                raise HTTPException(409, "application_data_invalid")
            previous = locked.review_status
            locked.review_status = "approved"
            locked.version += 1
            locked.updated_at = datetime.now(UTC)
            db.add(
                ApplicationHistory(
                    application_id=locked.id,
                    actor_user_id=None,
                    from_status=previous,
                    to_status="approved",
                    comment=None,
                )
            )
            db.commit()
        elif locked.review_status != "approved" or locked.document_status not in {
            "pending",
            "failed",
            "ready",
        }:
            raise HTTPException(409, "invalid_transition")
        else:
            # Release the row lock before issue_document opens its own transaction.
            db.commit()
    except Exception:
        db.rollback()
        raise
    _issue_after_business_commit(application_id, actor_kind="owner", actor_id=student.user_id)
    db.expire_all()
    row = db.execute(
        select(Application, ServiceType)
        .join(ServiceType)
        .where(Application.id == application_id, Application.student_id == student.id)
    ).one()
    return serialize_application(db, *row)


@router.post(
    "/applications/{id}/resubmit",
    response_model=ApplicationResponse,
    responses=WORKFLOW_ERRORS,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {
                        "type": "object",
                        "required": ["expected_version", "form_data"],
                        "properties": {
                            "expected_version": {"type": "integer", "minimum": 1},
                            "form_data": {
                                "oneOf": [
                                    {"$ref": "#/components/schemas/StudyCertificateFormData"},
                                    {"type": "object"},
                                    {"$ref": "#/components/schemas/AcademicLeaveFormData"},
                                    {"$ref": "#/components/schemas/AccountingCertificateFormData"},
                                ]
                            },
                            "keep_attachment_ids": {
                                "type": "array",
                                "items": {"$ref": "#/components/schemas/Id"},
                            },
                        },
                    }
                },
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["expected_version", "form_data", "keep_attachment_ids"],
                        "properties": {
                            "expected_version": {"type": "integer", "minimum": 1},
                            "form_data": {"type": "string", "description": "JSON form_data"},
                            "keep_attachment_ids": {
                                "type": "string",
                                "description": "JSON array of current attachment IDs to keep",
                            },
                            "files": {
                                "type": "array",
                                "items": {"type": "string", "format": "binary"},
                            },
                        },
                    }
                },
            },
        }
    },
)
async def resubmit_application(
    id: Id,
    request: Request,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> ApplicationResponse:
    resubmission, uploaded = await parse_submission(request, resubmit=True)
    identifier = parse_application_id(id)
    root = Path(get_settings().attachment_storage_path)
    staged = []
    try:
        for item in uploaded:
            staged.append(storage.stage_upload(item.file, item.filename or "attachment", root))
        if sum(item.size_bytes for item in staged) > storage.MAX_TOTAL_BYTES:
            raise HTTPException(422, "attachment_limit_exceeded")
    except OSError as exc:
        for item in staged:
            storage.discard(item)
        raise HTTPException(503, "temporarily_unavailable") from exc
    except Exception:
        for item in staged:
            storage.discard(item)
        raise
    removed_keys = []
    coordination = (
        storage.coordination_lock(root) if staged or resubmission.keep_attachment_ids else None
    )
    coordination_acquired = False
    commit_attempted = False
    retained_handles = []
    try:
        if coordination is not None:
            try:
                coordination.__enter__()
            except OSError as exc:
                raise HTTPException(503, "temporarily_unavailable") from exc
            coordination_acquired = True
        # The lock serializes simultaneous replacement attempts before they inspect
        # the current attachment set; the version predicate remains the final guard.
        application = db.scalar(
            select(Application)
            .where(Application.id == identifier, Application.student_id == student.id)
            .execution_options(populate_existing=True)
        )
        if application is None:
            raise HTTPException(404, "not_found")
        service = db.get(ServiceType, application.service_type_id)
        if service.code != "academic_leave" and (uploaded or resubmission.keep_attachment_ids):
            raise HTTPException(422, "validation_error")
        if service.code == "academic_leave":
            # Concurrent leave resubmissions serialize while they replace the
            # current attachment set. Other service workflows keep their
            # existing optimistic access-race behavior.
            application = db.scalar(
                select(Application)
                .where(Application.id == identifier, Application.student_id == student.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if application is None:
                raise HTTPException(404, "not_found")
            service = db.get(ServiceType, application.service_type_id)
        current = db.scalars(
            select(ApplicationAttachment)
            .where(
                ApplicationAttachment.application_id == application.id,
                ApplicationAttachment.is_current.is_(True),
            )
            .with_for_update()
        ).all()
        current_by_id = {str(item.id): item for item in current}
        keep_ids = resubmission.keep_attachment_ids
        if len(keep_ids) != len(set(keep_ids)) or any(
            item not in current_by_id for item in keep_ids
        ):
            raise HTTPException(409, "version_conflict")
        retained = [current_by_id[item] for item in keep_ids]
        if service.code == "academic_leave":
            for attachment in retained:
                handle = None
                try:
                    handle = storage.open_key(root, attachment.storage_key)
                    readable_size = 0
                    while chunk := handle.read(storage.CHUNK_BYTES):
                        readable_size += len(chunk)
                    if not readable_size:
                        raise OSError("stored attachment is empty")
                except OSError as exc:
                    if handle is not None:
                        with suppress(OSError):
                            handle.close()
                    raise HTTPException(503, "temporarily_unavailable") from exc
                retained_handles.append(handle)
        if service.code == "academic_leave" and not (retained or staged):
            raise HTTPException(422, "attachment_required")
        if len(retained) + len(staged) > storage.MAX_FILES:
            raise HTTPException(422, "attachment_limit_exceeded")
        if (
            sum(item.size_bytes for item in retained) + sum(item.size_bytes for item in staged)
            > storage.MAX_TOTAL_BYTES
        ):
            raise HTTPException(422, "attachment_limit_exceeded")
        stored_form, _unit_id = workflow.validate_and_store_form(
            db,
            service,
            resubmission.form_data.model_dump(),
            student=student,
            existing=application.form_data,
        )
        changed = workflow.update_application(
            db,
            application,
            expected_version=resubmission.expected_version,
            actor_user_id=student.user_id,
            access_predicate=Application.student_id == student.id,
            from_statuses={"needs_correction"},
            to_status="resubmitted",
            form_data=stored_form,
        )
        keep_set = set(keep_ids)
        for old in current:
            if str(old.id) not in keep_set:
                old.is_current = False
                removed_keys.append(old.storage_key)
        for item in staged:
            try:
                storage.publish(item, root)
            except OSError as exc:
                raise HTTPException(503, "temporarily_unavailable") from exc
            db.add(
                ApplicationAttachment(
                    application_id=application.id,
                    storage_key=item.storage_key,
                    original_filename=item.filename,
                    mime_type=item.mime_type,
                    size_bytes=item.size_bytes,
                    is_current=True,
                )
            )
        db.flush()
        payload = serialize_application(db, changed, service)
        commit_attempted = True
        db.commit()
        for key in removed_keys:
            with suppress(OSError):
                storage.delete_key(root, key)
        return payload
    except Exception:
        rollback_confirmed = False
        with suppress(Exception):
            db.rollback()
            rollback_confirmed = True
        resolve_published_after_commit_error(
            root,
            [item.storage_key for item in staged],
            commit_attempted=commit_attempted,
            rollback_confirmed=rollback_confirmed,
        )
        for item in staged:
            storage.discard(item)
        raise
    finally:
        for handle in retained_handles:
            with suppress(OSError):
                handle.close()
        if coordination_acquired:
            coordination.__exit__(None, None, None)


def list_application_history(
    db: Session, application: Application, pagination: PaginationParams
) -> ApplicationHistoryPage:
    boundary = decode_page_cursor(pagination.cursor, key_types=(str, int), direction="asc")
    statement = select(ApplicationHistory).where(
        ApplicationHistory.application_id == application.id
    )
    if boundary is not None:
        try:
            timestamp = datetime.fromisoformat(boundary[0].replace("Z", "+00:00"))
            if timestamp.utcoffset() is None or not 1 <= boundary[1] <= 9_223_372_036_854_775_807:
                raise ValueError
        except (ValueError, TypeError, OverflowError) as exc:
            raise InvalidCursorError("Invalid history cursor") from exc
        statement = statement.where(
            tuple_(ApplicationHistory.created_at, ApplicationHistory.id) > (timestamp, boundary[1])
        )
    rows = db.scalars(
        statement.order_by(ApplicationHistory.created_at, ApplicationHistory.id).limit(
            pagination.limit + 1
        )
    ).all()
    page = paginate_results(
        [
            ApplicationHistoryEvent(
                id=str(row.id),
                actor_user_id=str(row.actor_user_id) if row.actor_user_id else None,
                from_status=row.from_status,
                to_status=row.to_status,
                comment=row.comment,
                created_at=row.created_at,
            )
            for row in rows
        ],
        key=lambda item: (item.created_at.isoformat(), int(item.id)),
        key_types=(str, int),
        direction="asc",
        limit=pagination.limit,
    )
    return ApplicationHistoryPage(items=page.items, next_cursor=page.next_cursor)


@router.get(
    "/applications/{id}/history", response_model=ApplicationHistoryPage, responses=WORKFLOW_ERRORS
)
def list_student_application_history(
    id: Id,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
    _query: Annotated[None, Depends(validate_application_query)],
) -> ApplicationHistoryPage:
    application = workflow.get_owned_application(db, student, parse_application_id(id))
    return list_application_history(db, application, pagination)


@router.get(
    "/staff/applications/{id}/history",
    response_model=ApplicationHistoryPage,
    responses=WORKFLOW_ERRORS,
)
def list_staff_application_history(
    id: Id,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    pagination: Annotated[PaginationParams, Query()],
    _query: Annotated[None, Depends(validate_application_query)],
) -> ApplicationHistoryPage:
    application = require_application_review(db, user, parse_application_id(id))
    return list_application_history(db, application, pagination)
