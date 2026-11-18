"""Journal reads for effective dean office grants."""

from datetime import UTC, datetime
from hashlib import sha256
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field
from sqlalchemy import and_, case, exists, literal, or_, select

from app.core.schemas import ApiError, DateTime, Id, Page, PaginationParams, Ref, RequestModel
from app.dependencies.auth import get_current_user
from app.final_results import Db, ManualFinalResultResponse, serialize_result
from app.models import (
    AcademicTerm,
    AssessmentGroup,
    AssessmentResult,
    Attendance,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    Lesson,
    Student,
    StudyGroup,
    User,
)
from app.permissions import (
    AuthorizationContext,
    PermissionCode,
    get_authorization_context,
    require_permission,
)
from app.schedule.participants import get_student_lesson_condition
from app.staff_journal_history import (
    FinalSnapshot,
    JournalEvent,
    ScoreSnapshot,
    has_history,
    list_history,
)
from app.teaching.ordering import STUDENT_KEY_PREFIX, get_student_name_key
from app.teaching.schemas import (
    AssessmentParams,
    AssignmentParams,
    JournalAssessment,
    JournalLesson,
    LessonParams,
    StudentParams,
)
from app.teaching.service import (
    get_assessment_query,
    list_journal_assessments,
    list_journal_lessons,
    list_page,
    require_journal_lesson,
)
from app.teaching.validation import TeachingId, validate_teaching_ids


def reject_duplicate_filters(request: Request):
    keys = list(request.query_params.keys())
    if len(keys) != len(request.query_params.multi_items()):
        raise HTTPException(422, "validation_error")


router = APIRouter(
    prefix="/api/v1/staff/journals",
    tags=["staff-journals"],
    dependencies=[Depends(validate_teaching_ids), Depends(reject_duplicate_filters)],
    responses={code: {"model": ApiError} for code in (401, 403, 404, 422, 500, 503)},
)
COURSE = "/courses/{course_offering_id}"
JOURNAL = COURSE + "/groups/{group_id}"
RESULTS = JOURNAL + "/assessments/{assessment_group_id}/results"
Grades = Annotated[User, Depends(require_permission(PermissionCode.GRADES_EDIT))]
AttendanceGrant = Annotated[User, Depends(require_permission(PermissionCode.ATTENDANCE_EDIT))]
Actor = Annotated[User, Depends(get_current_user)]


def require_journal_access(db: Db, user: Actor):
    context = get_authorization_context(db, user)
    if not any(
        grant.permission_code in {PermissionCode.GRADES_EDIT, PermissionCode.ATTENDANCE_EDIT}
        for grant in context.permissions
    ):
        raise HTTPException(403, "forbidden")
    return context


class CatalogParams(AssignmentParams):
    q: str | None = Field(default=None, max_length=100)


class RosterParams(StudentParams):
    q: str | None = Field(default=None, max_length=100)


class StaffCatalogItem(RequestModel):
    attestation_type: Literal["exam", "graded_pass", "pass_fail"] | None = None
    course_offering_id: Id
    discipline: Ref
    term: Ref
    group: Ref


class StaffJournalStudent(RequestModel):
    student_id: Id
    full_name: str


class StaffScoreRow(StaffJournalStudent):
    result_id: Id | None
    score: int | None
    is_current_group_member: bool
    history_only: bool
    can_edit: bool


class StaffFinalRow(ManualFinalResultResponse):
    full_name: str


class HistoricalFinalStudent(StaffJournalStudent):
    history_only: bool


class StaffAttendanceRow(StaffJournalStudent):
    subgroup_id: Id | None
    status: Literal["attended", "absent", "unmarked"]
    updated_at: DateTime | None
    is_historical: bool
    can_edit: bool


def require_course_group(db, course_id, group_id):
    if db.get(CourseGroup, (course_id, group_id)) is None:
        raise HTTPException(404, "not_found")


