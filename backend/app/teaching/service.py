"""Read journal data only after resolving the current teacher's assignment.

No faculty or lesson-teacher inference. Child identities are always resolved
within the authorized course/group pair, before pagination or serialization.
"""

from fastapi import HTTPException
from sqlalchemy import and_, exists, or_, select, tuple_
from sqlalchemy.orm import Session

from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import Ref
from app.models import (
    AcademicTerm,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    Student,
    StudyGroup,
    Teacher,
    TeachingAssignment,
    User,
)
from app.permissions import get_authorization_context
from app.schedule.participants import get_student_lesson_condition
from app.teaching.ordering import STUDENT_KEY_PREFIX, get_student_name_key
from app.teaching.schemas import (
    JournalAssessment,
    JournalLesson,
    JournalResult,
    JournalStudent,
    TeachingAssignmentResponse,
)


def require_current_teacher(db: Session, user: User) -> int:
    context = get_authorization_context(db, user)
    if context.role != "teacher":
        raise HTTPException(403, "forbidden")
    teacher = db.scalar(select(Teacher.id).where(Teacher.user_id == user.id))
    if teacher is None:
        raise HTTPException(403, "forbidden")
    return teacher


def require_teaching_assignment(db: Session, teacher_id: int, course_id: int, group_id: int):
    assignment = db.scalar(
        select(TeachingAssignment.id).where(
            TeachingAssignment.teacher_id == teacher_id,
            TeachingAssignment.course_offering_id == course_id,
            TeachingAssignment.group_id == group_id,
        )
    )
    if assignment is None:
        raise HTTPException(404, "not_found")


def list_page(db, query, params, columns, key_types, convert, *, cursor_prefix=None):
    boundary = decode_page_cursor(params.cursor, key_types=key_types, direction="asc")
    if boundary is not None:
        if cursor_prefix is not None and not boundary[0].startswith(cursor_prefix):
            raise InvalidCursorError("Cursor uses an obsolete student ordering")
        query = query.where(tuple_(*columns) > tuple_(*boundary))
    rows = db.execute(query.order_by(*columns).limit(params.limit + 1)).all()
    # Keep cursor keys in their SQL ordering, independent of serialized IDs.
    entries = [(convert(row), tuple(row._mapping[c] for c in columns)) for row in rows]
    page = paginate_results(
        entries,
        key=lambda entry: entry[1],
        key_types=key_types,
        direction="asc",
        limit=params.limit,
    )
    return dict(items=[entry[0] for entry in page.items], next_cursor=page.next_cursor)


def list_teaching_assignments(db, teacher_id, params):
    query = (
        select(
            TeachingAssignment,
            CourseOffering,
            Discipline,
            AcademicTerm,
            StudyGroup,
            TeachingAssignment.id,
        )
        .select_from(TeachingAssignment)
        .join(CourseOffering, CourseOffering.id == TeachingAssignment.course_offering_id)
        .join(Discipline, Discipline.id == CourseOffering.discipline_id)
        .join(AcademicTerm, AcademicTerm.id == CourseOffering.term_id)
        .join(StudyGroup, StudyGroup.id == TeachingAssignment.group_id)
        .where(TeachingAssignment.teacher_id == teacher_id)
    )
    for value, column in (
        (params.course_offering_id, TeachingAssignment.course_offering_id),
        (params.group_id, TeachingAssignment.group_id),
        (params.term_id, CourseOffering.term_id),
    ):
        if value is not None:
            query = query.where(column == int(value))

    def convert(row):
        assignment, course, discipline, term, group, _ = row
        return TeachingAssignmentResponse(
            id=str(assignment.id),
            course_offering_id=str(course.id),
            discipline=Ref(id=str(discipline.id), name=discipline.name),
            term=Ref(id=str(term.id), name=term.name),
            group=Ref(id=str(group.id), name=group.name),
            attestation_type=course.attestation_type,
        )

    return list_page(db, query, params, (TeachingAssignment.id,), (int,), convert)


def list_journal_students(db, group_id, params, lesson_id=None):
    name_key = get_student_name_key(User.full_name)
    query = (
        select(Student, User.full_name, Student.id, name_key)
        .join(User, User.id == Student.user_id)
        .where(Student.group_id == group_id)
    )
    if params.student_id is not None:
        query = query.where(Student.id == int(params.student_id))
    if lesson_id is not None:
        query = query.where(get_student_lesson_condition(lesson_id, group_id, Student.subgroup_id))

    def convert(row):
        student, name, _, _key = row
        return JournalStudent(
            id=str(student.id),
            full_name=name,
            subgroup_id=str(student.subgroup_id) if student.subgroup_id else None,
            academic_status=student.academic_status,
        )

    return list_page(
        db,
        query,
        params,
        (name_key, Student.id),
        (str, int),
        convert,
        cursor_prefix=STUDENT_KEY_PREFIX,
    )


