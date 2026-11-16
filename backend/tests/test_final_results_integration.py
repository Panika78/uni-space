"""Manual result API and mandatory audit on real PostgreSQL."""

from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_teaching_integration import journal as journal_fixture

from app.auth.security import create_access_token
from app.final_results import journal_router, router
from app.models import (
    AuditEvent,
    AuthSession,
    FinalResult,
    OrgUnit,
    StaffPermission,
    StaffProfile,
    User,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def results(db_session):
    s = journal_fixture.__wrapped__(db_session)
    s.app.include_router(router)
    s.app.include_router(journal_router)

    def request(method="PATCH", body=None, teacher=0, course=0, student=0, token=None):
        s.db.commit()
        return s.client.request(
            method,
            f"/api/v1/final-results/courses/{s.courses[course].id}/students/{s.students[student].id}",
            json=body,
            headers={"Authorization": f"Bearer {token or s.teacher_tokens[teacher]}"},
        )

    s.save = request
    s.events = lambda: list(
        s.db.scalars(
            select(AuditEvent)
            .where(AuditEvent.entity_type == "final_result")
            .order_by(AuditEvent.id)
        )
    )
    return s


@pytest.mark.parametrize("kind", ["exam", "graded_pass", "pass_fail"])
def test_scales_retake_clear_delete_and_audit(results, kind):
    s = results
    s.courses[0].attestation_type = kind
    s.db.flush()
    for body in [
        {"grade_value": 1},
        {"grade_value": 6},
        {"grade_value": 2.5},
        {"grade_value": True},
        {"passed": 1},
        {"passed": "true"},
        {"grade_value": 2, "passed": False},
        {"attestation_type": kind},
        {"retake_location": "\n"},
        {"retake_location": "x" * 201},
    ]:
        assert s.save(body=body).status_code == 422
    wrong = {"grade_value": 2} if kind == "pass_fail" else {"passed": False}
    assert s.save(body=wrong).status_code == 422
    assert s.save("GET").json()["has_debt"] is False
    data = s.save("POST", {"retake_date": "2027-01-10", "retake_location": "A-101"}).json()
    assert data["grade_value"] is None and data["has_debt"] is False
    result_id = data["result_id"]
    assert s.request().status_code == 200
    student_item = next(
        i for i in s.request().json()["items"] if i["course_offering_id"] == str(s.courses[0].id)
    )
    assert student_item["final_result"]["has_debt"] is False
    assert s.events()[-1].action == "create"
    assert s.save(body={"retake_location": "B-202"}).status_code == 200
    event = s.events()[-1]
    assert event.before_data["retake_location"] == "A-101"
    assert event.after_data["retake_location"] == "B-202"
    count = len(s.events())
    assert s.save(body={}).status_code == 200
    assert s.save(body={"retake_location": "B-202"}).status_code == 200
    assert len(s.events()) == count
    field = "passed" if kind == "pass_fail" else "grade_value"
    failure = False if kind == "pass_fail" else 2
    success = True if kind == "pass_fail" else 5
    assert s.save(body={field: failure}).json()["has_debt"] is True
    student_item = next(
        i for i in s.request().json()["items"] if i["course_offering_id"] == str(s.courses[0].id)
    )
    assert student_item["final_result"]["has_debt"] is True
    assert student_item["final_result"][field] == failure
    cleared = s.save(body={field: None}).json()
    assert cleared["retake_location"] == "B-202" and cleared["has_debt"] is False
    positive = s.save(body={field: success}).json()
    assert positive["retake_location"] is None and positive["retake_date"] is None
    assert positive["result_id"] == result_id
    student_item = next(
        i for i in s.request().json()["items"] if i["course_offering_id"] == str(s.courses[0].id)
    )
    assert student_item["final_result"][field] == success
    assert student_item["final_result"]["has_debt"] is False
    assert student_item["final_result"]["retake_location"] is None
    assert s.events()[-1].before_data["retake_date"] == "2027-01-10"
    assert s.events()[-1].after_data["retake_location"] is None
    assert s.save(body={field: None}).json()["result_id"] is None
    assert s.events()[-1].action == "delete" and s.events()[-1].after_data is None
    count = len(s.events())
    assert s.save("DELETE").status_code == 200
    assert s.save(body={field: None}).status_code == 200
    assert len(s.events()) == count
    assert s.save(body={"retake_location": "A-101"}).status_code == 200
    assert s.save("DELETE").json()["result_id"] is None


def test_transfer_read_scope_revocation_and_historical_staff(results):
    verify_transfer_and_staff_scope(results)


def create_result_actor(s, role, *, unit_type=None, permission=None):
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Вымышленный сотрудник",
        role=role,
        is_active=True,
    )
    grant = None
    if role == "staff":
        unit = s.add(OrgUnit, name="Вымышленное подразделение", type=unit_type)
        profile = s.add(StaffProfile, user_id=user.id, org_unit_id=unit.id)
        if permission:
            grant = s.add(StaffPermission, staff_profile_id=profile.id, permission_code=permission)
    session = s.add(AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
    return user, grant, create_access_token(session, s.settings)["access_token"]


def verify_transfer_and_staff_scope(s):
    assert s.save(body={"grade_value": 2}).status_code == 200
    assert s.save("GET", student=1).status_code == 404
    assert s.save(body={"grade_value": 3}, student=1).status_code == 404
    assert s.get("final-results", student_id=str(s.students[1].id)).json()["items"] == []
    assert len(s.get("final-results", limit=1).json()["items"]) == 1
    for params in [{"unknown": "x"}, {"limit": 0}, {"cursor": "bad"}]:
        assert s.get("final-results", **params).status_code == 422
    s.students[0].group_id = s.groups[1].id
    s.db.flush()
    assert s.save("GET").status_code == 404
    assert s.save(body={"grade_value": 3}).status_code == 404
    assert s.save(body={"grade_value": 3}, teacher=1).status_code == 200
    s.db.delete(s.grants[1])
    s.db.flush()
    assert s.save("GET", teacher=1).status_code == 404
    # Historical result for a course no longer studied by the new group.
    s.students[0].group_id = s.groups[0].id
    s.db.flush()
    assert s.save(body={"grade_value": 2}, course=1).status_code == 200
    s.students[0].group_id = s.groups[1].id
    _, grant, staff_token = create_result_actor(
        s, "staff", unit_type="dean_office", permission="grades.edit"
    )
    assert s.save("GET", token=staff_token, course=1).status_code == 200
    assert s.save(body={"grade_value": 4}, token=staff_token, course=1).status_code == 200
    # Delete the grant, keep the same JWT: rights must be read from the database.
    s.db.delete(grant)
    assert s.save("GET", token=staff_token, course=1).status_code == 403
    assert s.save(body={"grade_value": 2}, token=staff_token, course=1).status_code == 403
    for role, unit_type, permission in [
        ("staff", "dean_office", "students.read"),
        ("staff", "accounting", "grades.edit"),
        ("admin", None, None),
    ]:
        _, _, token = create_result_actor(s, role, unit_type=unit_type, permission=permission)
        assert s.save("GET", token=token, course=1).status_code == 403
        assert s.save(body={"grade_value": 2}, token=token, course=1).status_code == 403


def test_student_academics_and_audit_rollback(results, monkeypatch):
    s = results

    assert s.save(body={"retake_date": "2027-01-10"}).status_code == 200
    # Read through the existing student API; no inferred debt for retake-only rows.
    response = s.request()
    assert response.status_code == 200
    item = next(
        i for i in response.json()["items"] if i["course_offering_id"] == str(s.courses[0].id)
    )
    assert item["final_result"]["has_debt"] is False
    assert s.db.scalar(select(FinalResult)).retake_date == date(2027, 1, 10)
    before_count = len(s.events())

    def fail(*args, **kwargs):
        raise ValueError("simulated writer failure")

    monkeypatch.setattr("app.final_results.write_audit_event", fail)
    assert s.save(body={"grade_value": 5}).status_code == 500
    assert s.db.scalar(select(FinalResult)).grade_value is None
    assert len(s.events()) == before_count


def test_transaction_retry_rechecks_and_preserves_one_audit_event(results, monkeypatch):
    from psycopg.errors import DeadlockDetected
    from sqlalchemy.exc import OperationalError

    from app.final_results import write_audit_event

    s = results
    calls = []

    def retry_once(*args, **kwargs):
        event = write_audit_event(*args, **kwargs)
        calls.append(event.id)
        if len(calls) == 1:
            raise OperationalError("simulated deadlock after flush", {}, DeadlockDetected())
        return event

    monkeypatch.setattr("app.final_results.write_audit_event", retry_once)
    assert s.save(body={"grade_value": 2}).status_code == 200
    assert len(calls) == 2
    assert len(s.events()) == 1
    assert s.events()[0].action == "create"

    def always_fail(*args, **kwargs):
        write_audit_event(*args, **kwargs)
        raise OperationalError("simulated deadlock after flush", {}, DeadlockDetected())

    monkeypatch.setattr("app.final_results.write_audit_event", always_fail)
    response = s.save(body={"grade_value": 5})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "concurrent_change"
    assert s.save("GET").json()["grade_value"] == 2
    assert len(s.events()) == 1


def test_writer_failure_rolls_back_creation(results, monkeypatch):
    from app.final_results import write_audit_event

    s = results

    def fail(*args, **kwargs):
        write_audit_event(*args, **kwargs)
        raise ValueError("simulated failure after audit insert")

    monkeypatch.setattr("app.final_results.write_audit_event", fail)
    assert s.save("POST", {"retake_location": "A-101"}).status_code == 500
    assert s.save("GET").json()["result_id"] is None
    assert s.events() == []


@pytest.mark.parametrize("location", ["x" * 201, "", "A\n\t101\x01"])
@pytest.mark.parametrize("operation", ["patch", "pass", "delete"])
def test_historical_location_is_audited_exactly(results, location, operation):
    s = results
    result = s.add(
        FinalResult,
        course_offering_id=s.courses[0].id,
        student_id=s.students[0].id,
        retake_location=location,
    )
    result_id = result.id
    before = dict(
        course_offering_id=s.courses[0].id,
        student_id=s.students[0].id,
        grade_value=None,
        passed=None,
        retake_date=None,
        retake_location=location,
    )
    # Historical data is valid PostgreSQL TEXT, even when invalid as new API input.
    s.db.commit()
    count = len(s.events())
    assert s.save(body={"retake_location": location}).status_code == 422
    assert s.save("GET").json()["retake_location"] == location
    assert len(s.events()) == count
    if operation == "delete":
        response = s.save("DELETE")
        after = None
    else:
        grade = 2 if operation == "patch" else 5
        response = s.save(body={"grade_value": grade})
        after = dict(
            before, grade_value=grade, retake_location=location if operation == "patch" else None
        )
    assert response.status_code == 200, response.text
    events = s.events()
    assert len(events) == count + 1
    event = events[-1]
    assert event.entity_id == result_id
    assert event.before_data == before
    assert event.after_data == after
    assert event.action == ("delete" if operation == "delete" else "update")
    assert response.json()["retake_location"] == (after["retake_location"] if after else None)