def require_assessment(db, course_id, group_id, assessment_group_id):
    if (
        db.execute(
            get_assessment_query(course_id, group_id).where(
                AssessmentGroup.id == assessment_group_id
            )
        ).first()
        is None
    ):
        raise HTTPException(404, "not_found")


def page_scope(request: Request, user_id: int | str, params: PaginationParams, *, grant=""):
    filters = params.model_dump_json(exclude={"limit", "cursor"})
    return sha256(f"{request.url.path}\n{user_id}\n{grant}\n{filters}".encode()).hexdigest()


def student_page(db, query, params, convert, *, cursor_scope):
    name_key = get_student_name_key(User.full_name)
    query = query.add_columns(Student.id, name_key).join(User, User.id == Student.user_id)
    if params.student_id is not None:
        query = query.where(Student.id == int(params.student_id))
    if params.q and params.q.strip():
        query = query.where(User.full_name.icontains(params.q.strip(), autoescape=True))
    return list_page(
        db,
        query,
        params,
        (name_key, Student.id),
        (str, int),
        convert,
        cursor_prefix=STUDENT_KEY_PREFIX,
        cursor_scope=cursor_scope,
    )


@router.get(
    "/catalog",
    response_model=Page[StaffCatalogItem],
    response_model_exclude_unset=True,
)
def list_catalog(
    request: Request,
    db: Db,
    params: Annotated[CatalogParams, Query()],
    access: Annotated[AuthorizationContext, Depends(require_journal_access)],
):
    can_read_grades = any(
        grant.permission_code == PermissionCode.GRADES_EDIT for grant in access.permissions
    )
    query = (
        select(
            CourseGroup.course_offering_id,
            CourseGroup.group_id,
            StudyGroup.name,
            Discipline.id,
            Discipline.name,
            AcademicTerm.id,
            AcademicTerm.name,
            CourseOffering.attestation_type if can_read_grades else literal(None),
        )
        .select_from(CourseGroup)
        .join(CourseOffering, CourseOffering.id == CourseGroup.course_offering_id)
        .join(StudyGroup, StudyGroup.id == CourseGroup.group_id)
        .join(Discipline, Discipline.id == CourseOffering.discipline_id)
        .join(AcademicTerm, AcademicTerm.id == CourseOffering.term_id)
    )
    for value, column in (
        (params.course_offering_id, CourseGroup.course_offering_id),
        (params.group_id, CourseGroup.group_id),
        (params.term_id, AcademicTerm.id),
    ):
        if value is not None:
            query = query.where(column == int(value))
    if params.q and params.q.strip():
        query = query.where(
            or_(
                *(
                    name.icontains(params.q.strip(), autoescape=True)
                    for name in (Discipline.name, StudyGroup.name, AcademicTerm.name)
                )
            )
        )

    def convert(row):
        course, group, group_name, discipline, discipline_name, term, term_name, attestation = row
        return StaffCatalogItem(
            course_offering_id=str(course),
            **({"attestation_type": attestation} if can_read_grades else {}),
            group=Ref(id=str(group), name=group_name),
            discipline=Ref(id=str(discipline), name=discipline_name),
            term=Ref(id=str(term), name=term_name),
        )

    return list_page(
        db,
        query,
        params,
        (CourseGroup.course_offering_id, CourseGroup.group_id),
        (int, int),
        convert,
        cursor_scope=page_scope(request, access.user_id, params, grant=str(can_read_grades)),
    )


@router.get(
    JOURNAL + "/students",
    response_model=Page[StaffJournalStudent],
    dependencies=[Depends(require_journal_access)],
)
def list_students(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    request: Request,
    db: Db,
    user: Actor,
    params: Annotated[RosterParams, Query()],
):
    require_course_group(db, int(course_offering_id), int(group_id))
    query = select(User.full_name).select_from(Student).where(Student.group_id == int(group_id))
    return student_page(
        db,
        query,
        params,
        lambda row: StaffJournalStudent(student_id=str(row.id), full_name=row.full_name),
        cursor_scope=page_scope(request, user.id, params),
    )


