from datetime import UTC, date, datetime, time, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, case, func, select, tuple_
from sqlalchemy.orm import Session

from app.academics.schemas import StudentCourse, StudentCourseAssessment, StudentCourseLesson
from app.academics.service import get_current_term, list_academic_items, serialize_term
from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import Ref
from app.models import (
    AcademicTerm,
    CourseGroup,
    CourseOffering,
    Lesson,
    Student,
    StudyGroup,
    Teacher,
    User,
)
from app.models.academics import Assessment, AssessmentGroup, AssessmentResult
from app.models.teaching import TeachingAssignment
from app.schedule.participants import get_student_lesson_condition
from app.schedule.service import MOSCOW, get_attendance_marks, list_lesson_details


def require_student_course(db: Session, student: Student, course_id: int) -> AcademicTerm:
    term = get_current_term(db)
    if term is None or not db.scalar(
        select(CourseOffering.id)
        .join(CourseGroup, CourseGroup.course_offering_id == CourseOffering.id)
        .where(
            CourseOffering.id == course_id,
            CourseOffering.term_id == term.id,
            CourseGroup.group_id == student.group_id,
        )
    ):
        raise HTTPException(404, "not_found")
    return term


def get_student_course(
    db: Session, student: Student, course_id: int, term: AcademicTerm
) -> StudentCourse:
    items = list_academic_items(db, student, term.id, course_id)
    if not items:
        raise HTTPException(404, "not_found")
    group = db.get(StudyGroup, student.group_id)
    teacher_name = func.coalesce(User.full_name, Teacher.full_name)
    teachers = db.execute(
        select(Teacher.id, teacher_name)
        .join(TeachingAssignment, TeachingAssignment.teacher_id == Teacher.id)
        .outerjoin(User, User.id == Teacher.user_id)
        .where(
            TeachingAssignment.course_offering_id == course_id,
            TeachingAssignment.group_id == student.group_id,
        )
        .order_by(teacher_name, Teacher.id)
    )
    return StudentCourse(
        **items[0].model_dump(),
        term=serialize_term(term),
        group=Ref(id=str(group.id), name=group.name),
        teachers=[Ref(id=str(teacher_id), name=name) for teacher_id, name in teachers],
    )


def get_page_rows(db, query, params, columns, key_types, scope, parse_key):
    types = (str, *key_types)
    try:
        boundary = decode_page_cursor(params.cursor, key_types=types, direction="asc")
        if boundary:
            if boundary[0] != scope:
                raise InvalidCursorError("Cursor belongs to a different selection")
            key = parse_key(boundary[1:])
            if db.execute(query.where(tuple_(*columns) == key).limit(1)).first() is None:
                raise InvalidCursorError("Cursor boundary is no longer available")
            query = query.where(tuple_(*columns) > key)
    except (ValueError, OverflowError) as exc:
        raise HTTPException(422, "validation_error") from exc
    return db.execute(query.order_by(*columns).limit(params.limit + 1)).all()


def get_cursor_scope(route, student, course_id, term, params):
    return ":".join(
        map(
            str,
            (
                route,
                student.id,
                student.group_id,
                student.subgroup_id or 0,
                student.membership_version,
                course_id,
                term.id,
                params.limit,
            ),
        )
    )


def parse_lesson_key(key):
    timestamp = datetime.fromisoformat(key[0])
    if timestamp.utcoffset() is None or timestamp.astimezone(UTC).isoformat() != key[0]:
        raise InvalidCursorError("Invalid timestamp")
    return timestamp, key[1]


def list_student_course_lessons(db, student, course_id, term, params):
    query = (
        select(Lesson, Teacher.id, func.coalesce(User.full_name, Teacher.full_name))
        .outerjoin(Teacher, Teacher.id == Lesson.teacher_id)
        .outerjoin(User, User.id == Teacher.user_id)
        .where(
            Lesson.course_offering_id == course_id,
            Lesson.starts_at >= datetime.combine(term.starts_on, time.min, MOSCOW),
            Lesson.starts_at < datetime.combine(term.ends_on + timedelta(days=1), time.min, MOSCOW),
            get_student_lesson_condition(Lesson.id, student.group_id, student.subgroup_id),
        )
    )
    scope = get_cursor_scope("course-lessons", student, course_id, term, params)
    rows = get_page_rows(
        db, query, params, (Lesson.starts_at, Lesson.id), (str, int), scope, parse_lesson_key
    )
    details = list_lesson_details(db, rows, student.group_id, student.subgroup_id)
    marks = get_attendance_marks(db, student.id, list(details))
    return paginate_results(
        (
            StudentCourseLesson(
                **item.model_dump(), attendance_status=marks.get(lesson_id, "unmarked")
            )
            for lesson_id, item in details.items()
        ),
        key=lambda item: (scope, item.starts_at.isoformat(), int(item.id)),
        key_types=(str, str, int),
        direction="asc",
        limit=params.limit,
    )


def parse_assessment_key(key):
    return key[0], key[1], date.fromisoformat(key[2]), key[3]


def list_student_course_assessments(db, student, course_id, term, params):
    has_no_date = case((AssessmentGroup.planned_date.is_(None), 1), else_=0)
    sortable_date = func.coalesce(AssessmentGroup.planned_date, date.max)
    query = (
        select(AssessmentGroup, Assessment, AssessmentResult)
        .join(Assessment, Assessment.id == AssessmentGroup.assessment_id)
        .outerjoin(
            AssessmentResult,
            and_(
                AssessmentResult.assessment_group_id == AssessmentGroup.id,
                AssessmentResult.student_id == student.id,
            ),
        )
        .where(
            AssessmentGroup.group_id == student.group_id,
            Assessment.course_offering_id == course_id,
        )
    )
    scope = get_cursor_scope("course-assessments", student, course_id, term, params)
    rows = get_page_rows(
        db,
        query,
        params,
        (Assessment.type.collate("C"), has_no_date, sortable_date, AssessmentGroup.id),
        (str, int, str, int),
        scope,
        parse_assessment_key,
    )
    return paginate_results(
        (
            StudentCourseAssessment(
                assessment_group_id=str(assignment.id),
                assessment_id=str(work.id),
                title=work.title,
                type=work.type,
                description=work.description,
                max_score=work.max_score,
                planned_date=assignment.planned_date,
                date_needs_confirmation=assignment.date_needs_confirmation,
                lesson_id=str(assignment.lesson_id) if assignment.lesson_id is not None else None,
                score=result.score if result else None,
                graded_at=result.graded_at if result else None,
            )
            for assignment, work, result in rows
        ),
        key=lambda item: (
            scope,
            item.type,
            int(item.planned_date is None),
            (item.planned_date or date.max).isoformat(),
            int(item.assessment_group_id),
        ),
        key_types=(str, str, int, str, int),
        direction="asc",
        limit=params.limit,
    )
