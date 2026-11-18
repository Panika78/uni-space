from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.core.schemas import ApiError, Page, PaginationParams
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import User
from app.teaching import dates, service
from app.teaching.announcements import (
    Announcement,
    TeacherAnnouncementCreate,
    can_publish_to_all,
    create_announcement,
    list_announcements,
    require_unique_announcement_fields,
    require_unique_query_params,
)
from app.teaching.schemas import (
    AssessmentDatesRequest,
    AssessmentDatesResponse,
    AssessmentParams,
    AssignmentParams,
    JournalAssessment,
    JournalAttendanceParams,
    JournalAttendanceRow,
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


@router.get(
    JOURNAL + "/lessons/{lesson_id}/attendance",
    response_model=Page[JournalAttendanceRow],
)
def list_lesson_attendance(
    lesson_id: TeachingId,
    db: Db,
    scope: Scope,
    params: Annotated[JournalAttendanceParams, Query()],
    request: Request,
    response: Response,
):
    names = [name for name, _ in request.query_params.multi_items()]
    if len(names) != len(set(names)):
        raise HTTPException(422, "validation_error")
    service.require_journal_lesson(db, *scope, int(lesson_id))
    response.headers["Cache-Control"] = "no-store"
    return service.list_journal_attendance(db, *scope, int(lesson_id), params)


@router.patch(
    "/courses/{course_offering_id}/assessments/{assessment_id}/dates",
    response_model=AssessmentDatesResponse,
    responses={409: {"model": ApiError}},
)
def update_assessment_dates(
    course_offering_id: TeachingId,
    assessment_id: TeachingId,
    request: AssessmentDatesRequest,
    db: Db,
    user: Annotated[User, Depends(get_current_user)],
):
    try:
        payload = AssessmentDatesResponse.model_validate(
            dates.update_assessment_dates(
                db, user, int(course_offering_id), int(assessment_id), request
            )
        )
        db.commit()
        return payload
    except DBAPIError as exc:
        db.rollback()
        if getattr(exc.orig, "sqlstate", None) in {"55P03", "40001", "40P01"}:
            raise HTTPException(409, "version_conflict") from exc
        raise
    except Exception:
        db.rollback()
        raise


@router.post(
    "/courses/{course_offering_id}/announcements",
    response_model=Announcement,
    status_code=201,
    dependencies=[Depends(require_unique_announcement_fields)],
    responses={409: {"model": ApiError}},
)
def publish_teacher_announcement(
    course_offering_id: TeachingId,
    body: TeacherAnnouncementCreate,
    request: Request,
    db: Db,
    teacher: TeacherId,
    user: Annotated[User, Depends(get_current_user)],
    publication_key: Annotated[UUID | None, Header(alias="Idempotency-Key")] = None,
):
    if request.query_params or len(request.headers.getlist("Idempotency-Key")) > 1:
        raise HTTPException(422, "validation_error")
    return create_announcement(db, user, teacher, int(course_offering_id), body, publication_key)


@router.get(
    JOURNAL + "/announcements",
    response_model=Page[Announcement],
    dependencies=[Depends(require_unique_query_params)],
    responses={
        200: {
            "headers": {
                "X-Can-Publish-To-All-Groups": {"schema": {"type": "boolean"}},
                "X-Announcement-Teacher-Id": {"schema": {"type": "string"}},
            }
        }
    },
)
def get_teacher_announcements(
    db: Db,
    teacher: TeacherId,
    scope: Scope,
    params: Annotated[PaginationParams, Query()],
    response: Response,
):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Can-Publish-To-All-Groups"] = str(
        db.scalar(select(can_publish_to_all(scope[0], teacher)))
    ).lower()
    response.headers["X-Announcement-Teacher-Id"] = str(teacher)
    return list_announcements(db, *scope, params, scope=teacher)