def get_assessment_query(course_id, group_id):
    return (
        select(AssessmentGroup, Assessment, AssessmentGroup.id)
        .join(Assessment)
        .where(Assessment.course_offering_id == course_id, AssessmentGroup.group_id == group_id)
    )


def list_journal_assessments(db, course_id, group_id, params):
    query = get_assessment_query(course_id, group_id)
    if params.assessment_group_id is not None:
        query = query.where(AssessmentGroup.id == int(params.assessment_group_id))

    def convert(row):
        assignment, work, _ = row
        # A lesson link is exposed only if it still belongs to this pair.
        return JournalAssessment(
            id=str(assignment.id),
            assessment_id=str(work.id),
            title=work.title,
            type=work.type,
            description=work.description,
            max_score=work.max_score,
            planned_date=assignment.planned_date,
            lesson_id=str(assignment.lesson_id) if assignment.lesson_id else None,
            date_needs_confirmation=assignment.date_needs_confirmation,
        )

    return list_page(db, query, params, (AssessmentGroup.id,), (int,), convert)


def list_journal_results(db, course_id, group_id, assessment_group_id, params):
    if (
        db.execute(
            get_assessment_query(course_id, group_id).where(
                AssessmentGroup.id == assessment_group_id
            )
        ).first()
        is None
    ):
        raise HTTPException(404, "not_found")
    name_key = get_student_name_key(User.full_name)
    query = (
        select(Student, User.full_name, AssessmentResult, Student.id, name_key)
        .join(User, User.id == Student.user_id)
        .outerjoin(
            AssessmentResult,
            and_(
                AssessmentResult.student_id == Student.id,
                AssessmentResult.assessment_group_id == assessment_group_id,
            ),
        )
        .where(or_(Student.group_id == group_id, AssessmentResult.id.is_not(None)))
    )
    if params.student_id is not None:
        query = query.where(Student.id == int(params.student_id))

    def convert(row):
        student, name, result, _, _key = row
        return JournalResult(
            student_id=str(student.id),
            full_name=name,
            result_id=str(result.id) if result else None,
            score=result.score if result else None,
            graded_at=result.graded_at if result else None,
            is_current_group_member=student.group_id == group_id,
        )

    return list_page(
        db,
        query,
        params,
        (name_key, Student.id),
        (str, int),
        convert,
        cursor_prefix=STUDENT_KEY_PREFIX,
    )


def get_lesson_query(course_id, group_id):
    return select(Lesson, Lesson.starts_at, Lesson.id).where(
        Lesson.course_offering_id == course_id,
        exists().where(LessonGroup.lesson_id == Lesson.id, LessonGroup.group_id == group_id),
    )


def require_journal_lesson(db, course_id, group_id, lesson_id):
    if (
        db.execute(get_lesson_query(course_id, group_id).where(Lesson.id == lesson_id)).first()
        is None
    ):
        raise HTTPException(404, "not_found")


def list_journal_lessons(db, course_id, group_id, params):
    query = get_lesson_query(course_id, group_id)
    for value, condition in (
        (params.lesson_id, Lesson.id == int(params.lesson_id) if params.lesson_id else None),
        (
            params.starts_from,
            Lesson.starts_at >= params.starts_from if params.starts_from else None,
        ),
        (
            params.starts_before,
            Lesson.starts_at < params.starts_before if params.starts_before else None,
        ),
        (params.status, Lesson.status == params.status),
    ):
        if value is not None:
            query = query.where(condition)
    # Fixed-width UTC strings preserve chronological ordering in shared cursors.
    from sqlalchemy import func

    time_key = func.to_char(
        Lesson.starts_at.op("AT TIME ZONE")("UTC"), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
    query = query.add_columns(time_key)

    def convert(row):
        lesson = row[0]
        return JournalLesson(
            id=str(lesson.id),
            starts_at=lesson.starts_at,
            ends_at=lesson.ends_at,
            kind=lesson.kind,
            status=lesson.status,
            is_additional=lesson.is_additional,
            version=lesson.version,
        )

    return list_page(db, query, params, (time_key, Lesson.id), (str, int), convert)
