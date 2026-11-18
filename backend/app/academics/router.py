from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.academics.courses import (
    get_student_course,
    list_student_course_assessments,
    list_student_course_lessons,
    require_student_course,
)
from app.academics.schemas import (
    AcademicsResponse,
    StudentCourse,
    StudentCourseAssessment,
    StudentCourseLesson,
)
from app.academics.service import get_student_academics
from app.core.schemas import ApiError, Page, PaginationParams
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import CourseGroup, Student
from app.student_read_scope import STUDENT_SCOPE_HEADERS, set_student_scope
from app.teaching.announcements import Announcement, list_announcements, require_unique_query_params
from app.teaching.validation import TeachingId, validate_teaching_ids

router = APIRouter(prefix="/api/v1", tags=["academics"])


@router.get(
    "/academics",
    response_model=AcademicsResponse,
    responses={
        **{code: {"model": ApiError} for code in (401, 403, 422, 500)},
        200: {"headers": STUDENT_SCOPE_HEADERS},
    },
)
def get_academics(
    request: Request,
    response: Response,
    student: Annotated[Student, Depends(get_current_student)],
    db: Annotated[Session, Depends(get_db_session)],
) -> AcademicsResponse:
    if request.query_params:
        raise HTTPException(422, "validation_error")
    result = get_student_academics(db, student)
    set_student_scope(db, response, student)
    return result


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


course_router = APIRouter(
    prefix="/academics/courses/{course_offering_id}",
    dependencies=[Depends(validate_teaching_ids), Depends(require_unique_query_params)],
    responses={
        **{code: {"model": ApiError} for code in (401, 403, 404, 422, 500)},
        200: {
            "headers": {
                **STUDENT_SCOPE_HEADERS,
                "X-Academic-Term-Id": {"schema": {"type": "string"}},
            }
        },
    },
)
Db = Annotated[Session, Depends(get_db_session)]
CurrentStudent = Annotated[Student, Depends(get_current_student)]
PageParams = Annotated[PaginationParams, Query()]


def set_course_scope(db, response, student, term):
    set_student_scope(db, response, student)
    response.headers["X-Academic-Term-Id"] = str(term.id)


@course_router.get("", response_model=StudentCourse)
def read_student_course(
    course_offering_id: TeachingId,
    request: Request,
    response: Response,
    student: CurrentStudent,
    db: Db,
):
    if request.query_params:
        raise HTTPException(422, "validation_error")
    course_id = int(course_offering_id)
    term = require_student_course(db, student, course_id)
    result = get_student_course(db, student, course_id, term)
    set_course_scope(db, response, student, term)
    return result


@course_router.get("/lessons", response_model=Page[StudentCourseLesson])
def read_student_course_lessons(
    course_offering_id: TeachingId,
    params: PageParams,
    response: Response,
    student: CurrentStudent,
    db: Db,
):
    course_id = int(course_offering_id)
    term = require_student_course(db, student, course_id)
    result = list_student_course_lessons(db, student, course_id, term, params)
    set_course_scope(db, response, student, term)
    return result


@course_router.get("/assessments", response_model=Page[StudentCourseAssessment])
def read_student_course_assessments(
    course_offering_id: TeachingId,
    params: PageParams,
    response: Response,
    student: CurrentStudent,
    db: Db,
):
    course_id = int(course_offering_id)
    term = require_student_course(db, student, course_id)
    result = list_student_course_assessments(db, student, course_id, term, params)
    set_course_scope(db, response, student, term)
    return result


router.include_router(course_router)
