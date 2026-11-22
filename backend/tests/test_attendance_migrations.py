import pytest
from sqlalchemy import inspect, text
from test_academics_migrations import migration_database, run_migration  # noqa: F401

pytestmark = pytest.mark.integration


def test_attendance_upgrade_downgrade_preserves_mvp1(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261115_03")
    with engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO users(login,password_hash,full_name,role,is_active) "
                "VALUES ('attendance-migration','unused','Fictional','student',true)"
            )
        )
        before = db.scalar(text("SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u"))
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    inspector = inspect(engine)
    assert inspector.get_pk_constraint("attendance")["constrained_columns"] == [
        "lesson_id",
        "student_id",
    ]
    assert {
        tuple(fk["constrained_columns"]) for fk in inspector.get_foreign_keys("attendance")
    } == {
        ("lesson_id",),
        ("student_id",),
        ("marked_by_user_id",),
        ("origin_group_id",),
        ("origin_group_id", "origin_subgroup_id"),
    }
    run_migration(engine, "downgrade", "20261115_03")
    assert "attendance" not in inspect(engine).get_table_names()
    with engine.connect() as db:
        assert db.scalar(text("SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u")) == before
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")


def test_origin_upgrade_preserves_unknown_legacy_marks_and_downgrade(migration_database):  # noqa: F811
    from datetime import UTC, datetime, timedelta

    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session
    from test_academics_migrations import seed_old_academics

    from app.attendance.router import router as attendance_router
    from app.auth.security import create_access_token
    from app.dependencies.database import get_db_session
    from app.models import AuthSession, Lesson, LessonGroup, Teacher, TeachingAssignment, User
    from app.teaching.router import router as teaching_router

    engine = migration_database
    run_migration(engine, "upgrade", "20261116_02")
    with Session(engine) as db:
        s = seed_old_academics(db)
        first_student_id = s.students[0].id
        first_student_group_id = s.students[0].group_id
        target_student_id = s.students[2].id
        initial_join = datetime.now(UTC) - timedelta(days=30)
        lesson_start = datetime.now(UTC) - timedelta(days=20)
        db.execute(
            text("UPDATE users SET created_at=:created WHERE id = ANY(:ids)"),
            {"created": initial_join, "ids": [student.user_id for student in s.students]},
        )
        course = s.offering()
        course_id = course.id
        lesson = s.add(
            Lesson,
            course_offering_id=course.id,
            starts_at=lesson_start,
            ends_at=lesson_start + timedelta(hours=1),
            kind="lab",
        )
        lesson_id = lesson.id
        s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id)
        db.execute(
            text(
                "INSERT INTO attendance(lesson_id,student_id,status,marked_by_user_id) "
                "VALUES (:lesson,:student,'attended',:actor)"
            ),
            {"lesson": lesson.id, "student": s.students[0].id, "actor": s.users[0].id},
        )
        db.commit()
    snapshot = text(
        "SELECT jsonb_agg(to_jsonb(a) - 'origin_group_id' - 'origin_subgroup_id' "
        "- 'membership_version' ORDER BY lesson_id,student_id) FROM attendance a"
    )
    with engine.connect() as db:
        before = db.scalar(snapshot)
    run_migration(engine, "upgrade", "20261116_03")
    # Recreate the already-deployed clock-based backfill that affected existing
    # installations, then verify the forward repair migration fixes it.
    with engine.begin() as db:
        db.execute(text("ALTER TABLE students DISABLE TRIGGER track_student_membership"))
        db.execute(text("UPDATE students SET membership_changed_at=clock_timestamp()"))
        db.execute(text("ALTER TABLE students ENABLE TRIGGER track_student_membership"))
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
        # This lesson and the roster existed before the membership migration.
        # The boundary must come from initial user creation, not migration time.
        boundary = db.scalar(
            text("SELECT membership_changed_at FROM students WHERE id=:id"),
            {"id": first_student_id},
        )
        assert boundary == initial_join
        assert boundary < lesson_start
        assert db.scalar(snapshot) == before
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM attendance WHERE origin_group_id IS NULL "
                    "AND origin_subgroup_id IS NULL AND membership_version IS NULL"
                )
            )
            == 1
        )
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM students WHERE membership_version=0 "
                    "AND membership_changed_at IS NOT NULL"
                )
            )
            == 3
        )
        assert db.scalar(text("SELECT count(*) FROM audit_events")) == 0

    # Exercise the teacher write endpoint against the migrated, pre-existing
    # lesson and roster. This proves the repaired DB boundary reaches the API.
    with Session(engine) as db:
        teacher_user = User(
            login="pre-migration-attendance-teacher",
            password_hash="unused",
            full_name="Вымышленный преподаватель",
            role="teacher",
            is_active=True,
        )
        db.add(teacher_user)
        db.flush()
        teacher = Teacher(user_id=teacher_user.id, full_name=teacher_user.full_name)
        db.add(teacher)
        db.flush()
        db.add(
            TeachingAssignment(
                teacher_id=teacher.id,
                course_offering_id=course_id,
                group_id=first_student_group_id,
            )
        )
        auth_session = AuthSession(
            user_id=teacher_user.id, expires_at=datetime.now(UTC) + timedelta(hours=1)
        )
        db.add(auth_session)
        db.commit()
        token = create_access_token(auth_session, s.settings)["access_token"]
        s.app.dependency_overrides[get_db_session] = lambda: db
        s.app.include_router(teaching_router)
        s.app.include_router(attendance_router)
        headers = {"Authorization": f"Bearer {token}"}
        with TestClient(s.app) as client:
            read = client.get(
                f"/api/v1/teaching/courses/{course_id}/groups/{first_student_group_id}"
                f"/lessons/{lesson_id}/attendance",
                headers=headers,
            )
            assert read.status_code == 200, read.text
            row = next(
                item
                for item in read.json()["items"]
                if item["student_id"] == str(target_student_id)
            )
            assert row["can_edit"] is True
            write = client.put(
                f"/api/v1/attendance/lessons/{lesson_id}/students/{target_student_id}",
                headers=headers,
                json={"status": "absent"},
            )
            assert write.status_code == 200, write.text
            assert write.json()["status"] == "absent"
            db.expire_all()
            assert (
                db.scalar(
                    text(
                        "SELECT status FROM attendance "
                        "WHERE lesson_id=:lesson AND student_id=:student"
                    ),
                    {"lesson": lesson_id, "student": target_student_id},
                )
                == "absent"
            )
    with engine.connect() as db:
        after_saved_attendance = db.scalar(snapshot)
    run_migration(engine, "downgrade", "20261116_02")
    with engine.connect() as db:
        assert db.scalar(snapshot) == after_saved_attendance
        assert db.scalar(text("SELECT to_regprocedure('track_student_membership()')")) is None
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")


