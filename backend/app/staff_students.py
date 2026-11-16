"""Staff student search and explicit academic status updates."""

import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from pydantic import Field, field_validator
from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session

from app.audit import write_audit_event
from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import ApiError, Id, Page, PaginationParams, Ref, RequestModel
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import AuditEvent, OrgUnit, Program, Student, StudyGroup, User
from app.permissions import PermissionCode, require_staff_permission
from app.teaching.ordering import STUDENT_KEY_PREFIX, get_student_name_key

router = APIRouter(
    prefix="/api/v1/staff/students",
    tags=["staff", "students"],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 422, 500)},
)


class StaffStudentParams(PaginationParams):
    q: str | None = Field(default=None, min_length=1, max_length=100)
    faculty_id: Id | None = None
    program_id: Id | None = None
    course_number: int | None = Field(default=None, ge=1, le=100)

    @field_validator("faculty_id", "program_id")
    @classmethod
    def validate_filter_ids(cls, value: str | None) -> str | None:
        if value is not None and (len(value) > 19 or int(value) > 9_223_372_036_854_775_807):
            raise ValueError("ID exceeds PostgreSQL BIGINT")
        return value


class StaffStudent(RequestModel):
    id: Id
    full_name: str
    group: Ref
    course_number: int
    program: Ref
    faculty: Ref
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"]


class StaffStudentPage(Page[StaffStudent]):
    pass


class StaffStudentFilters(RequestModel):
    faculties: list[Ref]
    programs: list[Ref]
    course_numbers: list[int]


class AcademicStatusUpdate(RequestModel):
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"]
    reason: Literal["administrative_change", "correction"]
    operation_id: UUID


class AcademicStatusResponse(RequestModel):
    operation_id: str
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"]
    previous_academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"] | None
    changed: bool


class StudentAcademicStatus(RequestModel):
    id: Id
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"]


class StatusOperationReceipt(RequestModel):
    operation_id: str
    completed: bool


