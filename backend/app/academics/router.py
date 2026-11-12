from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.academics.schemas import AcademicsResponse
from app.academics.service import get_student_academics
from app.core.schemas import ApiError
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Student

router = APIRouter(prefix="/api/v1", tags=["academics"])


@router.get(
    "/academics",
    response_model=AcademicsResponse,
    responses={code: {"model": ApiError} for code in (401, 403, 422, 500)},
)
def get_academics(
    request: Request,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> AcademicsResponse:
    if request.query_params:
        raise HTTPException(422, "validation_error")
    return get_student_academics(db, student)
