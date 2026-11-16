"""Apply the actual production ACL and log in as its real, unprivileged runtime role."""

import os
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_application_workflow import context, history  # noqa: F401
from test_auth_integration import auth as auth_fixture

from app.dependencies.database import get_db_session
from app.models import AuditEvent, StaffPermission, Student, User
from app.staff_students import router as staff_students_router

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
        "UPDATE students SET group_id=group_id",
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


def test_production_acl_allows_only_academic_status_and_transactional_audit(
    context,  # noqa: F811
    runtime_engine,
):
    c = context
    admin_engine, api_engine = runtime_engine
    c["client"].app.include_router(staff_students_router)
    with Session(admin_engine) as db, db.begin():
        db.add(
            StaffPermission(
                staff_profile_id=c["profiles"][0],
                permission_code="students.status.edit",
                scope_org_unit_id=None,
            )
        )
        student_id = c["students"][0]
        student = db.get(Student, student_id)
        user_id = student.user_id
        original_active = db.get(User, user_id).is_active

    def runtime_session():
        with Session(api_engine) as db:
            yield db

    c["client"].app.dependency_overrides[get_db_session] = runtime_session
    response = c["request"](
        "PATCH",
        f"/api/v1/staff/students/{student_id}/academic-status",
        c["tokens"][0],
        json={
            "academic_status": "academic_leave",
            "reason": "administrative_change",
            "operation_id": str(uuid4()),
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["academic_status"] == "academic_leave"
    assert response.json()["previous_academic_status"] == "enrolled"
    assert response.json()["changed"] is True
    assert response.json()["operation_id"]
    with Session(admin_engine) as db:
        student = db.get(Student, student_id)
        actor = db.get(User, c["actors"][0])
        event = db.scalar(
            select(AuditEvent).where(
                AuditEvent.entity_type == "student", AuditEvent.entity_id == student_id
            )
        )
        assert student.academic_status == "academic_leave"
        assert db.get(User, user_id).is_active is original_active
        assert actor.role == "staff"
        assert event.actor_user_id == actor.id
        assert event.before_data == {"academic_status": "enrolled"}
        assert event.after_data == {"academic_status": "academic_leave"}
    # A genuine INSERT denial under the production runtime role must roll back status.
    with admin_engine.begin() as db:
        db.execute(text("REVOKE INSERT ON audit_events FROM uni_space_api"))
    denied = c["request"](
        "PATCH",
        f"/api/v1/staff/students/{student_id}/academic-status",
        c["tokens"][0],
        json={
            "academic_status": "expelled",
            "reason": "correction",
            "operation_id": str(uuid4()),
        },
    )
    assert denied.status_code == 500
    with Session(admin_engine) as db:
        assert db.get(Student, student_id).academic_status == "academic_leave"
        assert (
            len(
                db.scalars(
                    select(AuditEvent).where(
                        AuditEvent.entity_id == student_id, AuditEvent.entity_type == "student"
                    )
                ).all()
            )
            == 1
        )
    with admin_engine.begin() as db:
        db.execute(text("GRANT INSERT ON audit_events TO uni_space_api"))
    # Receipt persistence is part of the same transaction, including the status update.
    with admin_engine.begin() as db:
        db.execute(text("REVOKE INSERT ON student_status_operations FROM uni_space_api"))
    denied_receipt = c["request"](
        "PATCH",
        f"/api/v1/staff/students/{student_id}/academic-status",
        c["tokens"][0],
        json={
            "academic_status": "expelled",
            "reason": "correction",
            "operation_id": str(uuid4()),
        },
    )
    assert denied_receipt.status_code == 500
    with Session(admin_engine) as db:
        assert db.get(Student, student_id).academic_status == "academic_leave"
        assert (
            len(
                db.scalars(
                    select(AuditEvent).where(
                        AuditEvent.entity_id == student_id, AuditEvent.entity_type == "student"
                    )
                ).all()
            )
            == 1
        )
    with admin_engine.begin() as db:
        db.execute(text("GRANT INSERT ON student_status_operations TO uni_space_api"))
    with Session(admin_engine) as db, db.begin():
        db.execute(
            text("DELETE FROM student_status_operations WHERE actor_user_id=:actor"),
            {"actor": c["actors"][0]},
        )
        db.execute(delete(AuditEvent).where(AuditEvent.actor_user_id == c["actors"][0]))
