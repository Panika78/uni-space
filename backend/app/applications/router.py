from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.applications.schemas import (
    ApplicationPage,
    ApplicationResponse,
    CreateApplicationRequest,
    Service,
    ServiceList,
)
from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import ApiError, Id, PaginationParams, RequestModel
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Application, ServiceType, Student

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
        .where(ServiceType.code == "study_certificate")
        .order_by(ServiceType.code)
    ).all()
    return ServiceList(items=[Service(id=str(s.id), code=s.code, title=s.title) for s in services])


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
    application = Application(
        student_id=student.id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="pending",
        form_data=request.form_data.model_dump(),
        feedback=None,
        version=1,
    )
    try:
        db.add(application)
        db.flush()
        payload = ApplicationResponse(
            id=str(application.id),
            service=Service(id=str(service.id), code=service.code, title=service.title),
            form_data=request.form_data,
            review_status=application.review_status,
            document_status=application.document_status,
            feedback=None,
            created_at=application.created_at,
            updated_at=application.updated_at,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    response.headers["Location"] = f"/api/v1/applications/{application.id}"
    return payload


def serialize_application(application: Application, service: ServiceType) -> ApplicationResponse:
    return ApplicationResponse(
        id=str(application.id),
        service=Service(id=str(service.id), code=service.code, title=service.title),
        form_data=application.form_data,
        review_status=application.review_status,
        document_status=application.document_status,
        feedback=application.feedback,
        created_at=application.created_at,
        updated_at=application.updated_at,
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
    boundary = decode_page_cursor(pagination.cursor, key_types=(str, int), direction="desc")
    statement = (
        select(Application, ServiceType)
        .join(ServiceType, Application.service_type_id == ServiceType.id)
        .where(Application.student_id == student.id)
    )
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
        [serialize_application(application, service) for application, service in rows],
        key=lambda item: (item.created_at.isoformat(), int(item.id)),
        key_types=(str, int),
        direction="desc",
        limit=pagination.limit,
    )
    return ApplicationPage(items=page.items, next_cursor=page.next_cursor)


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
