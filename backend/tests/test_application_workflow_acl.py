"""Apply the actual production ACL and log in as its real, unprivileged runtime role."""

import os
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, text
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
    run_migration(admin_engine, "upgrade", "head")
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
        for _ in range(2):  # reapplying ACL is required for existing production volumes
            result = subprocess.run(
                command, input=script, text=True, capture_output=True, env=env, timeout=30
            )
            assert result.returncode == 0, result.stderr
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


def test_production_acl_allows_news_workflow_and_keeps_audit_append_only(
    context,  # noqa: F811
    runtime_engine,
):
    from app.models import AuditEvent, News, StaffPermission, StaffProfile
    from app.news.router import router as student_news_router
    from app.news.staff_router import router as staff_news_router

    c = context
    admin_engine, api_engine = runtime_engine
    c["client"].app.include_router(student_news_router)
    c["client"].app.include_router(staff_news_router)

    def runtime_session():
        with Session(api_engine) as db:
            yield db

    c["client"].app.dependency_overrides[get_db_session] = runtime_session
    with Session(admin_engine) as db, db.begin():
        profile = db.get(StaffProfile, c["profiles"][0])
        db.add(
            StaffPermission(
                staff_profile_id=profile.id,
                permission_code="news.publish",
                scope_org_unit_id=profile.org_unit_id,
            )
        )
    staff_token = c["tokens"][0]
    created = c["request"](
        "POST",
        "/api/v1/staff/news",
        staff_token,
        headers={"Idempotency-Key": str(uuid4())},
        json={"title": "ACL news", "body": "Runtime role workflow"},
    )
    assert created.status_code == 201, created.text
    news_id = created.json()["id"]
    version = created.json()["version"]
    for path, method, body in (
        (f"/api/v1/staff/news/{news_id}/publish", "POST", None),
        (
            f"/api/v1/staff/news/{news_id}",
            "PATCH",
            {"title": "Edited", "body": "Runtime role workflow", "version": version + 1},
        ),
        (f"/api/v1/staff/news/{news_id}/unpublish", "POST", None),
        (f"/api/v1/staff/news/{news_id}/publish", "POST", None),
    ):
        response = c["request"](method, path, staff_token, **({"json": body} if body else {}))
        assert response.status_code == 200, response.text
        version = response.json()["version"]
    assert c["request"]("GET", "/api/v1/staff/news", staff_token).status_code == 200
    with api_engine.connect() as db:
        assert db.scalar(
            text(
                "SELECT has_sequence_privilege(current_user, "
                "pg_get_serial_sequence('news','id'),'USAGE')"
            )
        )
        assert not db.scalar(text("SELECT has_table_privilege(current_user,'news','DELETE')"))
        assert not db.scalar(
            text("SELECT has_table_privilege(current_user,'news_create_requests','INSERT')")
        )
        assert not db.scalar(
            text("SELECT has_table_privilege(current_user,'news_create_requests','SELECT')")
        )
        assert not db.scalar(
            text("SELECT has_table_privilege(current_user,'news_create_requests','UPDATE')")
        )
        for column in (
            "actor_user_id",
            "org_unit_id",
            "idempotency_key",
            "payload_hash",
            "news_id",
            "response_data",
        ):
            assert db.scalar(
                text(
                    "SELECT has_column_privilege(current_user,'news_create_requests',"
                    ":column,'SELECT')"
                ),
                {"column": column},
            )
        for column in ("actor_user_id", "org_unit_id", "idempotency_key", "payload_hash"):
            assert db.scalar(
                text(
                    "SELECT has_column_privilege(current_user,'news_create_requests',"
                    ":column,'INSERT')"
                ),
                {"column": column},
            )
        for column in ("news_id", "response_data"):
            assert not db.scalar(
                text(
                    "SELECT has_column_privilege(current_user,'news_create_requests',"
                    ":column,'INSERT')"
                ),
                {"column": column},
            )
        for column in ("news_id", "response_data"):
            assert db.scalar(
                text(
                    "SELECT has_column_privilege(current_user,'news_create_requests',"
                    ":column,'UPDATE')"
                ),
                {"column": column},
            )
        for action in ("UPDATE", "DELETE"):
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'audit_events',:action)"),
                {"action": action},
            )
    with admin_engine.connect() as db:
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM audit_events WHERE entity_type='news' AND entity_id=:id"
                ),
                {"id": int(news_id)},
            )
            == 5
        )
    with Session(admin_engine) as db, db.begin():
        db.execute(
            delete(AuditEvent).where(
                AuditEvent.entity_type == "news", AuditEvent.entity_id == int(news_id)
            )
        )
        db.execute(delete(News).where(News.id == int(news_id)))
