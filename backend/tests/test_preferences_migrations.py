import pytest
from sqlalchemy import inspect, text
from test_academics_migrations import migration_database, run_migration  # noqa: F401

pytestmark = pytest.mark.integration


def test_preferences_upgrade_downgrade_and_metadata(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261114_03")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    assert "user_preferences" in inspect(engine).get_table_names()
    with engine.begin() as db:
        user = db.scalar(
            text(
                "INSERT INTO users(login,password_hash,full_name,role,is_active) "
                "VALUES ('preferences-migration','unused','Fictional','student',true) RETURNING id"
            )
        )
        db.execute(
            text(
                "INSERT INTO user_preferences(user_id,preferences) VALUES "
                "(:id, '{\"show_cancelled_lessons\": false}'::jsonb)"
            ),
            {"id": user},
        )
    run_migration(engine, "downgrade", "20261114_03")
    assert "user_preferences" not in inspect(engine).get_table_names()
    with engine.connect() as db:
        assert db.scalar(text("SELECT count(*) FROM users WHERE id=:id"), {"id": user}) == 1
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
