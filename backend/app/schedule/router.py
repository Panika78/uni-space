from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.schemas import ApiError
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Student
from app.schedule.schemas import ScheduleParams, ScheduleResponse
from app.schedule.service import list_student_schedule
from app.student_read_scope import STUDENT_SCOPE_HEADERS, set_student_scope

router = APIRouter(prefix="/api/v1", tags=["schedule"])


@router.get(
    "/schedule",
    response_model=ScheduleResponse,
    responses={
        **{code: {"model": ApiError} for code in (401, 403, 422, 500)},
        200: {"headers": STUDENT_SCOPE_HEADERS},
    },
)
def get_student_schedule(
    response: Response,
    params: Annotated[ScheduleParams, Query()],
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> ScheduleResponse:
    result = list_student_schedule(
        db, student.group_id, params, student.subgroup_id, student_id=student.id
    )
    set_student_scope(db, response, student)
    return result
