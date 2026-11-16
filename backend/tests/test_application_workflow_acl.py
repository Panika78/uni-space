"""Apply the actual production ACL and log in as its real, unprivileged runtime role."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_application_workflow import context, history  # noqa: F401
from test_auth_integration import auth as auth_fixture

from app.dependencies.database import get_db_session

pytestmark = pytest.mark.integration
API_PASSWORD = "test-only-workflow-runtime-password"


@pytest.fixture
def runtime_engine(migration_database):  # noqa: F811
    admin_engine = migration_database
    script = (Path(__file__).resolve().parents[2] / "deploy/postgres/privileges.sql").read_text()
    container = os.environ.get("POSTGRES_TEST_CONTAINER")
    if container:
        command = [
            "docker",
            "exec",
            "-i",
            "-e",
            f"API_DB_PASSWORD={API_PASSWORD}",
            "-e",
            "MIGRATION_DB_PASSWORD=test-only-workflow-migrator-password",
            container,
            "psql",
            "-U",
            admin_engine.url.username,
            "-d",
            admin_engine.url.database,
            "-v",
            "ON_ERROR_STOP=1",
        ]
    elif shutil.which("psql"):
        command = [
            "psql",
            "-X",
            "-h",
            admin_engine.url.host,
            "-p",
            str(admin_engine.url.port or 5432),
            "-U",
            admin_engine.url.username,
            "-d",
            admin_engine.url.database,
            "-v",
            "ON_ERROR_STOP=1",
        ]
    else:
        pytest.fail("Production ACL test needs psql or POSTGRES_TEST_CONTAINER (isolated test DB)")
    env = os.environ | {
        "PGPASSWORD": admin_engine.url.password,
        "API_DB_PASSWORD": API_PASSWORD,
        "MIGRATION_DB_PASSWORD": "test-only-workflow-migrator-password",
    }
    api_engine = None
    try:
        # Production bootstraps roles before migrations, then reapplies ACL.
        for iteration in range(3):
            result = subprocess.run(
                command, input=script, text=True, capture_output=True, env=env, timeout=30
            )
            assert result.returncode == 0, result.stderr
            if iteration == 0:
                run_migration(admin_engine, "upgrade", "head")
                with admin_engine.begin() as db:
                    db.execute(text("GRANT UPDATE (id) ON users TO uni_space_api"))
        api_engine = create_engine(
            admin_engine.url.set(username="uni_space_api", password=API_PASSWORD)
        )
        with api_engine.connect() as db:
            assert db.scalar(text("SELECT current_user")) == "uni_space_api"
            assert db.scalar(
                text(
                    "SELECT NOT rolsuper AND NOT rolbypassrls "
                    "FROM pg_roles WHERE rolname=current_user"
                )
            )
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'applications','UPDATE')")
            )
            for column in (
                "review_status",
                "version",
                "form_data",
                "feedback",
                "reviewer_user_id",
                "updated_at",
            ):
                assert db.scalar(
                    text(
                        "SELECT has_column_privilege(current_user,'applications',:column,'UPDATE')"
                    ),
                    {"column": column},
                )
            for column in ("student_id", "service_type_id", "assigned_org_unit_id", "created_at"):
                assert not db.scalar(
                    text(
                        "SELECT has_column_privilege(current_user,'applications',:column,'UPDATE')"
                    ),
                    {"column": column},
                )
            assert db.scalar(
                text(
                    "SELECT has_sequence_privilege("
                    "current_user,'application_history_id_seq','USAGE')"
                )
            )
            for privilege in ("INSERT", "UPDATE", "DELETE"):
                assert db.scalar(
                    text("SELECT has_table_privilege(current_user,'assessment_results',:p)"),
                    {"p": privilege},
                )
            assert db.scalar(
                text("SELECT has_column_privilege(current_user,'assessments','max_score','UPDATE')")
            )
            assert db.scalar(
                text("SELECT has_column_privilege(current_user,'assessment_groups','id','UPDATE')")
            )
            assert db.scalar(
                text(
                    "SELECT has_column_privilege(current_user,'course_groups','group_id','UPDATE')"
                )
            )
            assert db.scalar(
                text("SELECT has_column_privilege(current_user,'students','id','UPDATE')")
            )
            assert not db.scalar(
                text("SELECT has_column_privilege(current_user,'assessments','title','UPDATE')")
            )
            assert db.scalar(
                text("SELECT has_table_privilege(current_user,'audit_events','INSERT')")
            )
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'audit_events','UPDATE')")
            )
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'audit_events','DELETE')")
            )
            for column in ("id", "created_at"):
                assert db.scalar(
                    text(
                        "SELECT has_column_privilege(current_user,'audit_events',:column,'SELECT')"
                    ),
                    {"column": column},
                )
            for column in ("entity_type", "entity_id", "before_data", "after_data"):
                assert not db.scalar(
                    text(
                        "SELECT has_column_privilege(current_user,'audit_events',:column,'SELECT')"
                    ),
                    {"column": column},
                )
            returned = db.execute(
                text(
                    "INSERT INTO audit_events "
                    "(actor_user_id,entity_type,entity_id,action,after_data) "
                    "VALUES (NULL,'assessment_result',1,'create',"
                    "jsonb_build_object('assessment_group_id',1,'student_id',1,'score',0)) "
                    "RETURNING id,created_at"
                )
            ).one()
            assert returned.id > 0 and returned.created_at is not None
        yield admin_engine, api_engine
    finally:
        if api_engine:
            api_engine.dispose()
        with admin_engine.begin() as db:
            db.execute(text("REASSIGN OWNED BY uni_space_migrator TO uni_space_test"))
            db.execute(text("DROP OWNED BY uni_space_api, uni_space_migrator"))
            db.execute(text("DROP ROLE uni_space_api"))
            db.execute(text("DROP ROLE uni_space_migrator"))


@pytest.fixture
def auth(runtime_engine, monkeypatch):
    yield from auth_fixture.__wrapped__(runtime_engine[0], monkeypatch)


def test_production_acl_supports_authenticated_workflow_and_denies_extra_writes(
    context,  # noqa: F811
    runtime_engine,
):
    c = context
    admin_engine, api_engine = runtime_engine

    def runtime_session():
        with Session(api_engine) as db:
            yield db

    c["client"].app.dependency_overrides[get_db_session] = runtime_session
    student = c["login"]()
    created = c["request"](
        "POST",
        "/api/v1/applications",
        student,
        json={"service_code": "study_certificate", "form_data": {"place_of_submission": "X"}},
    )
    assert created.status_code == 201, created.text
    assert history(c, created.json()["id"], student).status_code == 200
    identifier = c["application"]()
    assert c["request"]("GET", "/api/v1/staff/applications", c["tokens"][0]).status_code == 200
    assert c["review"](identifier, "start_review", 1).status_code == 200
    assert c["review"](identifier, "start_review", 1, index=1).status_code == 409
    assert (
        c["review"](identifier, "return_for_correction", 2, comment="Исправьте форму").status_code
        == 200
    )
    resubmitted = c["request"](
        "POST",
        f"/api/v1/applications/{identifier}/resubmit",
        student,
        json={"expected_version": 3, "form_data": {"place_of_submission": "Corrected"}},
    )
    assert resubmitted.status_code == 200, resubmitted.text
    assert c["review"](identifier, "start_review", 4, index=1).status_code == 200
    assert c["review"](identifier, "reject", 5, index=1, comment="Отказ").status_code == 200
    assert len(history(c, identifier, c["login"]()).json()["items"]) == 5
    assert c["review"](identifier, "start_review", 6).status_code == 409
    for sql in (
        "UPDATE application_history SET comment='forged'",
        "DELETE FROM application_history",
        "DELETE FROM applications",
        "UPDATE applications SET student_id=student_id",
        "UPDATE students SET academic_status='enrolled'",
        "UPDATE staff_permissions SET permission_code='applications.review'",
    ):
        with api_engine.connect() as db, pytest.raises(DBAPIError) as rejected:
            db.execute(text(sql))
        assert rejected.value.orig.sqlstate == "42501"
    with admin_engine.connect() as db:
        assert (
            db.scalar(
                text("SELECT count(*) FROM application_history WHERE application_id=:id"),
                {"id": identifier},
            )
            == 5
        )


def test_production_acl_runs_score_api_and_keeps_audit_append_only(runtime_engine):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy.orm import Session
    from test_academics_integration import academics as academics_fixture

    from app.auth.security import create_access_token
    from app.models import (
        AuthSession,
        Teacher,
        TeachingAssignment,
        User,
    )
    from app.teaching.router import router as teaching_router

    admin_engine, api_engine = runtime_engine
    with Session(admin_engine, expire_on_commit=False) as db:
        s = academics_fixture.__wrapped__(db)
        s.app.include_router(teaching_router)
        user = s.add(
            User,
            login="production-score-" + os.urandom(8).hex(),
            password_hash="unused",
            full_name="Fictional Teacher",
            role="teacher",
            is_active=True,
        )
        teacher = s.add(Teacher, user_id=user.id, full_name=user.full_name)
        auth_session = s.add(
            AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
        )
        course = s.offering()
        work = s.assignment(course)
        s.add(
            TeachingAssignment,
            teacher_id=teacher.id,
            course_offering_id=course.id,
            group_id=s.groups[0].id,
        )
        db.commit()

        def runtime_session():
            with Session(api_engine) as runtime_db:
                yield runtime_db

        s.app.dependency_overrides[get_db_session] = runtime_session
        token = create_access_token(auth_session, s.settings)["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        path = (
            f"/api/v1/teaching/courses/{course.id}/groups/{s.groups[0].id}"
            f"/assessments/{work.id}/results/{s.students[0].id}"
        )
        created = s.client.put(path, json={"score": 0}, headers=headers)
        assert created.status_code == 200, created.text
        result_id = int(created.json()["result_id"])
        assert s.client.put(path, json={"score": 0}, headers=headers).status_code == 200
        assert s.client.put(path, json={"score": 1}, headers=headers).status_code == 200
        assert s.client.put(path, json={"score": None}, headers=headers).status_code == 200

        with admin_engine.connect() as admin:
            events = (
                admin.execute(
                    text(
                        "SELECT action FROM audit_events WHERE entity_type='assessment_result' "
                        "AND entity_id=:id ORDER BY id"
                    ),
                    {"id": result_id},
                )
                .scalars()
                .all()
            )
            assert events == ["create", "update", "delete"]
        for sql in (
            "UPDATE audit_events SET entity_id=entity_id",
            "DELETE FROM audit_events",
        ):
            with api_engine.connect() as runtime_db:
                with pytest.raises(DBAPIError) as rejected:
                    runtime_db.execute(text(sql))
                assert rejected.value.orig.sqlstate == "42501"
