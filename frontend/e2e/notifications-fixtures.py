"""Real notification acceptance data; disposable localhost PostgreSQL only."""

import json
import sys
from datetime import UTC, datetime, time, timedelta
from uuid import uuid4

from app.auth.security import PASSWORD_HASHER
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import (
    AcademicTerm,
    Application,
    CourseGroup,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    Notification,
    OrgUnit,
    Program,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    Teacher,
    User,
)
from app.schedule.service import MOSCOW
from sqlalchemy import delete, select, update
from sqlalchemy.engine import make_url

PASSWORD = "Fictional-Notification-E2E-2026"


def seed(db):
    suffix = uuid4().hex[:10]

    def add(model, **values):
        row = model(**values)
        db.add(row)
        db.flush()
        return row

    org = add(OrgUnit, name="Вымышленный деканат уведомлений", type="dean_office")
    faculty = add(OrgUnit, name="Вымышленный факультет уведомлений", type="faculty")
    program = add(
        Program,
        code=f"notification-e2e-{suffix}",
        name="Программа уведомлений",
        direction_code="E2E",
        direction_name="Тестовое направление",
        faculty_id=faculty.id,
    )
    groups = [
        add(StudyGroup, name=f"NOTIFY-{i}", program_id=program.id, course_number=1)
        for i in range(2)
    ]
    today = datetime.now(MOSCOW).date()
    term = db.scalar(
        select(AcademicTerm).where(AcademicTerm.starts_on <= today, AcademicTerm.ends_on >= today)
    )
    if term is None:
        term = add(
            AcademicTerm,
            name="Семестр уведомлений",
            starts_on=today - timedelta(days=30),
            ends_on=today + timedelta(days=90),
        )
    password_hash = PASSWORD_HASHER.hash(PASSWORD)
    users = {}
    students = []
    for key, role in [
        ("student", "student"),
        ("other", "student"),
        ("teacher", "teacher"),
        ("staff", "staff"),
        ("admin", "admin"),
        ("empty", "admin"),
    ]:
        user = add(
            User,
            login=f"notification-e2e-{suffix}-{key}",
            role=role,
            full_name=f"Вымышленный пользователь {key}",
            password_hash=password_hash,
            is_active=True,
        )
        users[key] = user
        if role == "student":
            students.append(
                add(
                    Student,
                    user_id=user.id,
                    group_id=groups[len(students)].id,
                    academic_status="enrolled",
                )
            )
        if role == "teacher":
            teacher = add(Teacher, user_id=user.id, full_name=user.full_name)
        if role == "staff":
            profile = add(StaffProfile, user_id=user.id, org_unit_id=org.id)
            add(
                StaffPermission,
                staff_profile_id=profile.id,
                permission_code="applications.review",
                scope_org_unit_id=org.id,
            )
    subject = add(Discipline, name="Дисциплина уведомлений")
    course = add(
        CourseOffering,
        discipline_id=subject.id,
        term_id=term.id,
        attestation_type="exam",
    )
    add(CourseGroup, course_offering_id=course.id, group_id=groups[0].id)
    starts = datetime.combine(today, time(9), MOSCOW)
    lesson = add(
        Lesson,
        course_offering_id=course.id,
        teacher_id=teacher.id,
        starts_at=starts,
        ends_at=starts + timedelta(hours=1),
        kind="seminar",
    )
    add(LessonGroup, lesson_id=lesson.id, group_id=groups[0].id)
    service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
    if service is None:
        service = db.scalar(select(ServiceType).order_by(ServiceType.id))
    application = add(
        Application,
        student_id=students[0].id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="not_required",
        form_data={},
        assigned_org_unit_id=org.id,
    )
    foreign_application = add(
        Application,
        student_id=students[1].id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="not_required",
        form_data={},
        assigned_org_unit_id=org.id,
    )
    ids = {}

    def note(key, owner="student", entity_type=None, entity_id=None):
        row = add(
            Notification,
            user_id=users[owner].id,
            type="future_unknown",
            title=f"NOTIFY {key}",
            body="Личный текст <script>как текст</script>",
            entity_type=entity_type,
            entity_id=entity_id,
            created_at=datetime.now(UTC) - timedelta(seconds=len(ids)),
        )
        ids[key] = str(row.id)

    note("application", entity_type="application", entity_id=application.id)
    note("course", entity_type="course_offering", entity_id=course.id)
    note("lesson", entity_type="lesson", entity_id=lesson.id)
    note("foreign", entity_type="application", entity_id=foreign_application.id)
    note("deleted", entity_type="application", entity_id=9223372036854775807)
    note("unknown", entity_type="https://evil.example", entity_id=course.id)
    note("partial", entity_type="lesson")
    note("general")
    for i in range(22):
        note(f"old-{i:02}")
    for owner in ("teacher", "staff", "admin", "other"):
        note(owner, owner)
    note("review", "staff", "application", application.id)
    return {
        "ids": ids,
        "password": PASSWORD,
        "logins": {key: user.login for key, user in users.items()},
        "application": str(application.id),
        "course": str(course.id),
        "lesson": str(lesson.id),
        "day": today.isoformat(),
        "staff_profile": str(profile.id),
        "student": str(students[0].id),
        "other_group": str(groups[1].id),
    }


def main():
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if (
        settings.app_env != "test"
        or url.database != "uni_space_test"
        or url.username != "uni_space_test"
        or url.host not in ("localhost", "127.0.0.1")
    ):
        raise SystemExit("Requires disposable localhost uni_space_test")
    with SessionLocal.begin() as db:
        if len(sys.argv) == 1:
            print(json.dumps(seed(db)))
        elif sys.argv[1] == "revoke":
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id == int(sys.argv[2]))
            )
        elif sys.argv[1] == "transfer":
            db.execute(
                update(Student)
                .where(Student.id == int(sys.argv[2]))
                .values(group_id=int(sys.argv[3]))
            )
        else:
            raise SystemExit("Expected seed, revoke PROFILE or transfer STUDENT GROUP")


if __name__ == "__main__":
    main()