def _operation_fingerprint(*, actor_id: int, student_id: int, status: str, reason: str) -> str:
    payload = json.dumps(
        [actor_id, student_id, status, reason], ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_query(request: Request) -> None:
    if any(len(request.query_params.getlist(name)) != 1 for name in request.query_params):
        raise HTTPException(422, "validation_error")


def _require_read(db: Session, user: User) -> None:
    require_staff_permission(db, user, PermissionCode.STUDENTS_READ)


def _student_query():
    return (
        select(Student, User.full_name, StudyGroup, Program, OrgUnit)
        .join(User, User.id == Student.user_id)
        .join(StudyGroup, StudyGroup.id == Student.group_id)
        .join(Program, Program.id == StudyGroup.program_id)
        .join(OrgUnit, (OrgUnit.id == Program.faculty_id) & (OrgUnit.type == "faculty"))
    )


def _student_response(row) -> StaffStudent:
    student, full_name, group, program, faculty = row
    return StaffStudent(
        id=str(student.id),
        full_name=full_name,
        group=Ref(id=str(group.id), name=group.name),
        course_number=group.course_number,
        program=Ref(id=str(program.id), name=program.name),
        faculty=Ref(id=str(faculty.id), name=faculty.name),
        academic_status=student.academic_status,
    )


@router.get("/filters", response_model=StaffStudentFilters)
def get_staff_student_filters(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
    _query: Annotated[RequestModel, Query()],
) -> StaffStudentFilters:
    if request.query_params:
        raise RequestValidationError(
            [{"type": "extra_forbidden", "loc": ("query", name)} for name in request.query_params]
        )
    _require_read(db, user)
    faculties = db.execute(
        select(OrgUnit.id, OrgUnit.name).where(OrgUnit.type == "faculty").order_by(OrgUnit.name)
    ).all()
    programs = db.execute(select(Program.id, Program.name).order_by(Program.name, Program.id)).all()
    courses = db.scalars(
        select(StudyGroup.course_number).distinct().order_by(StudyGroup.course_number)
    )
    return StaffStudentFilters(
        faculties=[Ref(id=str(identifier), name=name) for identifier, name in faculties],
        programs=[Ref(id=str(identifier), name=name) for identifier, name in programs],
        course_numbers=list(courses),
    )


@router.get("", response_model=StaffStudentPage)
def list_staff_students(
    request: Request,
    params: Annotated[StaffStudentParams, Query()],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StaffStudentPage:
    _validate_query(request)
    _require_read(db, user)
    name_key = get_student_name_key(User.full_name)
    query = _student_query()
    if params.q:
        term = params.q.strip()
        if not term:
            raise HTTPException(422, "validation_error")
        term = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{term}%"
        query = query.where(
            func.lower(User.full_name).like(func.lower(pattern), escape="\\")
            | func.lower(StudyGroup.name).like(func.lower(pattern), escape="\\")
        )
    if params.faculty_id is not None:
        query = query.where(Program.faculty_id == int(params.faculty_id))
    if params.program_id is not None:
        query = query.where(Program.id == int(params.program_id))
    if params.course_number is not None:
        query = query.where(StudyGroup.course_number == params.course_number)

    # Keep this selection-specific fingerprint inside the existing typed key.
    # Other API cursors and the shared pagination module retain their contract.
    selection = hashlib.sha256(
        json.dumps(
            [
                (params.q or "").strip().lower(),
                int(params.faculty_id) if params.faculty_id else None,
                int(params.program_id) if params.program_id else None,
                params.course_number,
                STUDENT_KEY_PREFIX,
                "asc",
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    try:
        boundary = decode_page_cursor(params.cursor, key_types=(str, str, int), direction="asc")
        if boundary is not None:
            if boundary[0] != selection or not boundary[1].startswith(STUDENT_KEY_PREFIX):
                raise InvalidCursorError("Cursor does not match this selection")
            query = query.where(tuple_(name_key, Student.id) > tuple_(*boundary[1:]))
    except InvalidCursorError:
        raise HTTPException(422, "invalid_cursor") from None
    rows = db.execute(
        query.add_columns(name_key).order_by(name_key, Student.id).limit(params.limit + 1)
    ).all()
    entries = [(_student_response(row[:5]), (selection, row[5], row[0].id)) for row in rows]
    page = paginate_results(
        entries,
        key=lambda entry: entry[1],
        key_types=(str, str, int),
        direction="asc",
        limit=params.limit,
    )
    return StaffStudentPage(items=[entry[0] for entry in page.items], next_cursor=page.next_cursor)


@router.get("/{student_id}", response_model=StaffStudent)
def get_staff_student(
    student_id: Id,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StaffStudent:
    if len(student_id) > 19 or int(student_id) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    if request.query_params:
        raise RequestValidationError(
            [{"type": "extra_forbidden", "loc": ("query", name)} for name in request.query_params]
        )
    _require_read(db, user)
    row = db.execute(_student_query().where(Student.id == int(student_id))).one_or_none()
    if row is None:
        raise HTTPException(404, "not_found")
    return _student_response(row)


@router.get("/{student_id}/academic-status", response_model=StudentAcademicStatus)
def get_student_academic_status(
    student_id: Id,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StudentAcademicStatus:
    if len(student_id) > 19 or int(student_id) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    if request.query_params:
        raise RequestValidationError(
            [{"type": "extra_forbidden", "loc": ("query", name)} for name in request.query_params]
        )
    require_staff_permission(db, user, PermissionCode.STUDENTS_STATUS_EDIT)
    status = db.scalar(select(Student.academic_status).where(Student.id == int(student_id)))
    if status is None:
        raise HTTPException(404, "not_found")
    return StudentAcademicStatus(id=student_id, academic_status=status)


@router.get("/status-operations/{operation_id}", response_model=StatusOperationReceipt)
def get_status_operation_receipt(
    operation_id: UUID,
    student_id: Id,
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"],
    reason: Literal["administrative_change", "correction"],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> StatusOperationReceipt:
    require_staff_permission(db, user, PermissionCode.STUDENTS_STATUS_EDIT)
    if len(student_id) > 19 or int(student_id) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    fingerprint = _operation_fingerprint(
        actor_id=user.id, student_id=int(student_id), status=academic_status, reason=reason
    )
    stored = db.scalar(
        select(AuditEvent.operation_fingerprint).where(AuditEvent.operation_id == str(operation_id))
    )
    return StatusOperationReceipt(operation_id=str(operation_id), completed=stored == fingerprint)


@router.patch("/{student_id}/academic-status", response_model=AcademicStatusResponse)
def set_student_academic_status(
    student_id: Id,
    change: AcademicStatusUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db_session)],
) -> AcademicStatusResponse:
    if len(student_id) > 19 or int(student_id) > 9_223_372_036_854_775_807:
        raise HTTPException(422, "validation_error")
    require_staff_permission(db, user, PermissionCode.STUDENTS_STATUS_EDIT)
    fingerprint = _operation_fingerprint(
        actor_id=user.id,
        student_id=int(student_id),
        status=change.academic_status,
        reason=change.reason,
    )
    try:
        previous_operation = db.scalar(
            select(AuditEvent.operation_fingerprint).where(
                AuditEvent.operation_id == str(change.operation_id)
            )
        )
        if previous_operation is not None:
            if previous_operation != fingerprint:
                raise HTTPException(409, "operation_id_conflict")
            db.rollback()
            return AcademicStatusResponse(
                operation_id=str(change.operation_id),
                academic_status=change.academic_status,
                previous_academic_status=None,
                changed=True,
            )
        student = db.scalars(
            select(Student)
            .where(Student.id == int(student_id))
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one_or_none()
        if student is None:
            raise HTTPException(404, "not_found")
        previous_operation = db.scalar(
            select(AuditEvent.operation_fingerprint).where(
                AuditEvent.operation_id == str(change.operation_id)
            )
        )
        if previous_operation is not None:
            if previous_operation != fingerprint:
                raise HTTPException(409, "operation_id_conflict")
            db.rollback()
            return AcademicStatusResponse(
                operation_id=str(change.operation_id),
                academic_status=change.academic_status,
                previous_academic_status=None,
                changed=True,
            )
        before_status = student.academic_status
        if before_status != change.academic_status:
            student.academic_status = change.academic_status
            write_audit_event(
                db,
                actor=user,
                entity_type="student",
                entity_id=student.id,
                action="set_academic_status",
                before_data={"academic_status": before_status},
                after_data={"academic_status": change.academic_status},
                reason=change.reason,
                operation_id=str(change.operation_id),
                operation_fingerprint=fingerprint,
            )
        db.commit()
        return AcademicStatusResponse(
            operation_id=str(change.operation_id),
            academic_status=student.academic_status,
            previous_academic_status=before_status,
            changed=before_status != change.academic_status,
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
