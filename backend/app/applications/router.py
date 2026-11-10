from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.applications.schemas import (
    ApplicationResponse,
    CreateApplicationRequest,
    Service,
    ServiceList,
)
from app.core.schemas import ApiError
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Application, ServiceType, Student

router = APIRouter(prefix="/api/v1", tags=["services", "applications"])


@router.get(
    "/services",
    response_model=ServiceList,
    responses={401: {"model": ApiError}, 403: {"model": ApiError}},
)
def list_services(
    _student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> ServiceList:
    services = db.scalars(select(ServiceType).order_by(ServiceType.code)).all()
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
