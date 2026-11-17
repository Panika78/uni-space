"""Create isolated, fictional staff schedule editor browser fixtures."""

import os
import stat
from datetime import date, datetime, time, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
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
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    Subgroup,
    Teacher,
    TeachingAssignment,
    User,
)


def main() -> None:
    if not stat.S_ISREG(os.fstat(1).st_mode) or stat.S_IMODE(os.fstat(1).st_mode) != 0o600:
        raise SystemExit("Fixture credentials require a regular 0600 output file")
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if (
        settings.app_env != "test"
        or url.database != "uni_space_test"
        or url.host not in {"localhost", "127.0.0.1"}
        or url.username != "uni_space_test"
        or url.password != "test-only-password"
    ):
        raise SystemExit("Refusing to seed browser fixtures outside uni_space_test")

    suffix = uuid4().hex[:10]
    password = "Fictional-Staff-Schedule-E2E-2026"
    logins = [f"staff-schedule-{index}-{suffix}" for index in range(1, 4)]
    moscow_today = datetime.now(ZoneInfo("Europe/Moscow")).date()
    if moscow_today.month < 2:
        term_start, term_end = date(moscow_today.year - 1, 9, 1), date(moscow_today.year, 1, 31)
    elif moscow_today.month < 9:
        term_start, term_end = date(moscow_today.year, 2, 1), date(moscow_today.year, 8, 31)
    else:
        term_start, term_end = date(moscow_today.year, 9, 1), date(moscow_today.year + 1, 1, 31)
    starts_at = datetime.combine(moscow_today, time(18, 0), ZoneInfo("Europe/Moscow"))

    with SessionLocal.begin() as session:
        faculty = OrgUnit(name=f"Вымышленный факультет {suffix}", type="faculty")
        office = OrgUnit(name=f"Вымышленный деканат {suffix}", type="dean_office")
        session.add_all([faculty, office])
        session.flush()
        program = Program(
            code=f"browser-{suffix}",
            name="Вымышленная программа для браузерной проверки",
            direction_code="00.00",
            direction_name="Вымышленное направление",
            faculty_id=faculty.id,
        )
        session.add(program)
        session.flush()
        groups = [
            StudyGroup(name=f"SCHEDULE-{suffix}-{index}", program_id=program.id, course_number=1)
            for index in (1, 2)
        ]
        term = AcademicTerm(
            name=f"Вымышленный семестр {suffix}", starts_on=term_start, ends_on=term_end
        )
        discipline = Discipline(code=f"SC-{suffix}", name=f"Вымышленная дисциплина {suffix}")
        building = Building(name=f"Вымышленный корпус {suffix}")
        session.add_all([*groups, term, discipline, building])
        session.flush()
        offering = CourseOffering(
            discipline_id=discipline.id, term_id=term.id, attestation_type="exam"
        )
        room = Room(name="205", building_id=building.id)
        second_room = Room(name="206", building_id=building.id)
        teacher = Teacher(full_name=f"Вымышленный преподаватель {suffix}")
        session.add_all([offering, room, second_room, teacher])
        session.flush()
        session.add_all(
            [
                *(
                    CourseGroup(course_offering_id=offering.id, group_id=group.id)
                    for group in groups
                ),
                *(
                    TeachingAssignment(
                        course_offering_id=offering.id, group_id=group.id, teacher_id=teacher.id
                    )
                    for group in groups
                ),
            ]
        )
        subgroups = [Subgroup(group_id=groups[0].id, name=name) for name in ("А", "Б")]
        session.add_all(subgroups)
        password_hash = PASSWORD_HASHER.hash(password)
        staff_users = [
            User(
                login=login,
                password_hash=password_hash,
                full_name=f"Вымышленный сотрудник {index}",
                role="staff",
                is_active=True,
            )
            for index, login in enumerate(logins, 1)
        ]
        session.add_all(staff_users)
        student_user = User(
            login=f"staff-schedule-student-{suffix}",
            password_hash=password_hash,
            full_name="Вымышленный студент браузерного сценария",
            role="student",
            is_active=True,
        )
        session.add(student_user)
        session.flush()
        session.add(
            Student(user_id=student_user.id, group_id=groups[1].id, academic_status="enrolled")
        )
        profiles = [StaffProfile(user_id=user.id, org_unit_id=office.id) for user in staff_users]
        session.add_all(profiles)
        session.flush()
        session.add_all(
            StaffPermission(staff_profile_id=profile.id, permission_code="schedule.edit")
            for profile in profiles[:2]
        )
        lesson = Lesson(
            course_offering_id=offering.id,
            teacher_id=teacher.id,
            starts_at=starts_at,
            ends_at=starts_at + timedelta(minutes=90),
            kind="lecture",
            created_by_user_id=staff_users[0].id,
        )
        session.add(lesson)
        session.flush()
        session.add_all(
            [
                LessonGroup(lesson_id=lesson.id, group_id=groups[0].id),
                LessonRoom(lesson_id=lesson.id, room_id=room.id),
            ]
        )
        session.flush()
        values = {
            "STAFF_SCHEDULE_LOGIN": logins[0],
            "STAFF_SCHEDULE_SECOND_LOGIN": logins[1],
            "STAFF_SCHEDULE_NO_PERMISSION_LOGIN": logins[2],
            "STAFF_SCHEDULE_STUDENT_LOGIN": student_user.login,
            "STAFF_SCHEDULE_PASSWORD": password,
            "STAFF_SCHEDULE_GROUP": groups[0].name,
            "STAFF_SCHEDULE_SECOND_GROUP": groups[1].name,
            "STAFF_SCHEDULE_SECOND_ROOM": second_room.name,
            "STAFF_SCHEDULE_DATE": moscow_today.isoformat(),
            "STAFF_SCHEDULE_LESSON": str(lesson.id),
            "STAFF_SCHEDULE_SUFFIX": suffix,
        }
    for key, value in values.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