@router.get(JOURNAL + "/assessments", response_model=Page[JournalAssessment])
def list_assessments(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    request: Request,
    db: Db,
    user: Grades,
    params: Annotated[AssessmentParams, Query()],
):
    course, group = int(course_offering_id), int(group_id)
    require_course_group(db, course, group)
    return list_journal_assessments(
        db, course, group, params, cursor_scope=page_scope(request, user.id, params)
    )


@router.get(RESULTS, response_model=Page[StaffScoreRow])
def list_scores(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    assessment_group_id: TeachingId,
    request: Request,
    db: Db,
    user: Grades,
    params: Annotated[RosterParams, Query()],
):
    course, group, assessment = map(int, (course_offering_id, group_id, assessment_group_id))
    require_assessment(db, course, group, assessment)
    current = Student.group_id == group
    history = has_history("assessment_result", assessment, Student.id)
    query = (
        select(User.full_name, AssessmentResult, current.label("current"))
        .select_from(Student)
        .outerjoin(
            AssessmentResult,
            and_(
                AssessmentResult.student_id == Student.id,
                AssessmentResult.assessment_group_id == assessment,
            ),
        )
        .where(or_(current, AssessmentResult.id.is_not(None), history))
    )

    def convert(row):
        result = row.AssessmentResult
        return StaffScoreRow(
            student_id=str(row.id),
            full_name=row.full_name,
            result_id=str(result.id) if result else None,
            score=result.score if result else None,
            is_current_group_member=row.current,
            history_only=not row.current and result is None,
            can_edit=row.current or result is not None,
        )

    return student_page(
        db, query, params, convert, cursor_scope=page_scope(request, user.id, params)
    )


@router.get(JOURNAL + "/final-results", response_model=Page[StaffFinalRow])
def list_finals(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    request: Request,
    db: Db,
    user: Grades,
    params: Annotated[RosterParams, Query()],
):
    course, group = int(course_offering_id), int(group_id)
    require_course_group(db, course, group)
    query = (
        select(User.full_name, FinalResult)
        .select_from(Student)
        .outerjoin(
            FinalResult,
            and_(FinalResult.student_id == Student.id, FinalResult.course_offering_id == course),
        )
        .where(Student.group_id == group)
    )

    def convert(row):
        return StaffFinalRow(
            full_name=row.full_name,
            **serialize_result(course, row.id, row.FinalResult).model_dump(),
        )

    return student_page(
        db, query, params, convert, cursor_scope=page_scope(request, user.id, params)
    )


@router.get(COURSE + "/historical-final-students", response_model=Page[HistoricalFinalStudent])
def list_historical_final_students(
    course_offering_id: TeachingId,
    request: Request,
    db: Db,
    user: Grades,
    params: Annotated[RosterParams, Query()],
):
    course = int(course_offering_id)
    if db.get(CourseOffering, course) is None:
        raise HTTPException(404, "not_found")
    query = (
        select(User.full_name, FinalResult.id.is_(None).label("history_only"))
        .select_from(Student)
        .outerjoin(
            FinalResult,
            and_(FinalResult.student_id == Student.id, FinalResult.course_offering_id == course),
        )
        .where(has_history("final_result", course, Student.id))
    )
    return student_page(
        db,
        query,
        params,
        lambda row: HistoricalFinalStudent(
            student_id=str(row.id), full_name=row.full_name, history_only=row.history_only
        ),
        cursor_scope=page_scope(request, user.id, params),
    )


@router.get(JOURNAL + "/lessons", response_model=Page[JournalLesson])
def list_lessons(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    request: Request,
    db: Db,
    user: AttendanceGrant,
    params: Annotated[LessonParams, Query()],
):
    course, group = int(course_offering_id), int(group_id)
    require_course_group(db, course, group)
    return list_journal_lessons(
        db, course, group, params, cursor_scope=page_scope(request, user.id, params)
    )


