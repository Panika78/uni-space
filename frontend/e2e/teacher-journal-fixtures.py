"""Seed fictional, disposable journal E2E fixtures in uni_space_test only."""

import os
import stat
import sys
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.engine import make_url

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    Attendance,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    Lesson,
    LessonGroup,
    OrgUnit,
    Program,
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
    mode = sys.argv[1] if len(sys.argv) > 1 else "seed"
    if mode == "seed" and (
        not stat.S_ISREG(os.fstat(1).st_mode)
        or stat.S_IMODE(os.fstat(1).st_mode) != 0o600
    ):
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

    if mode in {"prepare-announcement-transfer", "transfer-announcement-student"}:
        course_id = int(os.environ["TEACHER_JOURNAL_COURSE_A"])
        group_id = int(os.environ["TEACHER_JOURNAL_GROUP_B"])
        with SessionLocal.begin() as db:
            if mode == "prepare-announcement-transfer":
                db.add(CourseGroup(course_offering_id=course_id, group_id=group_id))
            else:
                student = db.get(Student, int(os.environ["TEACHER_JOURNAL_STUDENT_A"]))
                if student is None:
                    raise SystemExit("Student fixture not found")
                student.group_id = group_id
        return

    if mode == "staff-transfer":
        with SessionLocal.begin() as db:
            student = db.get(Student, int(os.environ["TEACHER_JOURNAL_STUDENT_C"]))
            student.group_id = int(os.environ["TEACHER_JOURNAL_GROUP_B"])
        return
    if mode in {"staff-revoke", "staff-revoke-attendance"}:
        login_key = (
            "JOURNAL_GRADES_LOGIN"
            if mode == "staff-revoke"
            else "JOURNAL_ATTENDANCE_LOGIN"
        )
        with SessionLocal.begin() as db:
            profile = db.scalar(
                select(StaffProfile)
                .join(User, User.id == StaffProfile.user_id)
                .where(User.login == os.environ[login_key])
            )
            db.execute(
                delete(StaffPermission).where(
                    StaffPermission.staff_profile_id == profile.id
                )
            )
        return

    if mode == "revoke":
        login = os.environ.get("TEACHER_JOURNAL_LOGIN_A")
        course_id = int(os.environ["TEACHER_JOURNAL_COURSE_A"])
        group_id = int(os.environ["TEACHER_JOURNAL_GROUP_A"])
        with SessionLocal.begin() as db:
            user = db.scalar(select(User).where(User.login == login))
            teacher = (
                db.scalar(select(Teacher).where(Teacher.user_id == user.id))
                if user
                else None
            )
            if teacher is None:
                raise SystemExit("Teacher fixture not found")
            db.execute(
                delete(TeachingAssignment).where(
                    TeachingAssignment.teacher_id == teacher.id,
                    TeachingAssignment.course_offering_id == course_id,
                    TeachingAssignment.group_id == group_id,
                )
            )
        return
    if mode == "verify-retake":
        course_id = int(os.environ["TEACHER_JOURNAL_COURSE_A"])
        student_id = int(os.environ["TEACHER_JOURNAL_STUDENT_A"])
        with SessionLocal() as db:
            final = db.scalar(
                select(FinalResult).where(
                    FinalResult.course_offering_id == course_id,
                    FinalResult.student_id == student_id,
                )
            )
            if (
                final is None
                or final.grade_value != 2
                or final.retake_date != date(2027, 1, 10)
                or final.retake_location != "A-101"
            ):
                raise SystemExit(
                    "Expected retake values were not persisted in PostgreSQL"
                )
        return
    if mode != "seed":
        raise SystemExit("Supported modes are seed, revoke, and verify-retake")

    suffix = uuid4().hex[:10]
    password = "Fictional-Teacher-Journal-E2E-2026"
    names = ["journal-teacher-a", "journal-teacher-b"]
    logins = [f"{name}-{suffix}" for name in names]
    moscow = ZoneInfo("Europe/Moscow")
    now = datetime.now(moscow)
    starts_at = (now - timedelta(days=2)).replace(minute=0, second=0, microsecond=0)
    lesson_day = starts_at.date()
    today_starts_at = now.replace(minute=0, second=0, microsecond=0)
    # New roster rows still need to be editable for older lessons in the same group.
    membership_changed_at = today_starts_at
    future_starts_at = (now + timedelta(days=1)).replace(minute=0, second=0, microsecond=0)

    with SessionLocal.begin() as db:
        faculty = OrgUnit(
            name=f"Вымышленный факультет журнала {suffix}", type="faculty"
        )
        db.add(faculty)
        db.flush()
        program = Program(
            code=f"JOURNAL-{suffix}",
            name="Вымышленная программа журнала",
            direction_code="00.00",
            direction_name="Вымышленное направление",
            faculty_id=faculty.id,
        )
        term = AcademicTerm(
            name=f"Вымышленный семестр {suffix}",
            starts_on=date(2000, 1, 1),
            ends_on=date(2100, 12, 31),
        )
        discipline_a = Discipline(code=f"JA-{suffix}", name=f"Алгебра {suffix}")
        discipline_b = Discipline(code=f"JB-{suffix}", name=f"История {suffix}")
        db.add_all([program, term, discipline_a, discipline_b])
        db.flush()
        groups = [
            StudyGroup(
                name=(
                    f"Вымышленная учебная группа {suffix} №{index} с очень длинным названием "
                    "для проверки переноса и мобильной навигации"
                    if index == 1
                    else f"JOURNAL-{suffix}-{index}"
                ),
                program_id=program.id,
                course_number=1,
            )
            for index in (1, 2)
        ]
        db.add_all(groups)
        db.flush()
        users = [
            User(
                login=login,
                password_hash=PASSWORD_HASHER.hash(password),
                full_name=f"Вымышленный преподаватель {suffix}-{index}",
                role="teacher",
                is_active=True,
            )
            for index, login in enumerate(logins, 1)
        ]
        db.add_all(users)
        db.flush()
        teachers = [
            Teacher(user_id=user.id, full_name=user.full_name) for user in users
        ]
        db.add_all(teachers)
        db.flush()
        courses = [
            CourseOffering(
                discipline_id=discipline_a.id, term_id=term.id, attestation_type="exam"
            ),
            CourseOffering(
                discipline_id=discipline_b.id,
                term_id=term.id,
                attestation_type="pass_fail",
            ),
        ]
        db.add_all(courses)
        db.flush()
        db.add_all(
            [
                CourseGroup(
                    course_offering_id=courses[index].id, group_id=groups[index].id
                )
                for index in (0, 1)
            ]
        )
        db.add_all(
            [
                TeachingAssignment(
                    course_offering_id=courses[index].id,
                    group_id=groups[index].id,
                    teacher_id=teachers[index].id,
                )
                for index in (0, 1)
            ]
        )
        subgroup = Subgroup(group_id=groups[0].id, name="А")
        db.add(subgroup)
        db.flush()

        students: list[Student] = []
        student_names = ["Анна Иванова", "Ёлкин Борис", "Мария Петрова"]
        for index, full_name in enumerate(student_names):
            user = User(
                login=f"journal-student-{index}-{suffix}",
                password_hash=PASSWORD_HASHER.hash(password),
                full_name=full_name,
                role="student",
                is_active=True,
            )
            db.add(user)
            db.flush()
            student = Student(
                user_id=user.id,
                group_id=groups[0].id,
                subgroup_id=subgroup.id if index == 1 else None,
                academic_status="enrolled",
                membership_changed_at=membership_changed_at,
            )
            db.add(student)
            students.append(student)
        student_b_user = User(
            login=f"journal-student-b-{suffix}",
            password_hash=PASSWORD_HASHER.hash(password),
            full_name=f"Вымышленная студентка группы Б {suffix}",
            role="student",
            is_active=True,
        )
        db.add(student_b_user)
        db.flush()
        student_b = Student(
            user_id=student_b_user.id,
            group_id=groups[1].id,
            academic_status="enrolled",
            membership_changed_at=membership_changed_at,
        )
        db.add(student_b)

        lessons = [
            Lesson(
                course_offering_id=courses[index].id,
                teacher_id=teachers[index].id,
                starts_at=starts_at,
                ends_at=starts_at + timedelta(minutes=90),
                kind="seminar",
                created_by_user_id=users[index].id,
            )
            for index in (0, 1)
        ]
        lessons.extend(
            [
                Lesson(
                    course_offering_id=courses[0].id,
                    teacher_id=teachers[0].id,
                    starts_at=today_starts_at,
                    ends_at=today_starts_at + timedelta(minutes=90),
                    kind="lecture",
                    created_by_user_id=users[0].id,
                ),
                Lesson(
                    course_offering_id=courses[0].id,
                    teacher_id=teachers[0].id,
                    starts_at=future_starts_at,
                    ends_at=future_starts_at + timedelta(minutes=90),
                    kind="seminar",
                    created_by_user_id=users[0].id,
                ),
            ]
        )
        db.add_all(lessons)
        db.flush()
        db.add_all(
            [
                LessonGroup(lesson_id=lessons[index].id, group_id=groups[0 if index >= 2 else index].id)
                for index in (0, 1, 2, 3)
            ]
        )
        subgroup_lesson = Lesson(
            course_offering_id=courses[0].id,
            teacher_id=teachers[0].id,
            starts_at=starts_at - timedelta(minutes=30),
            ends_at=starts_at + timedelta(minutes=60),
            kind="lab",
            created_by_user_id=users[0].id,
        )
        db.add(subgroup_lesson)
        db.flush()
        db.add(
            LessonGroup(
                lesson_id=subgroup_lesson.id,
                group_id=groups[0].id,
                subgroup_id=subgroup.id,
            )
        )

        assessment = Assessment(
            course_offering_id=courses[0].id,
            title="Контрольная работа",
            type="test",
            max_score=10,
            description="Вымышленная работа для E2E",
            created_by_user_id=users[0].id,
        )
        assessment_a2 = Assessment(
            course_offering_id=courses[0].id,
            title="Повторная контрольная",
            type="test",
            max_score=10,
            description="Вторая вымышленная работа для E2E",
            created_by_user_id=users[0].id,
        )
        assessment_b = Assessment(
            course_offering_id=courses[1].id,
            title="Тест по истории",
            type="test",
            max_score=5,
            created_by_user_id=users[1].id,
        )
        db.add_all([assessment, assessment_a2, assessment_b])
        db.flush()
        groups_of_assessments = [
            AssessmentGroup(
                assessment_id=assessment.id,
                group_id=groups[0].id,
                planned_date=lesson_day + timedelta(days=1),
                date_needs_confirmation=True,
            ),
            AssessmentGroup(
                assessment_id=assessment_a2.id,
                group_id=groups[0].id,
                planned_date=lesson_day + timedelta(days=2),
            ),
            AssessmentGroup(
                assessment_id=assessment_b.id,
                group_id=groups[1].id,
                planned_date=lesson_day + timedelta(days=1),
            ),
        ]
        db.add_all(groups_of_assessments)
        db.flush()
        db.add_all(
            [
                AssessmentResult(
                    assessment_group_id=groups_of_assessments[0].id,
                    student_id=students[1].id,
                    score=0,
                    graded_by_user_id=users[0].id,
                    graded_at=datetime.now(UTC),
                ),
                Attendance(
                    lesson_id=lessons[0].id,
                    student_id=students[0].id,
                    origin_group_id=groups[0].id,
                    membership_version=students[0].membership_version,
                    status="attended",
                    marked_by_user_id=users[0].id,
                ),
                Attendance(
                    lesson_id=lessons[0].id,
                    student_id=students[1].id,
                    origin_group_id=groups[0].id,
                    origin_subgroup_id=subgroup.id,
                    membership_version=students[1].membership_version,
                    status="absent",
                    marked_by_user_id=users[0].id,
                ),
            ]
        )

        dean_office = OrgUnit(name=f"Вымышленный деканат {suffix}", type="dean_office")
        db.add(dean_office)
        db.flush()
        staff_logins = {}
        for label, grants in {
            "GRADES": ("grades.edit",),
            "ATTENDANCE": ("attendance.edit",),
            "BOTH": ("grades.edit", "attendance.edit"),
            "STUDENTS_READ": ("students.read",),
            "ADMIN": (),
        }.items():
            login = f"staff-journal-{label.lower()}-{suffix}"
            account = User(
                login=login,
                password_hash=users[0].password_hash,
                full_name=f"Вымышленный сотрудник {label}",
                role="staff" if grants else "admin",
                is_active=True,
            )
            db.add(account)
            db.flush()
            if grants:
                profile = StaffProfile(user_id=account.id, org_unit_id=dean_office.id)
                db.add(profile)
                db.flush()
                db.add_all(
                    StaffPermission(staff_profile_id=profile.id, permission_code=code)
                    for code in grants
                )
            staff_logins[f"JOURNAL_{label}_LOGIN"] = login

        values = {
            **staff_logins,
            "JOURNAL_STUDENT_LOGIN": student_b_user.login,
            "TEACHER_JOURNAL_LOGIN_A": logins[0],
            "TEACHER_JOURNAL_LOGIN_B": logins[1],
            "TEACHER_JOURNAL_PASSWORD": password,
            "TEACHER_JOURNAL_COURSE_A": str(courses[0].id),
            "TEACHER_JOURNAL_GROUP_A": str(groups[0].id),
            "TEACHER_JOURNAL_LESSON_A": str(lessons[0].id),
            "TEACHER_JOURNAL_LESSON_TODAY": str(lessons[2].id),
            "TEACHER_JOURNAL_LESSON_FUTURE": str(lessons[3].id),
            "TEACHER_JOURNAL_SUBGROUP_LESSON": str(subgroup_lesson.id),
            "TEACHER_JOURNAL_ASSESSMENT_A": str(groups_of_assessments[0].id),
            "TEACHER_JOURNAL_ASSESSMENT_A2": str(groups_of_assessments[1].id),
            "TEACHER_JOURNAL_COURSE_B": str(courses[1].id),
            "TEACHER_JOURNAL_GROUP_B": str(groups[1].id),
            "TEACHER_JOURNAL_LESSON_B": str(lessons[1].id),
            "TEACHER_JOURNAL_ASSESSMENT_B": str(groups_of_assessments[2].id),
            "TEACHER_JOURNAL_STUDENT_LOGIN": f"journal-student-0-{suffix}",
            "TEACHER_JOURNAL_STUDENT_A": str(students[0].id),
            "TEACHER_JOURNAL_STUDENT_B": str(students[1].id),
            "TEACHER_JOURNAL_STUDENT_C": str(students[2].id),
            "TEACHER_JOURNAL_FOREIGN_STUDENT": str(student_b.id),
            "TEACHER_JOURNAL_DATE": lesson_day.isoformat(),
            "TEACHER_JOURNAL_TODAY_DATE": today_starts_at.date().isoformat(),
            "TEACHER_JOURNAL_FUTURE_DATE": future_starts_at.date().isoformat(),
            "TEACHER_JOURNAL_TODAY": now.date().isoformat(),
            "TEACHER_JOURNAL_SUFFIX": suffix,
        }
    for key, value in values.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
