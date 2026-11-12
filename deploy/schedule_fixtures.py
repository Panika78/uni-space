"""Small fictional schedule fixtures for isolated API/browser tests, never app seeding."""

import sys
from datetime import date, datetime, timedelta

from app.auth.security import PASSWORD_HASHER
from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Building,
    CourseGroup,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    LessonRoom,
    OrgUnit,
    Program,
    Room,
    Student,
    StudyGroup,
    Teacher,
    User,
)


def seed_schedule_fixtures(password):
    with SessionLocal.begin() as db:

        def add(model, **values):
            instance = model(**values)
            db.add(instance)
            db.flush()
            return instance

        faculty = add(OrgUnit, name="Тестовый вымышленный факультет", type="faculty")
        program = add(
            Program,
            code="schedule-fixture",
            name="Тестовая программа",
            direction_code="00.00",
            direction_name="Вымышленное направление",
            faculty_id=faculty.id,
        )
        groups = [
            add(StudyGroup, name=f"ТЕСТ-{i}", program_id=program.id, course_number=1)
            for i in (1, 2)
        ]
        password_hash = PASSWORD_HASHER.hash(password)
        for i, group in enumerate(groups, 1):
            user = add(
                User,
                login=f"schedule-fixture-{i}",
                password_hash=password_hash,
                full_name=f"Вымышленный Студент {i}",
                role="student",
                is_active=True,
            )
            add(Student, user_id=user.id, group_id=group.id, academic_status="enrolled")
        term = add(
            AcademicTerm,
            name="Тестовая осень 2026",
            starts_on=date(2026, 9, 1),
            ends_on=date(2027, 1, 31),
        )
        discipline = add(
            Discipline,
            name="Вымышленная дисциплина с длинным названием: методы математического моделирования университетских систем",
        )
        offering = add(
            CourseOffering,
            discipline_id=discipline.id,
            term_id=term.id,
            attestation_type="exam",
        )
        for group in groups:
            add(CourseGroup, course_offering_id=offering.id, group_id=group.id)
        buildings = [
            add(Building, name=f"Вымышленный учебный корпус {i}") for i in (1, 2)
        ]
        rooms = [
            add(Room, name=f"Аудитория {i}", building_id=b.id)
            for i, b in enumerate(buildings, 1)
        ]
        teacher = add(
            Teacher, full_name="Вымышленный Преподаватель С Очень Длинным Именем"
        )

        def lesson(starts, *, assigned=None, name=None, **values):
            course = offering
            if name:
                subject = add(Discipline, name=name)
                course = add(
                    CourseOffering,
                    discipline_id=subject.id,
                    term_id=term.id,
                    attestation_type="pass_fail",
                )
                for group in groups[:1] if assigned is None else assigned:
                    add(CourseGroup, course_offering_id=course.id, group_id=group.id)
            start = datetime.fromisoformat(starts)
            item = add(
                Lesson,
                course_offering_id=course.id,
                starts_at=start,
                ends_at=start + timedelta(hours=1),
                kind="lecture",
                **values,
            )
            for group in groups[:1] if assigned is None else assigned:
                add(LessonGroup, lesson_id=item.id, group_id=group.id)
            return item

        shared = lesson(
            "2026-11-10T09:00:00+03:00", assigned=groups, teacher_id=teacher.id
        )
        for room in rooms:
            add(LessonRoom, lesson_id=shared.id, room_id=room.id)
        lesson("2026-11-10T12:00:00+03:00", name="Только первая группа")
        lesson(
            "2026-11-10T12:00:00+03:00",
            assigned=groups[1:],
            name="Только вторая группа",
        )
        lesson("2026-11-10T23:30:00+03:00", name="Занятие через полночь")
        lesson("2026-11-15T10:00:00+03:00", name="Воскресное занятие")
        old = lesson(
            "2026-11-10T14:00:00+03:00", status="moved", name="Первая позиция переноса"
        )
        middle = lesson(
            "2026-11-20T14:00:00+03:00", status="moved", previous_lesson_id=old.id
        )
        lesson("2026-12-20T14:00:00+03:00", previous_lesson_id=middle.id)
        lesson(
            "2026-11-10T16:00:00+03:00", status="cancelled", name="Отменённое занятие"
        )

        # Additional TASK-011 positions use other dates, preserving existing day fixtures.
        single = lesson(
            "2026-11-12T09:00:00+03:00", status="moved", name="Одиночный перенос"
        )
        lesson(
            "2026-11-13T10:00:00+03:00",
            previous_lesson_id=single.id,
            name="Результат одиночного переноса",
        )
        cancelled_root = lesson(
            "2026-11-12T11:00:00+03:00",
            status="moved",
            name="Перенос с отменённым результатом",
        )
        cancelled_middle = lesson(
            "2026-11-20T11:00:00+03:00",
            status="moved",
            previous_lesson_id=cancelled_root.id,
            name="Промежуточная позиция отменённой цепочки",
        )
        lesson(
            "2027-01-03T00:30:00+03:00",
            status="cancelled",
            previous_lesson_id=cancelled_middle.id,
            name="Отменённый результат цепочки",
        )
        unavailable = lesson(
            "2026-11-12T13:00:00+03:00",
            status="moved",
            name="Недоступный результат переноса",
        )
        lesson(
            "2027-01-04T09:00:00+03:00",
            previous_lesson_id=unavailable.id,
            assigned=groups[1:],
            name="Скрытая позиция другой группы",
        )


if __name__ == "__main__":
    seed_schedule_fixtures(sys.stdin.read())
