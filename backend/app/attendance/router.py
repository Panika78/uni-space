from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.attendance import service
from app.attendance.schemas import AttendanceInput, AttendanceParams, AttendanceResponse
from app.core.schemas import ApiError, Page
from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.models import Student, User
from app.teaching.validation import TeachingId, validate_teaching_ids

router = APIRouter(
    prefix="/api/v1/attendance",
    tags=["attendance"],
    dependencies=[Depends(validate_teaching_ids)],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 409, 422, 500)},
)
Db = Annotated[Session, Depends(get_db_session)]
CurrentStudent = Annotated[Student, Depends(get_current_student)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=Page[AttendanceResponse])
def list_student_attendance(
    db: Db, student: CurrentStudent, params: Annotated[AttendanceParams, Query()]
):
    return service.list_student_attendance(db, student, params)


@router.get("/lessons/{lesson_id}", response_model=AttendanceResponse)
def get_student_attendance(lesson_id: TeachingId, db: Db, student: CurrentStudent):
    return service.get_student_attendance(db, student, int(lesson_id))


@router.put("/lessons/{lesson_id}/students/{student_id}", response_model=AttendanceResponse)
def update_attendance(
    lesson_id: TeachingId,
    student_id: TeachingId,
    payload: AttendanceInput,
    db: Db,
    user: CurrentUser,
):
    return service.update_attendance(db, user, int(lesson_id), int(student_id), payload.status)


@router.delete("/lessons/{lesson_id}/students/{student_id}", response_model=AttendanceResponse)
def delete_attendance(lesson_id: TeachingId, student_id: TeachingId, db: Db, user: CurrentUser):
    return service.update_attendance(db, user, int(lesson_id), int(student_id), None)
