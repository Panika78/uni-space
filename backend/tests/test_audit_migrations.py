import ast
from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from test_academics_migrations import migration_database as migration_database_fixture
from test_academics_migrations import run_migration

from alembic.config import Config
from alembic.script import ScriptDirectory

pytestmark = pytest.mark.integration
RBAC_SNAPSHOT = text("""SELECT jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM org_units o),
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM staff_profiles p),
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM staff_permissions p))""")


@pytest.fixture
def migration_database(postgresql_engine):
    yield from migration_database_fixture.__wrapped__(postgresql_engine)


def add_staff_permission(engine, user_id, org_unit_id):
    with engine.begin() as db:
        profile_id = db.scalar(
            text(
                "INSERT INTO staff_profiles(user_id, org_unit_id) VALUES (:user, :org) RETURNING id"
            ),
            {"user": user_id, "org": org_unit_id},
        )
        db.execute(
            text(
                "INSERT INTO staff_permissions(staff_profile_id, permission_code) "
                "VALUES (:profile, 'students.status.edit')"
            ),
            {"profile": profile_id},
        )


@pytest.mark.parametrize("starting_revision", ["20261112_03", "20261114_01"])
def test_audit_upgrade_and_audit_only_downgrade_preserve_users_and_rbac(
    migration_database, starting_revision
):
    engine = migration_database
    run_migration(engine, "upgrade", starting_revision)
    with engine.begin() as db:
        user_id = db.scalar(
            text(
                "INSERT INTO users (login, password_hash, full_name, role, is_active) "
                "VALUES ('fictional-audit-migration', 'unusable', "
                "'Fictional User', 'staff', true) RETURNING id"
            )
        )
        org_unit_id = db.scalar(
            text(
                "INSERT INTO org_units(name,type) VALUES ('Fictional Dean Office','dean_office') "
                "RETURNING id"
            )
        )
        user_before = db.scalar(
            text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id}
        )
    # Verify both an existing MVP1 database and an already populated RBAC database.
    if starting_revision == "20261114_01":
        add_staff_permission(engine, user_id, org_unit_id)
        with engine.connect() as db:
            before_upgrade = db.scalar(RBAC_SNAPSHOT)
    for _ in range(2):
        run_migration(engine, "upgrade", "20261114_02")
    if starting_revision == "20261112_03":
        add_staff_permission(engine, user_id, org_unit_id)
    with engine.begin() as db:
        assert (
            db.scalar(text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id})
            == user_before
        )
        rbac_before = db.scalar(RBAC_SNAPSHOT)
        if starting_revision == "20261114_01":
            assert rbac_before == before_upgrade
        # NULL actor remains available in the schema for explicitly defined
        # future system operations; initial writer actions require a User.
        db.execute(
            text(
                "INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action) "
                "VALUES (NULL, 'migration_fixture', 1, 'system_fixture')"
            )
        )
        assert db.scalar(text("SELECT created_at IS NOT NULL FROM audit_events"))
    run_migration(engine, "downgrade", "20261114_01")
    tables = inspect(engine).get_table_names()
    assert "audit_events" not in tables
    assert {"staff_profiles", "staff_permissions"} <= set(tables)
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "20261114_01"
        assert db.scalar(RBAC_SNAPSHOT) == rbac_before
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "20261117_01"
        assert db.scalar(RBAC_SNAPSHOT) == rbac_before
        assert db.scalar(text("SELECT count(*) FROM audit_events")) == 0


def test_audit_revision_extends_the_single_migration_chain_with_unique_ids():
    backend = Path(__file__).resolve().parents[1]
    # Inspect source files as well: Alembic may warn and mask duplicate IDs in
    # its revision map, so uniqueness of walk_revisions alone is insufficient.
    revision_ids = []
    for path in (backend / "alembic" / "versions").glob("*.py"):
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            else:
                continue
            if any(isinstance(target, ast.Name) and target.id == "revision" for target in targets):
                revision_ids.append(ast.literal_eval(node.value))
    assert len(revision_ids) == len(set(revision_ids))
    graph = ScriptDirectory.from_config(Config(str(backend / "alembic.ini")))
    assert graph.get_heads() == ["20261117_01"]
    assert graph.get_revision("20261117_01").down_revision == "20261116_09"
    assert graph.get_revision("20261116_01").down_revision == "20261115_04"
    assert graph.get_revision("20261115_03").down_revision == "20261115_02"
    assert graph.get_revision("20261115_02").down_revision == "20261115_01"
    assert graph.get_revision("20261115_01").down_revision == "20261114_03"
    assert graph.get_revision("20261114_03").down_revision == "20261114_02"
    assert graph.get_revision("20261114_02").down_revision == "20261114_01"
    assert graph.get_revision("20261114_01").down_revision == "20261112_03"


def test_wave_two_revisions_form_one_exact_chain():
    graph = ScriptDirectory.from_config(
        Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    )
    chain = [
        "20261115_03",
        "20261115_04",
        "20261116_01",
        "20261116_02",
        "20261116_03",
        "20261116_04",
        "20261116_05",
        "20261116_06",
        "20261116_07",
        "20261116_08",
        "20261116_09",
        "20261117_01",
    ]
    assert graph.get_heads() == [chain[-1]]
    for parent, child in zip(chain, chain[1:], strict=False):
        assert graph.get_revision(child).down_revision == parent
