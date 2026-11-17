"""Exercise PostgreSQL upgrade and API on a populated pre-subgroup schema."""

from unittest.mock import patch

import pytest
from sqlalchemy import MetaData, Table, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, registry
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_audit_migrations import RBAC_SNAPSHOT, add_staff_permission
from test_schedule_integration import schedule as create_schedule

from app.models import Subgroup

pytestmark = pytest.mark.integration

SNAPSHOT = """SELECT jsonb_build_array(
    (SELECT jsonb_agg((to_jsonb(s) - 'membership_version' - 'membership_changed_at')
     - 'subgroup_id' ORDER BY id) FROM students s),
    (SELECT jsonb_agg(to_jsonb(g) - 'subgroup_id' ORDER BY id) FROM lesson_groups g),
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM lessons l))"""


def test_upgrade_preserves_old_students_assignments_moves_and_api(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261114_02")
    with engine.begin() as connection:
        staff_id = connection.scalar(
            text(
                "INSERT INTO users(login,password_hash,full_name,role,is_active) "
                "VALUES ('subgroup-migration-staff','unused','Fictional Staff','staff',true) "
                "RETURNING id"
            )
        )
        org_id = connection.scalar(
            text("INSERT INTO org_units(name,type) VALUES ('Fictional','dean_office') RETURNING id")
        )
        connection.execute(
            text(
                "INSERT INTO audit_events(actor_user_id,entity_type,entity_id,action) "
                "VALUES (:actor,'migration_fixture',1,'fixture')"
            ),
            {"actor": staff_id},
        )
    add_staff_permission(engine, staff_id, org_id)
    mapper = registry()

    class LegacyStudent:
        pass

    class LegacyLessonGroup:
        pass

    for model, table in [(LegacyStudent, "students"), (LegacyLessonGroup, "lesson_groups")]:
        mapper.map_imperatively(model, Table(table, MetaData(), autoload_with=engine))
    with Session(engine, expire_on_commit=False) as db:
        # Patch fixture constructors only: all persistence/API/migrations use PostgreSQL.
        with (
            patch("test_schedule_integration.Student", LegacyStudent),
            patch("test_schedule_integration.LessonGroup", LegacyLessonGroup),
        ):
            s = create_schedule.__wrapped__(db)
            root = s.lesson(status="moved", assigned=s.groups)
            terminal = s.lesson("2026-12-20T09:00:00+03:00", previous_lesson_id=root.id)
            cancelled = s.lesson(status="cancelled")
            db.commit()
        with engine.connect() as connection:
            before = connection.scalar(text(SNAPSHOT))
            rbac_before = connection.scalar(RBAC_SNAPSHOT)
            audit_before = connection.scalar(
                text("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_events a")
            )
            legacy_functions = [
                connection.scalar(
                    text("SELECT pg_get_functiondef(to_regprocedure(:name))"), {"name": name + "()"}
                )
                for name in ("preserve_assessment_assignment", "validate_assessment_assignment")
            ]
        with engine.connect().execution_options(isolation_level="REPEATABLE READ") as stale:
            stale.execute(text("SELECT * FROM lessons"))
            run_migration(engine, "upgrade", "head")
            with pytest.raises(DBAPIError) as rejected:
                stale.execute(
                    text("UPDATE lessons SET version=version WHERE id=:id"), {"id": root.id}
                )
            assert rejected.value.orig.sqlstate == "40001"
            stale.rollback()
        run_migration(engine, "upgrade", "head")
        run_migration(engine, "check")
        with engine.connect() as connection:
            assert connection.scalar(text(SNAPSHOT)) == before
            for table in ("students", "lesson_groups"):
                assert (
                    connection.scalar(
                        text(f"SELECT count(*) FROM {table} WHERE subgroup_id IS NOT NULL")
                    )
                    == 0
                )
        response = s.request()
        assert response.status_code == 200
        items = response.json()["items"]
        assert [i["id"] for i in items] == [str(root.id), str(cancelled.id)]
        assert items[0]["latest_lesson"]["id"] == str(terminal.id)
        assert len(items[0]["groups"]) == 2
        assert s.request(1).json()["items"][0]["id"] == str(root.id)
        assert s.request(start="2026-12-20").json()["items"][0]["previous_lesson"]["id"] == str(
            root.id
        )
        db.rollback()  # Release API read transaction before DDL.
        run_migration(engine, "downgrade", "20261114_02")
        with engine.connect() as connection:
            assert connection.scalar(text(SNAPSHOT)) == before
            restored_functions = [
                connection.scalar(
                    text("SELECT pg_get_functiondef(to_regprocedure(:name))"), {"name": name + "()"}
                )
                for name in ("preserve_assessment_assignment", "validate_assessment_assignment")
            ]
            assert restored_functions == legacy_functions
            assert connection.scalar(RBAC_SNAPSHOT) == rbac_before
            assert (
                connection.scalar(
                    text("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_events a")
                )
                == audit_before
            )
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version")) == "20261114_02"
            )
        run_migration(engine, "upgrade", "head")
        with engine.connect() as connection:
            assert connection.scalar(text(SNAPSHOT)) == before


def test_downgrade_rejects_populated_distribution_without_losing_data(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "head")
    with Session(engine) as db:
        s = create_schedule.__wrapped__(db)
        subgroup = s.add(Subgroup, group_id=s.groups[0].id, name="А")
        s.students[0].subgroup_id = subgroup.id
        db.commit()
    result = run_migration(engine, "downgrade", "20261114_02", success=False)
    assert "Cannot downgrade populated subgroups" in result.stderr
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "20261116_09"
        assert (
            connection.scalar(text("SELECT count(*) FROM students WHERE subgroup_id IS NOT NULL"))
            == 1
        )
        assert connection.scalar(text("SELECT count(*) FROM subgroups")) == 1
