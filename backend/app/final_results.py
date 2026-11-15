"""Manual results, with a durable domain change record in the shared audit."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field, StrictBool, StrictInt, field_validator
from sqlalchemy import and_, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.audit import validate_retake_location, write_audit_event
from app.core.schemas import ApiError, Date, Id, Page, RequestModel
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import CourseGroup, CourseOffering, FinalResult, Student, User
from app.permissions import PermissionCode, get_authorization_context, require_staff_permission
from app.teaching.ordering import STUDENT_KEY_PREFIX, get_student_name_key
from app.teaching.router import JOURNAL, Scope
from app.teaching.schemas import StudentParams
from app.teaching.service import list_page, require_current_teacher, require_teaching_assignment
from app.teaching.validation import TeachingId, validate_teaching_ids

FIELDS = ("grade_value", "passed", "retake_date", "retake_location")
SNAPSHOT_FIELDS = ("course_offering_id", "student_id", *FIELDS)


class FinalResultPatch(RequestModel):
    grade_value: Annotated[StrictInt, Field(ge=2, le=5)] | None = None
    passed: StrictBool | None = None
    retake_date: Date | None = None
    retake_location: Annotated[str, Field(strict=True, min_length=1, max_length=200)] | None = None

    @field_validator("retake_location")
    @classmethod
    def validate_location(cls, value):
        return None if value is None else validate_retake_location(value)


class ManualFinalResultResponse(RequestModel):
    result_id: Id | None
    course_offering_id: Id
    student_id: Id
    grade_value: int | None
    passed: bool | None
    retake_date: Date | None
    retake_location: str | None
    has_debt: bool


def serialize_result(course_id, student_id, result):
    values = {name: getattr(result, name) if result else None for name in FIELDS}
    return ManualFinalResultResponse(
        result_id=str(result.id) if result else None,
        course_offering_id=str(course_id),
        student_id=str(student_id),
        **values,
        has_debt=values["grade_value"] == 2 or values["passed"] is False,
    )


def require_result_scope(db, user, course_id, student_id):
    context = get_authorization_context(db, user)
    if context.role == "teacher":
        teacher = require_current_teacher(db, user)
    else:
        require_staff_permission(db, user, PermissionCode.GRADES_EDIT)
        teacher = None
    student = db.get(Student, student_id, populate_existing=True)
    course = db.get(CourseOffering, course_id, populate_existing=True)
    if student is None or course is None:
        raise HTTPException(404, "not_found")
    result = db.scalar(
        select(FinalResult)
        .where(FinalResult.course_offering_id == course_id, FinalResult.student_id == student_id)
        .execution_options(populate_existing=True)
    )
    member = (
        db.scalar(
            select(CourseGroup.course_offering_id).where(
                CourseGroup.course_offering_id == course_id,
                CourseGroup.group_id == student.group_id,
            )
        )
        is not None
    )
    if teacher is not None:
        require_teaching_assignment(db, teacher, course_id, student.group_id)
        if not member:
            raise HTTPException(404, "not_found")
    elif result is None and not member:
        raise HTTPException(404, "not_found")
    return course, result


def update_final_result(db, user, course_id, student_id, patch, *, delete=False):
    for attempt in range(3):
        try:
            return _update_final_result(db, user, course_id, student_id, patch, delete=delete)
        except DBAPIError as exc:
            # The entire transaction (including scope and audit) has rolled back.
            code = getattr(exc.orig, "sqlstate", None)
            if code in {"23505", "40001", "40P01", "55P03", "57014"}:
                if attempt < 2:
                    continue
                raise HTTPException(409, "concurrent_change") from exc
            if code in {"23514", "23503"}:
                raise HTTPException(422, "validation_error") from exc
            raise


def _update_final_result(db, user, course_id, student_id, patch, *, delete=False):
    try:
        # Reject inaccessible pairs before waiting on another writer's lock;
        # resolve again after waiting so transfers/revocations cannot use stale scope.
        require_result_scope(db, user, course_id, student_id)
        # Pair lock covers absent rows as well as concurrent update/delete.
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"final_result:{course_id}:{student_id}"},
        )
        course, result = require_result_scope(db, user, course_id, student_id)
        before = {name: getattr(result, name) for name in SNAPSHOT_FIELDS} if result else None
        values = {name: getattr(result, name) if result else None for name in FIELDS}
        values.update(patch.model_dump(exclude_unset=True))
        if delete:
            values = dict.fromkeys(FIELDS)
        if (course.attestation_type == "pass_fail" and values["grade_value"] is not None) or (
            course.attestation_type != "pass_fail" and values["passed"] is not None
        ):
            raise HTTPException(422, "validation_error")
        if (values["grade_value"] is not None and values["grade_value"] >= 3) or values[
            "passed"
        ] is True:
            values.update(retake_date=None, retake_location=None)
        after = dict(course_offering_id=course_id, student_id=student_id, **values)
        if not any(value is not None for value in values.values()):
            after = None
        if before != after:
            if after is None:
                action = "delete"
                db.delete(result)
            elif result is None:
                action = "create"
                result = FinalResult(**after)
                db.add(result)
            else:
                action = "update"
                for name, value in values.items():
                    setattr(result, name, value)
            db.flush()
            # #86 can consume committed audit event IDs; rollback publishes nothing.
            write_audit_event(
                db,
                actor=user,
                entity_type="final_result",
                entity_id=result.id,
                action=action,
                before_data=before,
                after_data=after,
            )
        response = serialize_result(course_id, student_id, result if after else None)
        db.commit()
        return response
    except Exception:
        db.rollback()
        raise


def require_no_query(request: Request) -> None:
    if request.query_params:
        raise HTTPException(422, "validation_error")


router = APIRouter(
    prefix="/api/v1/final-results",
    tags=["final-results"],
    dependencies=[Depends(validate_teaching_ids), Depends(require_no_query)],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 409, 422, 500)},
)
Db = Annotated[Session, Depends(get_db_session)]
Actor = Annotated[User, Depends(get_current_user)]
PATH = "/courses/{course_offering_id}/students/{student_id}"


@router.get(PATH, response_model=ManualFinalResultResponse)
def get_final_result(course_offering_id: TeachingId, student_id: TeachingId, db: Db, user: Actor):
    _, result = require_result_scope(db, user, int(course_offering_id), int(student_id))
    return serialize_result(course_offering_id, student_id, result)


@router.post(
    PATH,
    response_model=ManualFinalResultResponse,
    description=(
        "Save supplied fields. Omitted fields remain unchanged. Repeated values are a no-op."
    ),
)
@router.patch(
    PATH,
    response_model=ManualFinalResultResponse,
    description=(
        "Omitted fields remain unchanged; null clears a field. "
        "Clearing the grade preserves retake details. Empty rows are deleted. "
        "Positive results clear both retake fields."
    ),
)
def save_final_result(
    course_offering_id: TeachingId,
    student_id: TeachingId,
    body: FinalResultPatch,
    db: Db,
    user: Actor,
):
    return update_final_result(db, user, int(course_offering_id), int(student_id), body)


@router.delete(
    PATH,
    response_model=ManualFinalResultResponse,
    description=(
        "Remove the entire record, including retake details. "
        "To clear only the grade, PATCH its field to null. Absent record is a no-op."
    ),
)
def delete_final_result(
    course_offering_id: TeachingId, student_id: TeachingId, db: Db, user: Actor
):
    return update_final_result(
        db, user, int(course_offering_id), int(student_id), FinalResultPatch(), delete=True
    )


journal_router = APIRouter(
    prefix="/api/v1/teaching",
    tags=["teaching"],
    dependencies=[Depends(validate_teaching_ids)],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 422, 500)},
)


@journal_router.get(JOURNAL + "/final-results", response_model=Page[ManualFinalResultResponse])
def list_journal_final_results(db: Db, scope: Scope, params: Annotated[StudentParams, Query()]):
    course_id, group_id = scope
    name_key = get_student_name_key(User.full_name)
    query = (
        select(Student, FinalResult, Student.id, name_key)
        .join(User, User.id == Student.user_id)
        .outerjoin(
            FinalResult,
            and_(FinalResult.student_id == Student.id, FinalResult.course_offering_id == course_id),
        )
        .where(Student.group_id == group_id)
    )
    if params.student_id is not None:
        query = query.where(Student.id == int(params.student_id))
    return list_page(
        db,
        query,
        params,
        (name_key, Student.id),
        (str, int),
        lambda row: serialize_result(course_id, row[0].id, row[1]),
        cursor_prefix=STUDENT_KEY_PREFIX,
    )
