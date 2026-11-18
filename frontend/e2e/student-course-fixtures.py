"""Seed the course acceptance fixture in the isolated academics browser database."""

import json
import sys
from datetime import datetime, time, timedelta

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    CourseGroup,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    Student,
    StudyGroup,
    Subgroup,
    Teacher,
    TeacherAnnouncement,
    TeachingAssignment,
    User,
)
from app.schedule.service import MOSCOW
from app.student_service import update_student_group
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

PASSWORD = "Fictional-Course-E2E-2026"
DISCIPLINE = (
    "Вымышленное моделирование университетских информационных систем "
    "и проектирование междисциплинарных цифровых сервисов"
)


def seed(db):
    def add(model, **values):
        record = model(**values)
        db.add(record)
        db.flush()
        return record

    def user(login, name, role):
        return add(
            User,
            login=login,
            full_name=name,
            password_hash=password_hash,
            role=role,
            is_active=True,
        )

    today = datetime.now(MOSCOW).date()
    term = db.scalar(select(AcademicTerm).where(AcademicTerm.name == "Тестовый текущий семестр"))
    term.starts_on = min(term.starts_on, today - timedelta(days=100))
    term.ends_on = max(term.ends_on, today + timedelta(days=40))
    first, second = db.scalars(
        select(StudyGroup)
        .where(StudyGroup.name.in_(["ТЕСТ-1", "ТЕСТ-2"]))
        .order_by(StudyGroup.name)
    ).all()
    subgroup_a = add(Subgroup, group_id=first.id, name="Курс A")
    subgroup_b = add(Subgroup, group_id=second.id, name="Курс B")
    unused_subgroup = add(Subgroup, group_id=first.id, name="Другая подгруппа")
    password_hash = PASSWORD_HASHER.hash(PASSWORD)
    students = []
    for suffix, group, subgroup in [("alpha", first, subgroup_a), ("beta", second, subgroup_b)]:
        account = user(f"course-{suffix}", f"Вымышленный студент {suffix}", "student")
        students.append(
            add(
                Student,
                user_id=account.id,
                group_id=group.id,
                subgroup_id=subgroup.id,
                academic_status="enrolled",
                membership_changed_at=datetime.combine(term.starts_on, time.min, MOSCOW),
            )
        )
    teachers = []
    for suffix, name in [("first", "Анна Тестовая"), ("second", "Борис Тестовый")]:
        account = user(f"course-{suffix}-teacher", name, "teacher")
        teachers.append(add(Teacher, full_name=name, user_id=account.id))

    subject = add(Discipline, name=DISCIPLINE)
    courses = [
        add(CourseOffering, discipline_id=subject.id, term_id=term.id, attestation_type=kind)
        for kind in ("exam", "pass_fail")
    ]
    primary, parallel = courses
    for offering, group in [(primary, first), (primary, second), (parallel, first)]:
        add(CourseGroup, course_offering_id=offering.id, group_id=group.id)
    for teacher, group in [(teachers[0], first), (teachers[0], second), (teachers[1], first)]:
        add(
            TeachingAssignment,
            teacher_id=teacher.id,
            group_id=group.id,
            course_offering_id=primary.id,
        )

    day = today - timedelta(days=2)

    def lesson(
        delta, hour=9, *, offering=primary, assignments=None, previous=None, status="scheduled"
    ):
        starts = datetime.combine(today + timedelta(days=delta), time(hour), MOSCOW)
        record = add(
            Lesson,
            course_offering_id=offering.id,
            teacher_id=teachers[0].id,
            kind="seminar",
            status=status,
            previous_lesson_id=previous.id if previous else None,
            starts_at=starts,
            ends_at=starts + timedelta(hours=1),
        )
        for group, subgroup in assignments or [(first, None)]:
            add(LessonGroup, lesson_id=record.id, group_id=group.id, subgroup_id=subgroup)
        return record

    for delta in range(-84, -30, 2):
        lesson(delta)
    old = lesson(-24, status="moved")
    middle = lesson(-20, previous=old, status="moved")
    latest = lesson(-16, previous=middle)
    cancelled = lesson(-14, status="cancelled")
    single = lesson(-2, 8, assignments=[(first, subgroup_a.id)])
    multiple = lesson(-2, 10, assignments=[(first, None), (second, None)])
    unlinked = lesson(-2, 12)
    invisible = lesson(-2, 14, assignments=[(first, unused_subgroup.id)])
    lesson(-2, 16, offering=parallel)

    def work(title, maximum, group=first, linked=None, confirmation=False, offering=primary):
        assessment = add(
            Assessment,
            title=title,
            type="test",
            max_score=maximum,
            course_offering_id=offering.id,
        )
        return add(
            AssessmentGroup,
            assessment_id=assessment.id,
            group_id=group.id,
            planned_date=linked.starts_at.astimezone(MOSCOW).date() if linked else None,
            lesson_id=linked.id if linked else None,
            date_needs_confirmation=confirmation,
        )

    single_work = work("Личный результат первой группы", 10, linked=single)
    add(
        AssessmentResult,
        assessment_group_id=single_work.id,
        student_id=students[0].id,
        score=0,
        graded_at=datetime.now(MOSCOW),
    )
    work("Нулевой максимум без результата", 0, linked=multiple)
    work("Вторая работа общей пары", 20, linked=multiple)
    work("Сохранённая работа перенесённой пары", 10, linked=old, confirmation=True)
    work("Сохранённая работа отменённой пары", 5, linked=cancelled, confirmation=True)
    for i in range(21):
        work(f"Задание без даты {i:02}", 7)
    work("Работа второго проведения", 11, offering=parallel)
    beta = work("Личный результат второй группы", 17, group=second)
    add(
        AssessmentResult,
        assessment_group_id=beta.id,
        student_id=students[1].id,
        score=13,
        graded_at=datetime.now(MOSCOW),
    )
    for i in range(21):
        add(
            TeacherAnnouncement,
            course_offering_id=primary.id,
            teacher_id=teachers[0].id,
            title=f"Общее объявление {i:02}",
            body="Общий учебный текст.",
        )
    for group, teacher, title in [
        (first, teachers[1], "Объявление для первой группы"),
        (second, teachers[0], "Объявление для второй группы"),
    ]:
        add(
            TeacherAnnouncement,
            course_offering_id=primary.id,
            group_id=group.id,
            teacher_id=teacher.id,
            title=title,
            body="Безопасный текст <strong>как есть</strong>.",
            is_important=True,
        )
    return {
        "discipline": DISCIPLINE,
        "course": str(primary.id),
        "parallel": str(parallel.id),
        "day": day.isoformat(),
        "first_group": str(first.id),
        "second_group": str(second.id),
        "student": str(students[0].id),
        "single": str(single.id),
        "multiple": str(multiple.id),
        "unlinked": str(unlinked.id),
        "invisible": str(invisible.id),
        "old": str(old.id),
        "middle": str(middle.id),
        "latest": str(latest.id),
        "single_work": str(single_work.id),
    }


def main():
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if settings.app_env != "test" or url.database != "uni_space_test":
        raise SystemExit("Student course browser fixtures require uni_space_test")
    with SessionLocal.begin() as db:
        if db.execute(text("SELECT current_database(), current_user")).one() != (
            "uni_space_test",
            "uni_space_test",
        ):
            raise SystemExit("Unexpected database or user for the student course fixture")
        args = sys.argv[1:]
        if not args:
            print(json.dumps(seed(db), ensure_ascii=False))
        elif len(args) == 3 and args[0] == "transfer":
            update_student_group(db, int(args[1]), int(args[2]))
        else:
            raise SystemExit("Expected no arguments or transfer STUDENT GROUP")


if __name__ == "__main__":
    main()
