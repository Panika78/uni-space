from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from test_academics_migrations import migration_database as migration_database_fixture
from test_academics_migrations import run_migration

from alembic.config import Config
from alembic.script import ScriptDirectory

pytestmark = pytest.mark.integration


@pytest.fixture
def migration_database(postgresql_engine):
    yield from migration_database_fixture.__wrapped__(postgresql_engine)


def test_audit_upgrade_downgrade_preserves_mvp1_rows_and_matches_metadata(migration_database):
    engine = migration_database
    run_migration(engine, "upgrade", "20261112_03")
    with engine.begin() as db:
        user_id = db.scalar(
            text(
                "INSERT INTO users (login, password_hash, full_name, role, is_active) "
                "VALUES ('fictional-audit-migration', 'unusable', "
                "'Fictional User', 'student', true) "
                "RETURNING id"
            )
        )
        before = db.scalar(text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id})
    for _ in range(2):
        run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.begin() as db:
        assert (
            db.scalar(text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id})
            == before
        )
        # Schema permits explicitly defined future system operations with NULL actor;
        # the initial writer contract only exposes authenticated user actions.
        db.execute(
            text(
                "INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action) "
                "VALUES (NULL, 'migration_fixture', 1, 'system_fixture')"
            )
        )
        assert db.scalar(text("SELECT created_at IS NOT NULL FROM audit_events"))
    run_migration(engine, "downgrade", "20261112_03")
    assert "audit_events" not in inspect(engine).get_table_names()
    with engine.connect() as db:
        assert (
            db.scalar(text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id})
            == before
        )
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")


def test_audit_revision_extends_the_single_migration_chain():
    backend = Path(__file__).resolve().parents[1]
    graph = ScriptDirectory.from_config(Config(str(backend / "alembic.ini")))
    assert graph.get_heads() == ["20261114_01"]
    assert graph.get_revision("20261114_01").down_revision == "20261112_03"
