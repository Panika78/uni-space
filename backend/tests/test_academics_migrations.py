"""Upgrade a populated pre-review database; never mutate the shared test schema."""

import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_academics_integration import academics as academics_fixture

pytestmark = pytest.mark.integration
BACKEND = Path(__file__).resolve().parents[1]
SNAPSHOT = """SELECT jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM assessments a),
  (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM assessment_groups g),
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM assessment_results r),
  (SELECT jsonb_agg((to_jsonb(s) - 'profile_role') ORDER BY id) FROM students s))"""


@pytest.fixture
def migration_database(postgresql_engine):
    name = f"uni_space_academics_migration_{uuid4().hex}"
    with postgresql_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as admin:
        admin.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(postgresql_engine.url.set(database=name))
    try:
        yield engine
    finally:
        engine.dispose()
        with postgresql_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as admin:
            admin.execute(text(f'DROP DATABASE "{name}"'))


def run_migration(engine, action, revision=None, *, success=True):
    env = os.environ | {
        "APP_ENV": "test",
        "DATABASE_URL": engine.url.render_as_string(hide_password=False),
    }
    args = [sys.executable, "-m", "alembic", action]
    if revision:
        args.append(revision)
    result = subprocess.run(args, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=30)
    assert (result.returncode == 0) is success, result.stderr
    return result


def seed_old_results(engine):
    with Session(engine, expire_on_commit=False) as db:
        s = academics_fixture.__wrapped__(db)
        course = s.offering()
        assignment = s.assignment(course)
        s.result(assignment, 8)
        # Legal transfer: the historical result must survive upgrade too.
        s.students[0].group_id = s.groups[1].id
        db.commit()
        return assignment.id, assignment.assessment_id


def test_upgrade_existing_grades_preserves_data_transfer_and_downgrade(migration_database):
    engine = migration_database
    run_migration(engine, "upgrade", "20261112_02")
    assignment_id, assessment_id = seed_old_results(engine)
    with engine.connect() as db:
        before = db.scalar(text(SNAPSHOT))
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
        assert db.scalar(text(SNAPSHOT)) == before
        with pytest.raises(IntegrityError):
            db.execute(
                text("UPDATE assessments SET max_score=5 WHERE id=:id"), {"id": assessment_id}
            )
        db.rollback()
        # Reassigning back to a transferred student's current group is not a data repair.
        with pytest.raises(IntegrityError):
            db.execute(
                text(
                    "UPDATE assessment_groups SET group_id=(SELECT max(id) FROM study_groups) "
                    "WHERE id=:id"
                ),
                {"id": assignment_id},
            )
        db.rollback()
        assert db.scalar(text(SNAPSHOT)) == before
    run_migration(engine, "downgrade", "20261112_02")
    with engine.connect() as db:
        assert db.scalar(text(SNAPSHOT)) == before
    run_migration(engine, "upgrade", "head")
    with engine.connect() as db:
        assert db.scalar(text(SNAPSHOT)) == before


def test_upgrade_rejects_existing_excess_score_without_rewriting_data(migration_database):
    engine = migration_database
    run_migration(engine, "upgrade", "20261112_02")
    _, assessment_id = seed_old_results(engine)
    with engine.begin() as db:
        db.execute(text("UPDATE assessments SET max_score=5 WHERE id=:id"), {"id": assessment_id})
    with engine.connect() as db:
        before = db.scalar(text(SNAPSHOT))
        previous_function = db.scalar(
            text("SELECT pg_get_functiondef('validate_assessment_result()'::regprocedure)")
        )
    result = run_migration(engine, "upgrade", "head", success=False)
    assert "Existing assessment scores exceed maxima" in result.stderr
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "20261112_02"
        assert db.scalar(text(SNAPSHOT)) == before
        assert (
            db.scalar(
                text("SELECT pg_get_functiondef('validate_assessment_result()'::regprocedure)")
            )
            == previous_function
        )
        assert db.scalar(text("SELECT to_regprocedure('preserve_assessment_maximum()')")) is None