@router.get(JOURNAL + "/lessons/{lesson_id}/attendance", response_model=Page[StaffAttendanceRow])
def list_attendance(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    lesson_id: TeachingId,
    request: Request,
    db: Db,
    user: AttendanceGrant,
    params: Annotated[RosterParams, Query()],
):
    course, group, lesson = map(int, (course_offering_id, group_id, lesson_id))
    require_journal_lesson(db, course, group, lesson)
    current = and_(
        Student.group_id == group, get_student_lesson_condition(lesson, group, Student.subgroup_id)
    )
    visible = (Attendance.origin_group_id == group).is_(True)
    historical = and_(
        visible,
        or_(
            ~current,
            Attendance.origin_subgroup_id.is_distinct_from(Student.subgroup_id),
            Attendance.membership_version.is_distinct_from(Student.membership_version),
        ),
    )
    editable = or_(
        visible,
        and_(
            Attendance.lesson_id.is_(None),
            current,
            Lesson.status == "scheduled",
            Lesson.starts_at <= datetime.now(UTC),
            Lesson.starts_at >= Student.membership_changed_at,
        ),
    )
    query = (
        select(
            User.full_name,
            historical.label("historical"),
            editable.label("editable"),
            case((visible, Attendance.origin_subgroup_id), else_=Student.subgroup_id).label(
                "subgroup"
            ),
            case((visible, Attendance.status), else_="unmarked").label("status"),
            case((visible, Attendance.updated_at)).label("updated_at"),
        )
        .select_from(Student)
        .join(Lesson, Lesson.id == lesson)
        .outerjoin(
            Attendance, and_(Attendance.lesson_id == lesson, Attendance.student_id == Student.id)
        )
        .where(or_(current, visible))
    )
    return student_page(
        db,
        query,
        params,
        lambda row: StaffAttendanceRow(
            student_id=str(row.id),
            full_name=row.full_name,
            subgroup_id=str(row.subgroup) if row.subgroup else None,
            status=row.status,
            updated_at=row.updated_at,
            is_historical=row.historical,
            can_edit=row.editable,
        ),
        cursor_scope=page_scope(request, user.id, params),
    )


@router.get(RESULTS + "/{student_id}/history", response_model=Page[JournalEvent[ScoreSnapshot]])
def get_score_history(
    course_offering_id: TeachingId,
    group_id: TeachingId,
    assessment_group_id: TeachingId,
    student_id: TeachingId,
    db: Db,
    user: Grades,
    params: Annotated[PaginationParams, Query()],
):
    course, group, assessment, student = map(
        int, (course_offering_id, group_id, assessment_group_id, student_id)
    )
    require_assessment(db, course, group, assessment)
    if not db.scalar(
        select(
            exists().where(
                Student.id == student,
                or_(
                    Student.group_id == group,
                    exists().where(
                        AssessmentResult.assessment_group_id == assessment,
                        AssessmentResult.student_id == student,
                    ),
                    has_history("assessment_result", assessment, student),
                ),
            )
        )
    ):
        raise HTTPException(404, "not_found")
    return list_history(
        db, "assessment_result", assessment, student, params, identity=f"{user.id}:{course}:{group}"
    )


@router.get(
    COURSE + "/students/{student_id}/final-result/history",
    response_model=Page[JournalEvent[FinalSnapshot]],
)
def get_final_history(
    course_offering_id: TeachingId,
    student_id: TeachingId,
    db: Db,
    user: Grades,
    params: Annotated[PaginationParams, Query()],
):
    course, student = map(int, (course_offering_id, student_id))
    if db.get(CourseOffering, course) is None or not db.scalar(
        select(
            exists().where(
                Student.id == student,
                or_(
                    exists().where(
                        CourseGroup.course_offering_id == course,
                        CourseGroup.group_id == Student.group_id,
                    ),
                    exists().where(
                        FinalResult.course_offering_id == course, FinalResult.student_id == student
                    ),
                    has_history("final_result", course, student),
                ),
            )
        )
    ):
        raise HTTPException(404, "not_found")
    return list_history(db, "final_result", course, student, params, identity=user.id)
