import pytest
from sqlalchemy import text
from test_academics_migrations import migration_database as isolated_database
from test_academics_migrations import run_migration

pytestmark = pytest.mark.integration


@pytest.fixture
def migration_database(postgresql_engine):
    yield from isolated_database.__wrapped__(postgresql_engine)


def test_rbac_migration_rejects_incompatible_existing_profile_without_repair(migration_database):
    engine = migration_database
    run_migration(engine, "upgrade", "20261112_03")
    with engine.begin() as db:
        user_id = db.scalar(
            text(
                "INSERT INTO users(login,password_hash,full_name,role,is_active) "
                "VALUES ('fictional','unused','Fictional','student',true) RETURNING id"
            )
        )
        db.execute(
            text("INSERT INTO teachers(full_name,user_id) VALUES ('Fictional',:id)"),
            {"id": user_id},
        )
    run_migration(engine, "upgrade", "head", success=False)
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "20261112_03"
        assert db.scalar(text("SELECT count(*) FROM teachers")) == 1
        assert db.scalar(text("SELECT to_regclass('public.staff_profiles')")) is None


def test_rbac_migration_preserves_unlinked_teachers_and_can_round_trip(migration_database):
    engine = migration_database
    run_migration(engine, "upgrade", "20261112_03")
    with engine.begin() as db:
        teacher_id = db.scalar(
            text("INSERT INTO teachers(full_name) VALUES ('Fictional') RETURNING id")
        )
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
        assert (
            db.scalar(text("SELECT full_name FROM teachers WHERE id=:id"), {"id": teacher_id})
            == "Fictional"
        )
    run_migration(engine, "downgrade", "20261112_03")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
