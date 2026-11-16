"""Run real editor requests under production uni_space_api ACL."""

import ast
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_assessed_lesson_participants import add_assessment, link_assessment
from test_schedule_editor_integration import create, move_payload
from test_schedule_editor_integration import editor as editor_fixture
from test_schedule_integration import schedule as schedule_fixture

from app.dependencies.database import get_db_session
from app.models import Lesson

pytestmark = pytest.mark.integration


def test_production_role_can_edit_and_audit_but_cannot_change_academic_records(runtime_engine):  # noqa: F811
    admin_engine, api_engine = runtime_engine
    with Session(admin_engine) as admin:
        e = editor_fixture.__wrapped__(schedule_fixture.__wrapped__(admin))
        item = create(e)
        lesson = admin.get(Lesson, int(item["id"]))
        assignment = link_assessment(
            admin, add_assessment(admin, lesson).id, lesson.id, e.groups[0].id
        )
        assignment_id = assignment.id
        admin.commit()

        def runtime_session():
            with Session(api_engine) as db:
                yield db

        e.app.dependency_overrides[get_db_session] = runtime_session
        path = f"/lessons/{item['id']}"
        response = e.request_editor(
            "PATCH",
            path,
            e.payload(
                version=1,
                participants=[{"group_id": str(e.groups[0].id), "subgroup_id": str(e.a.id)}],
            ),
        )
        assert response.status_code == 200, response.text
        response = e.request_editor("POST", path + "/cancel", {"version": 2})
        assert response.status_code == 200, response.text
        assert e.request_editor("POST", path + "/restore", {"version": 3}).status_code == 200
        response = e.request_editor("POST", path + "/move", move_payload(e, version=4))
        assert response.status_code == 201, response.text
        for kind in (
            "groups",
            "subgroups",
            "teachers",
            "rooms",
            "course-offerings",
            "teaching-assignments",
        ):
            assert e.request_editor("GET", "/catalog/" + kind).status_code == 200
        admin.expire_all()
        assert (
            admin.scalar(
                text("SELECT date_needs_confirmation FROM assessment_groups WHERE id=:id"),
                {"id": assignment_id},
            )
            is True
        )
        for statement in (
            "DELETE FROM lessons",
            "DELETE FROM assessments",
            "UPDATE assessment_groups SET assessment_id=assessment_id",
            "TRUNCATE assessment_results",
            "DELETE FROM audit_events",
            "UPDATE audit_events SET action='update'",
            "SELECT before_data FROM audit_events",
            "UPDATE users SET role='admin'",
            "DELETE FROM course_groups",
            "TRUNCATE attendance",
        ):
            with Session(api_engine) as db, pytest.raises(DBAPIError) as error:
                db.execute(text(statement))
            # attendance is delivered by #70 and may not exist on this main.
            assert error.value.orig.sqlstate in ("42501", "42P01")


def test_production_compose_acl_assertions_match_runtime_grants(runtime_engine):  # noqa: F811
    # Execute the same assertions used inside the production API container,
    # under the actual runtime login on a migrated PostgreSQL database.
    source = (Path(__file__).resolve().parents[2] / "deploy/test_production.py").read_text()
    scripts = [
        node.value
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and "PASS: schedule editor grants permitted" in node.value
    ]
    assert len(scripts) == 1
    block = next(node for node in ast.parse(scripts[0]).body if isinstance(node, ast.With))
    code = compile(ast.Module(body=[block], type_ignores=[]), "production-acl-assertions", "exec")
    exec(code, {"engine": runtime_engine[1], "text": text})
