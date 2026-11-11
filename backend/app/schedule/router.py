from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.schemas import ApiError
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Student
from app.schedule.schemas import ScheduleParams, ScheduleResponse
from app.schedule.service import list_student_schedule

router = APIRouter(prefix="/api/v1", tags=["schedule"])


@router.get(
    "/schedule",
    response_model=ScheduleResponse,
    responses={code: {"model": ApiError} for code in (401, 403, 422)},
)
def get_student_schedule(
    params: Annotated[ScheduleParams, Query()],
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> ScheduleResponse:
    return list_student_schedule(db, student.group_id, params)