def test_demo_membership_upgrade_repairs_only_initial_verified_profiles(migration_database):  # noqa: F811
    from datetime import UTC, date, datetime

    from sqlalchemy.orm import Session

    from app.models import AcademicTerm, OrgUnit, Program, Student, StudyGroup, User

    engine = migration_database
    run_migration(engine, "upgrade", "20261121_01")
    with Session(engine) as db:
        faculty = OrgUnit(name="Факультет естественных наук", type="faculty")
        db.add(faculty)
        db.flush()
        programs = {}
        groups = {}
        for code, group_name in (("ПЗ", "ПЗ-101"), ("ПМ", "ПМ-201")):
            program = Program(
                code=code,
                name="Тестовая программа",
                direction_code=f"TEST-{code}",
                direction_name="Тестовое направление",
                faculty_id=faculty.id,
            )
            db.add(program)
            db.flush()
            programs[code] = program
            group = StudyGroup(name=group_name, program_id=program.id, course_number=1)
            db.add(group)
            db.flush()
            groups[code] = group
        other_group = StudyGroup(
            name="Другая группа", program_id=programs["ПМ"].id, course_number=1
        )
        db.add(other_group)
        db.add(
            AcademicTerm(
                name="Осенний семестр 2026/2027",
                starts_on=date(2026, 9, 1),
                ends_on=date(2027, 1, 31),
            )
        )
        db.flush()

        profiles = {}
        for login, name, code in (
            ("demo-pz101", "Иван Сергеевич Гончаров", "ПЗ"),
            ("demo-pm201", "Амели Викторовна Волкова", "ПМ"),
            ("ordinary-student", "Вымышленный студент", "ПЗ"),
        ):
            user = User(
                login=login,
                password_hash="test-only",
                full_name=name,
                role="student",
                is_active=True,
            )
            db.add(user)
            db.flush()
            student = Student(
                user_id=user.id, group_id=groups[code].id, academic_status="enrolled"
            )
            db.add(student)
            db.flush()
            profiles[login] = student

        # A genuine transfer away and back must remain protected even when
        # the current group and the demo identity match the migration target.
        transferred = profiles["demo-pm201"]
        transferred.group_id = other_group.id
        db.flush()
        transferred.group_id = groups["ПМ"].id
        db.flush()
        for profile in profiles.values():
            db.refresh(profile)
        assert transferred.membership_version == 2
        before = {
            login: (profile.membership_changed_at, profile.membership_version)
            for login, profile in profiles.items()
        }
        ids = {login: profile.id for login, profile in profiles.items()}
        db.commit()

    run_migration(engine, "upgrade", "head")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with Session(engine) as db:
        repaired = {login: db.get(Student, student_id) for login, student_id in ids.items()}
        assert repaired["demo-pz101"].membership_changed_at == datetime(
            2026, 8, 31, 21, tzinfo=UTC
        )
        assert repaired["demo-pz101"].membership_version == 0
        assert (
            repaired["demo-pm201"].membership_changed_at,
            repaired["demo-pm201"].membership_version,
        ) == before["demo-pm201"]
        assert (
            repaired["ordinary-student"].membership_changed_at,
            repaired["ordinary-student"].membership_version,
        ) == before["ordinary-student"]
        # The membership trigger still protects subsequent real transfers.
        repaired["demo-pz101"].group_id = other_group.id
        db.flush()
        db.refresh(repaired["demo-pz101"])
        assert repaired["demo-pz101"].membership_version == 1
        assert repaired["demo-pz101"].membership_changed_at > datetime(
            2026, 8, 31, 21, tzinfo=UTC
        )