@pytest.mark.parametrize("change", ["maximum", "group", "assessment"])
def test_upgrade_invalidates_old_repeatable_read_snapshot(migration_database, change):
    from sqlalchemy.exc import DBAPIError

    from app.models import Assessment, AssessmentResult

    engine = migration_database
    run_migration(engine, "upgrade", "20261112_02")
    with Session(engine, expire_on_commit=False) as db:
        s = academics_fixture.__wrapped__(db)
        course = s.offering()
        assignment = s.assignment(course)
        replacement = s.add(
            Assessment,
            course_offering_id=course.id,
            title="Другая работа",
            type="test",
            max_score=5,
        )
        db.commit()
        values = dict(
            id=assignment.id,
            work=assignment.assessment_id,
            group=s.groups[1].id,
            replacement=replacement.id,
        )
        with engine.connect().execution_options(isolation_level="REPEATABLE READ") as stale:
            stale.execute(text("SELECT * FROM assessments"))
            s.result(assignment, 8)
            db.commit()  # Old result trigger only SHARE-locks the parents.
            run_migration(engine, "upgrade", "head")
            sql = {
                "maximum": "UPDATE assessments SET max_score=5 WHERE id=:work",
                "group": "UPDATE assessment_groups SET group_id=:group WHERE id=:id",
                "assessment": (
                    "UPDATE assessment_groups SET assessment_id=:replacement WHERE id=:id"
                ),
            }[change]
            with pytest.raises(DBAPIError) as rejected:
                stale.execute(text(sql), values)
            assert rejected.value.orig.sqlstate == "40001"
            stale.rollback()
        db.expire_all()
        assert assignment.assessment_id == values["work"]
        assert assignment.group_id == s.groups[0].id
        assert db.get(Assessment, values["work"]).max_score == 10
        assert (
            db.query(AssessmentResult).filter_by(assessment_group_id=assignment.id).one().score == 8
        )


def test_alembic_graph_preserves_notifications_and_has_one_academic_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    graph = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini")))
    assert graph.get_heads() == ["20261114_01"]
    assert graph.get_revision("20261114_01").down_revision == "20261112_03"
    assert graph.get_revision("20261112_03").down_revision == "20261112_02"
    assert graph.get_revision("20261112_02").down_revision == "20261112_01"
    notification = graph.get_revision("20261112_01")
    assert notification.down_revision == "20261111_02"
    assert Path(notification.path).name == "20261112_01_notifications.py"
    revisions = [item.revision for item in graph.walk_revisions()]
    assert len(revisions) == len(set(revisions))


def test_upgrade_main_notifications_preserves_rows_and_creates_academics(migration_database):
    from app.models import Notification, User

    engine = migration_database
    run_migration(engine, "upgrade", "20261112_01")
    with Session(engine) as db:
        user = User(
            login="fictional-migration-notifications",
            full_name="Fictional Student",
            role="student",
            password_hash="unusable-fictional-fixture",
            is_active=True,
        )
        db.add(user)
        db.flush()
        db.add(
            Notification(
                user_id=user.id,
                type="fictional_type",
                title="Существующее уведомление",
                body="Вымышленные данные до установки успеваемости",
                entity_type="fictional_entity",
                entity_id=42,
            )
        )
        db.commit()
    notification_snapshot = text("SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n")
    with engine.connect() as db:
        before = db.scalar(notification_snapshot)
        assert db.scalar(text("SELECT to_regclass('public.assessments')")) is None
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    with engine.connect() as db:
        assert db.scalar(notification_snapshot) == before
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "20261114_01"
        for table in ("assessments", "assessment_groups", "assessment_results", "final_results"):
            assert (
                db.scalar(text("SELECT to_regclass(:table)"), {"table": f"public.{table}"})
                is not None
            )
