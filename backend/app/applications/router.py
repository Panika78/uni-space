from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from sqlalchemy import Select, select, tuple_
from sqlalchemy.orm import Session

# Shared RBAC contract from #60; no client-supplied organizational scope.
from app.applications import service as workflow
from app.applications.schemas import (
    ApplicationHistoryEvent,
    ApplicationHistoryPage,
    ApplicationPage,
    ApplicationResponse,
    CreateApplicationRequest,
    ResubmitApplicationRequest,
    ReviewApplicationRequest,
    Service,
    ServiceList,
    StaffApplicationPage,
    StaffApplicationResponse,
)
from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import ApiError, Id, PaginationParams, RequestModel
from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.models import Application, ApplicationHistory, ServiceType, Student, User
from app.permissions import (
    PermissionCode,
    get_application_scope,
    get_authorization_context,
    require_application_review,
)

router = APIRouter(prefix="/api/v1", tags=["services", "applications"])


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


@router.post(
    "/applications",
    response_model=ApplicationResponse,
    status_code=201,
    responses={
        201: {"headers": {"Location": {"schema": {"type": "string"}}}},
        401: {"model": ApiError},
        403: {"model": ApiError},
        422: {"model": ApiError},
    },
)
def submit_application(
    request: CreateApplicationRequest,
    response: Response,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> ApplicationResponse:
    service = db.scalar(select(ServiceType).where(ServiceType.code == request.service_code))
    if service is None:
        raise HTTPException(422, "validation_error")
    stored_form, assigned_org_unit_id = workflow.validate_and_store_form(
        db, service, request.form_data.model_dump(), student=student
    )
    available, _reason = workflow.get_service_availability(db, service)
    if not available:
        raise HTTPException(409, "service_unavailable")
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
    try:
        db.add(application)
        db.flush()
        db.add(
            ApplicationHistory(
                application_id=application.id,
                actor_user_id=student.user_id,
                from_status=None,
                to_status="submitted",
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
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    response.headers["Location"] = f"/api/v1/applications/{application.id}"
    return payload


def serialize_application(application: Application, service: ServiceType) -> ApplicationResponse:
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
        select(Application, ServiceType)
        .join(ServiceType, Application.service_type_id == ServiceType.id)
        .where(Application.student_id == student.id)
    )
    return list_application_page(db, statement, pagination)


def list_application_page(
    db: Session,
    statement: Select[tuple[Application, ServiceType]],
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
        )
    ).all()
    page = paginate_results(
        [
            serialize_staff_application(application, service)
            if staff
            else serialize_application(application, service)
            for application, service in rows
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
        select(Application, ServiceType)
        .join(ServiceType, Application.service_type_id == ServiceType.id)
        .where(Application.student_id == student.id, Application.id == int(id))
    ).one_or_none()
    if row is None:
        raise HTTPException(404, "not_found")
    return serialize_application(*row)


WORKFLOW_ERRORS = {code: {"model": ApiError} for code in (401, 403, 404, 409, 422)}


def parse_application_id(identifier: str) -> int:
    if len(identifier) > 19 or int(identifier) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    return int(identifier)


def serialize_staff_application(
    application: Application, service: ServiceType
) -> StaffApplicationResponse:
    return StaffApplicationResponse(
        **serialize_application(application, service).model_dump(),
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
        select(Application, ServiceType)
        .join(ServiceType)
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
        application, db.get(ServiceType, application.service_type_id)
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
    try:
        application = workflow.review_application(db, user, parse_application_id(id), request)
        payload = serialize_staff_application(
            application, db.get(ServiceType, application.service_type_id)
        )
        db.commit()
        return payload
    except Exception:
        db.rollback()
        raise


@router.post(
    "/applications/{id}/resubmit", response_model=ApplicationResponse, responses=WORKFLOW_ERRORS
)
def resubmit_application(
    id: Id,
    request: ResubmitApplicationRequest,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> ApplicationResponse:
    try:
        application = workflow.resubmit_application(
            db,
            student,
            parse_application_id(id),
            expected_version=request.expected_version,
            form_data=request.form_data.model_dump(),
        )
        payload = serialize_application(
            application, db.get(ServiceType, application.service_type_id)
        )
        db.commit()
        return payload
    except Exception:
        db.rollback()
        raise


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
