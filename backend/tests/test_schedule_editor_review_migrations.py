"""Upgrade populated #117 databases without rewriting already applied revisions."""

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_schedule_integration import schedule as schedule_fixture

pytestmark = pytest.mark.integration
SNAPSHOT = text("""SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lessons t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lesson_groups t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY lesson_id,room_id) FROM lesson_rooms t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY course_offering_id,group_id) FROM course_groups t))""")


def test_forward_upgrade_preserves_schedule_and_installs_link_versions(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261116_04")
    with Session(engine) as db:
        s = schedule_fixture.__wrapped__(db)
        lesson = s.lesson(room_ids=[s.rooms[0].id])
        lesson_id, room_id = lesson.id, s.rooms[0].id
        db.commit()
    with engine.connect() as c:
        before = c.scalar(SNAPSHOT)
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.begin() as c:
        assert c.scalar(SNAPSHOT) == before
        c.execute(text("DELETE FROM lesson_rooms WHERE lesson_id=:l"), {"l": lesson_id})
        assert c.scalar(text("SELECT version FROM lessons WHERE id=:l"), {"l": lesson_id}) == 2
    run_migration(engine, "downgrade", "20261116_04")
    with engine.begin() as c:
        c.execute(
            text("INSERT INTO lesson_rooms(lesson_id,room_id) VALUES (:l,:r)"),
            {"l": lesson_id, "r": room_id},
        )
        assert c.scalar(text("SELECT version FROM lessons WHERE id=:l"), {"l": lesson_id}) == 2
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")


def test_upgrade_rejects_existing_orphan_without_silently_repairing(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261116_04")
    with Session(engine) as db:
        s = schedule_fixture.__wrapped__(db)
        s.lesson()
        db.execute(text("DELETE FROM course_groups WHERE group_id=:g"), {"g": s.groups[0].id})
        db.commit()
    with engine.connect() as c:
        before = c.scalar(SNAPSHOT)
    run_migration(engine, "upgrade", "head", success=False)
    with engine.connect() as c:
        assert c.scalar(SNAPSHOT) == before
        assert c.scalar(text("SELECT version_num FROM alembic_version")) == "20261116_04"
