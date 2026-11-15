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

    from sqlalchemy.orm import Session
    from test_academics_migrations import seed_old_academics

    from app.models import Lesson

    engine = migration_database
    run_migration(engine, "upgrade", "20261115_04")
    with Session(engine) as db:
        s = seed_old_academics(db)
        course = s.offering()
        lesson = s.add(
            Lesson,
            course_offering_id=course.id,
            starts_at=datetime.now(UTC) - timedelta(days=1),
            ends_at=datetime.now(UTC) - timedelta(hours=23),
            kind="lab",
        )
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
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
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
    run_migration(engine, "downgrade", "20261115_04")
    with engine.connect() as db:
        assert db.scalar(snapshot) == before
        assert db.scalar(text("SELECT to_regprocedure('track_student_membership()')")) is None
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
