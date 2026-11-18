from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.academics.schemas import AcademicsResponse
from app.academics.service import get_student_academics
from app.core.schemas import ApiError, Page, PaginationParams
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import CourseGroup, Student
from app.teaching.announcements import Announcement, list_announcements, require_unique_query_params
from app.teaching.validation import TeachingId, validate_teaching_ids

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


@router.get(
    "/academics/courses/{course_offering_id}/announcements",
    response_model=Page[Announcement],
    dependencies=[Depends(validate_teaching_ids), Depends(require_unique_query_params)],
    responses={
        **{code: {"model": ApiError} for code in (401, 403, 404, 422, 500)},
        200: {"headers": {"X-Announcement-Group-Id": {"schema": {"type": "string"}}}},
    },
)
def get_student_announcements(
    course_offering_id: TeachingId,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
    params: Annotated[PaginationParams, Query()],
    response: Response,
):
    course_id = int(course_offering_id)
    if not db.scalar(
        select(CourseGroup.group_id).where(
            CourseGroup.course_offering_id == course_id, CourseGroup.group_id == student.group_id
        )
    ):
        raise HTTPException(404, "not_found")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Announcement-Group-Id"] = str(student.group_id)
    return list_announcements(db, course_id, student.group_id, params, scope=-student.id)
