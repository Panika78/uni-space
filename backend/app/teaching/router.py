from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.schemas import ApiError, Page
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import User
from app.teaching import service
from app.teaching.schemas import (
    AssessmentParams,
    AssignmentParams,
    JournalAssessment,
    JournalLesson,
    JournalResult,
    JournalStudent,
    LessonParams,
    ScoreWriteRequest,
    ScoreWriteResponse,
    StudentParams,
    TeachingAssignmentResponse,
)
from app.teaching.validation import TeachingId, validate_teaching_ids

router = APIRouter(
    prefix="/api/v1/teaching",
    tags=["teaching"],
    dependencies=[Depends(validate_teaching_ids)],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 422, 500, 503)},
)
Db = Annotated[Session, Depends(get_db_session)]


def get_current_teacher(db: Db, user: Annotated[User, Depends(get_current_user)]) -> int:
    return service.require_current_teacher(db, user)


TeacherId = Annotated[int, Depends(get_current_teacher)]


def require_journal_scope(
    course_offering_id: TeachingId, group_id: TeachingId, db: Db, teacher: TeacherId
):
    service.require_teaching_assignment(db, teacher, int(course_offering_id), int(group_id))
    return int(course_offering_id), int(group_id)


Scope = Annotated[tuple[int, int], Depends(require_journal_scope)]
JOURNAL = "/courses/{course_offering_id}/groups/{group_id}"


@router.get("/assignments", response_model=Page[TeachingAssignmentResponse])
def list_teaching_assignments(
    db: Db, teacher: TeacherId, params: Annotated[AssignmentParams, Query()]
):
    return service.list_teaching_assignments(db, teacher, params)


@router.get(JOURNAL + "/students", response_model=Page[JournalStudent])
def list_journal_students(db: Db, scope: Scope, params: Annotated[StudentParams, Query()]):
    return service.list_journal_students(db, scope[1], params)


@router.get(JOURNAL + "/assessments", response_model=Page[JournalAssessment])
def list_journal_assessments(db: Db, scope: Scope, params: Annotated[AssessmentParams, Query()]):
    return service.list_journal_assessments(db, *scope, params)


@router.get(
    JOURNAL + "/assessments/{assessment_group_id}/results", response_model=Page[JournalResult]
)
def list_journal_results(
    assessment_group_id: TeachingId, db: Db, scope: Scope, params: Annotated[StudentParams, Query()]
):
    return service.list_journal_results(db, *scope, int(assessment_group_id), params)


@router.put(
    JOURNAL + "/assessments/{assessment_group_id}/results/{student_id}",
    response_model=ScoreWriteResponse,
)
def write_journal_result(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    assessment_group_id: TeachingId,
    student_id: TeachingId,
    body: ScoreWriteRequest,
    db: Db,
    user: Annotated[User, Depends(get_current_user)],
):
    return service.write_assessment_score(
        db,
        user,
        int(course_offering_id),
        int(group_id),
        int(assessment_group_id),
        int(student_id),
        body.score,
    )


@router.get(JOURNAL + "/lessons", response_model=Page[JournalLesson])
def list_journal_lessons(db: Db, scope: Scope, params: Annotated[LessonParams, Query()]):
    return service.list_journal_lessons(db, *scope, params)


@router.get(JOURNAL + "/lessons/{lesson_id}/students", response_model=Page[JournalStudent])
def list_lesson_students(
    lesson_id: TeachingId, db: Db, scope: Scope, params: Annotated[StudentParams, Query()]
):
    service.require_journal_lesson(db, *scope, int(lesson_id))
    return service.list_journal_students(db, scope[1], params, int(lesson_id))
