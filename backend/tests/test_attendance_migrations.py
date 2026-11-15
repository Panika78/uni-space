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
    }
    run_migration(engine, "downgrade", "20261115_03")
    assert "attendance" not in inspect(engine).get_table_names()
    with engine.connect() as db:
        assert db.scalar(text("SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u")) == before
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
