from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.schemas import ApiError
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import Teacher, User
from app.schedule.teacher_schemas import TeacherScheduleParams, TeacherScheduleResponse
from app.schedule.teacher_service import list_teacher_schedule

router = APIRouter(prefix="/api/v1/teaching", tags=["teaching"])


def get_current_teacher_id(
    db: Annotated[Session, Depends(get_db_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> int:
    if user.role != "teacher":
        raise HTTPException(403, "forbidden")
    teacher_id = db.scalar(select(Teacher.id).where(Teacher.user_id == user.id))
    if teacher_id is None:
        raise HTTPException(403, "forbidden")
    return teacher_id


@router.get(
    "/schedule",
    response_model=TeacherScheduleResponse,
    responses={code: {"model": ApiError} for code in (401, 403, 422, 500)},
)
def get_teacher_schedule(
    params: Annotated[TeacherScheduleParams, Query()],
    teacher_id: Annotated[int, Depends(get_current_teacher_id)],
    db: Annotated[Session, Depends(get_db_session)],
) -> TeacherScheduleResponse:
    return list_teacher_schedule(db, teacher_id, params)
