"""Upgrade a populated subgroup schema, preserving MVP1 and audit data."""

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session
from test_academics_integration import academics as create_academics
from test_academics_migrations import migration_database, run_migration  # noqa: F401

pytestmark = pytest.mark.integration

SNAPSHOT = """SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM students s),
 (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM assessment_groups g),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM assessment_results r),
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_events a))"""


def test_upgrade_populated_schema_preserves_results_and_has_single_head(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261114_03")
    with Session(engine) as db:
        s = create_academics.__wrapped__(db)
        work = s.assignment(s.offering())
        s.result(work, 0)
        s.students[0].group_id = s.groups[1].id
        db.commit()
    with engine.connect() as db:
        before = db.scalar(text(SNAPSHOT))
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
        assert db.scalar(text(SNAPSHOT)) == before
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "20261116_01"
    run_migration(engine, "downgrade", "20261114_03")
    with engine.connect() as db:
        assert db.scalar(text(SNAPSHOT)) == before
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
