"""Real PostgreSQL, Bearer authentication and independent sessions for workflow races."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_auth_integration import PASSWORD
from test_auth_integration import auth as auth_fixture

from app.applications import service as workflow
from app.applications.router import router
from app.applications.schemas import ApplicationFormData, ReviewApplicationRequest
from app.auth.security import PASSWORD_HASHER, create_access_token
from app.core.config import get_settings
from app.models import (
    Application,
    ApplicationHistory,
    AuthSession,
    OrgUnit,
    RefreshToken,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    User,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def auth(postgresql_engine, monkeypatch):
    yield from auth_fixture.__wrapped__(postgresql_engine, monkeypatch)


@pytest.fixture
def context(auth, monkeypatch, tmp_path):
    from app.applications import router as applications_router
    from app.documents import issuer

    settings = get_settings().model_copy(update={"attachment_storage_path": str(tmp_path)})
    monkeypatch.setattr(applications_router, "get_settings", lambda: settings)
    monkeypatch.setattr(issuer, "get_settings", lambda: settings)
    client, engine, student_users, logins, student_ids = auth
    client.app.include_router(router)
    actors = []
    profiles = []
    tokens = []
    with Session(engine, expire_on_commit=False) as db:
        units = [
            OrgUnit(name="Fictional Workflow Unit", type=t) for t in ("dean_office", "accounting")
        ]
        db.add_all(units)
        db.flush()
        for index in range(4):
            user = User(
                login=uuid4().hex,
                full_name="Fictional Reviewer",
                password_hash=PASSWORD_HASHER.hash(PASSWORD),
                role="staff",
                is_active=True,
            )
            db.add(user)
            db.flush()
            profile = StaffProfile(user_id=user.id, org_unit_id=units[index == 2].id)
            db.add(profile)
            db.flush()
            if index != 3:
                db.add(
                    StaffPermission(
                        staff_profile_id=profile.id,
                        permission_code="applications.review",
                        scope_org_unit_id=profile.org_unit_id,
                    )
                )
            session = AuthSession(
                user_id=user.id,
                created_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
            db.add(session)
            db.flush()
            tokens.append(create_access_token(session, get_settings())["access_token"])
            actors.append(user.id)
            profiles.append(profile.id)
        # Synthetic service uses the existing, strict form in tests only; #67
        # owns production manual services/forms. No production seed is changed.
        service = ServiceType(
            code="workflow_fixture_" + uuid4().hex,
            title="Fictional Manual",
            processing_mode="manual",
            responsible_org_unit_id=units[0].id,
            produces_document=True,
        )
        db.add(service)
        db.commit()
        service_id, unit_ids = service.id, [u.id for u in units]
    monkeypatch.setitem(workflow.APPLICATION_FORMS, service.code, ApplicationFormData)

    def login(index=0):
        response = client.login(json={"login": logins[index], "password": PASSWORD})
        assert response.status_code == 200
        return response.json()["access_token"]

    def application(**values):
        with Session(engine, expire_on_commit=False) as db, db.begin():
            row = Application(
                student_id=student_ids[0],
                service_type_id=service_id,
                review_status="submitted",
                document_status="pending",
                form_data={"place_of_submission": "Original"},
                version=1,
            )
            for key, value in values.items():
                setattr(row, key, value)
            db.add(row)
            db.flush()
            return row.id

    def request(method, path, token=None, **kwargs):
        return client.request(method, path, access=token, **kwargs)

    def review(identifier, action, version, index=0, **extra):
        return request(
            "POST",
            f"/api/v1/staff/applications/{identifier}/review",
            tokens[index],
            json=dict(action=action, expected_version=version, **extra),
        )

    ctx = dict(
        client=client,
        engine=engine,
        actors=actors,
        profiles=profiles,
        tokens=tokens,
        students=student_ids,
        student_users=student_users,
        unit_ids=unit_ids,
        service_id=service_id,
        application=application,
        request=request,
        review=review,
        login=login,
    )
    try:
        yield ctx
    finally:
        with Session(engine) as db, db.begin():
            db.execute(delete(Application).where(Application.student_id.in_(student_ids)))
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id.in_(profiles))
            )
            db.execute(delete(StaffProfile).where(StaffProfile.id.in_(profiles)))
            db.execute(
                delete(RefreshToken).where(
                    RefreshToken.session_id.in_(
                        select(AuthSession.id).where(AuthSession.user_id.in_(actors))
                    )
                )
            )
            db.execute(delete(AuthSession).where(AuthSession.user_id.in_(actors)))
            db.execute(delete(User).where(User.id.in_(actors)))
            db.execute(delete(ServiceType).where(ServiceType.id == service_id))
            db.execute(delete(OrgUnit).where(OrgUnit.id.in_(unit_ids)))


def history(ctx, identifier, token=None, staff=False, **params):
    prefix = "/api/v1/staff" if staff else "/api/v1"
    return ctx["request"](
        "GET",
        f"{prefix}/applications/{identifier}/history",
        token or ctx["tokens"][0],
        params=params,
    )


def test_full_workflow_correction_resubmit_history_and_relogin(context):
    c = context
    identifier = c["application"]()
    student_token = c["login"]()
    assert history(c, identifier, student_token).json()["items"] == []  # legacy row
    started = c["review"](identifier, "start_review", 1)
    assert started.status_code == 200, started.text
    assert started.json()["reviewer_user_id"] == str(c["actors"][0])
    returned = c["review"](identifier, "return_for_correction", 2, comment="  Исправьте адрес  ")
    assert returned.status_code == 200
    assert returned.json()["feedback"] == "Исправьте адрес"
    resubmitted = c["request"](
        "POST",
        f"/api/v1/applications/{identifier}/resubmit",
        student_token,
        json={"expected_version": 3, "form_data": {"place_of_submission": "  Corrected  "}},
    )
    assert resubmitted.status_code == 200, resubmitted.text
    assert resubmitted.json()["id"] == str(identifier)
    assert resubmitted.json()["feedback"] is None
    assert resubmitted.json()["version"] == 4
    detail = c["request"]("GET", f"/api/v1/staff/applications/{identifier}", c["tokens"][1])
    assert detail.json()["reviewer_user_id"] is None
    assert c["review"](identifier, "start_review", 4, index=1).status_code == 200
    approved = c["review"](identifier, "approve", 5, index=1)
    assert approved.status_code == 200
    assert approved.json()["review_status"] == "approved"
    assert approved.json()["document_status"] == "pending"
    # Fresh authenticated session and DB session must return persisted state/history.
    fresh = c["login"]()
    detail = c["request"]("GET", f"/api/v1/applications/{identifier}", fresh).json()
    assert detail == {
        k: v for k, v in approved.json().items() if k not in ("student_id", "reviewer_user_id")
    }
    assert detail["form_data"] == {"place_of_submission": "Corrected"}
    events = history(c, identifier, fresh).json()["items"]
    assert [(e["from_status"], e["to_status"]) for e in events] == [
        ("submitted", "in_review"),
        ("in_review", "needs_correction"),
        ("needs_correction", "resubmitted"),
        ("resubmitted", "in_review"),
        ("in_review", "approved"),
    ]
    assert [e["actor_user_id"] for e in events] == [
        str(i)
        for i in (
            c["actors"][0],
            c["actors"][0],
            c["student_users"][0],
            c["actors"][1],
            c["actors"][1],
        )
    ]
    assert events[1]["comment"] == "Исправьте адрес"
    timestamps = [datetime.fromisoformat(e["created_at"].replace("Z", "+00:00")) for e in events]
    assert all(t.utcoffset() is not None for t in timestamps)
    assert timestamps == sorted(timestamps)
    first = history(c, identifier, fresh, limit=2).json()
    second = history(c, identifier, fresh, limit=2, cursor=first["next_cursor"]).json()
    third = history(c, identifier, fresh, limit=2, cursor=second["next_cursor"]).json()
    assert first["items"] + second["items"] + third["items"] == events
    assert third["next_cursor"] is None
    assert history(c, identifier, staff=True).json()["items"] == events
    with Session(c["engine"]) as db:
        assert db.get(Student, c["students"][0]).academic_status == "enrolled"
        assert (
            db.get(Application, identifier).updated_at > db.get(Application, identifier).created_at
        )
        assert db.scalar(text("SELECT to_regclass('issued_documents')")) == "issued_documents"


@pytest.mark.parametrize("action", ["reject", "return_for_correction"])
def test_reasons_required_and_no_changes_for_invalid_requests(context, action):
    c = context
    identifier = c["application"](review_status="in_review")
    for reason in (None, "", " \n ", "x\x00", "\ud800", 42, "x" * 3001):
        extra = {} if reason is None else {"comment": reason}
        result = c["request"](
            "POST",
            f"/api/v1/staff/applications/{identifier}/review",
            c["tokens"][0],
            content=json.dumps(dict(action=action, expected_version=1, **extra)),
            headers={"Content-Type": "application/json"},
        )
        assert result.status_code == 422, result.text
    assert history(c, identifier, staff=True).json()["items"] == []
    result = c["review"](identifier, action, 1, comment="Обоснование")
    assert result.status_code == 200
    assert result.json()["feedback"] == "Обоснование"
    assert history(c, identifier, staff=True).json()["items"][0]["comment"] == "Обоснование"


@pytest.mark.parametrize(
    "status", ["submitted", "resubmitted", "needs_correction", "approved", "rejected"]
)
def test_invalid_review_transitions_do_not_change_anything(context, status):
    c = context
    identifier = c["application"](review_status=status)
    for action in ("approve", "reject", "return_for_correction"):
        result = c["review"](identifier, action, 1, comment="Reason")
        assert result.status_code == 409
        assert result.json()["error"]["code"] == "invalid_transition"
    if status not in ("submitted", "resubmitted"):
        assert c["review"](identifier, "start_review", 1).status_code == 409
    assert history(c, identifier, staff=True).json()["items"] == []
    with Session(c["engine"]) as db:
        row = db.get(Application, identifier)
        assert (row.version, row.review_status, row.feedback, row.reviewer_user_id) == (
            1,
            status,
            None,
            None,
        )


def test_automatic_service_ready_documents_and_unknown_forms_fail_closed(context):
    c = context
    with Session(c["engine"]) as db:
        automatic = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        automatic_id = automatic.id
    auto = c["application"](service_type_id=automatic_id, assigned_org_unit_id=c["unit_ids"][0])
    ready = c["application"](review_status="in_review", document_status="ready")
    for identifier in (auto, ready):
        assert (
            c["review"](
                identifier, "start_review" if identifier == auto else "approve", 1
            ).status_code
            == 409
        )
        assert history(c, identifier, staff=True).json()["items"] == []
    token = c["login"]()
    unknown = c["application"](review_status="needs_correction")
    with Session(c["engine"]) as db:
        code = db.get(ServiceType, c["service_id"]).code
    del workflow.APPLICATION_FORMS[code]
    response = c["request"](
        "POST",
        f"/api/v1/applications/{unknown}/resubmit",
        token,
        json={"expected_version": 1, "form_data": {"place_of_submission": "X"}},
    )
    assert response.status_code == 422
    assert history(c, unknown, token).json()["items"] == []


@pytest.mark.parametrize(
    "status", ["submitted", "in_review", "resubmitted", "approved", "rejected"]
)
def test_student_cannot_edit_unreturned_application(context, status):
    c = context
    identifier = c["application"](review_status=status)
    token = c["login"]()
    response = c["request"](
        "POST",
        f"/api/v1/applications/{identifier}/resubmit",
        token,
        json={"expected_version": 1, "form_data": {"place_of_submission": "Changed"}},
    )
    assert response.status_code == 409
    with Session(c["engine"]) as db:
        assert db.get(Application, identifier).form_data == {"place_of_submission": "Original"}
    assert history(c, identifier, token).json()["items"] == []


def test_access_scopes_owner_revocation_and_authentication(context):
    c = context
    identifier = c["application"]()
    missing = 9223372036854775807
    other = c["login"](1)
    student = c["login"]()
    for candidate in (identifier, missing):
        for suffix in ("", "/history"):
            assert (
                c["request"]("GET", f"/api/v1/applications/{candidate}{suffix}", other).status_code
                == 404
            )
            assert (
                c["request"](
                    "GET", f"/api/v1/staff/applications/{candidate}{suffix}", c["tokens"][2]
                ).status_code
                == 404
            )
            assert (
                c["request"](
                    "GET", f"/api/v1/staff/applications/{candidate}{suffix}", c["tokens"][3]
                ).status_code
                == 403
            )
            assert (
                c["request"]("GET", f"/api/v1/staff/applications/{candidate}{suffix}").status_code
                == 401
            )
        assert c["review"](candidate, "start_review", 1, index=2).status_code == 404
        assert c["review"](candidate, "start_review", 1, index=3).status_code == 403
        assert (
            c["request"](
                "POST",
                f"/api/v1/applications/{candidate}/resubmit",
                other,
                json={"expected_version": 1, "form_data": {"place_of_submission": "Stolen"}},
            ).status_code
            == 404
        )
    assert c["request"]("GET", "/api/v1/staff/applications", student).status_code == 403
    assert c["request"]("GET", "/api/v1/staff/applications", c["tokens"][2]).json()["items"] == []
    assigned = c["application"](assigned_org_unit_id=c["unit_ids"][1])
    assert (
        c["request"]("GET", f"/api/v1/staff/applications/{assigned}", c["tokens"][0]).status_code
        == 404
    )
    assert (
        c["request"]("GET", f"/api/v1/staff/applications/{assigned}", c["tokens"][2]).status_code
        == 200
    )
    queue = c["request"](
        "GET", "/api/v1/staff/applications", c["tokens"][0], params={"limit": 1}
    ).json()
    assert [a["id"] for a in queue["items"]] == [str(identifier)]
    with Session(c["engine"]) as db, db.begin():
        db.execute(
            delete(StaffPermission).where(StaffPermission.staff_profile_id == c["profiles"][0])
        )
    assert c["review"](identifier, "start_review", 1).status_code == 403
    assert history(c, identifier, staff=True).status_code == 403
    assert c["request"]("GET", "/api/v1/staff/applications", c["tokens"][0]).status_code == 403
    # Existing sessions cannot retain access after a department/role change.
    with Session(c["engine"]) as db, db.begin():
        db.get(StaffProfile, c["profiles"][1]).org_unit_id = c["unit_ids"][1]
    assert c["review"](identifier, "start_review", 1, index=1).status_code == 403


def test_submission_records_initial_event_atomically_and_keeps_mvp1_automatic_contract(context):
    c = context
    token = c["login"]()
    response = c["request"](
        "POST",
        "/api/v1/applications",
        token,
        json={"service_code": "study_certificate", "form_data": {"place_of_submission": "X"}},
    )
    assert response.status_code == 201
    body = response.json()
    assert (body["version"], body["review_status"]) == (2, "approved")
    assert body["document_status"] in {"ready", "failed"}
    events = history(c, body["id"], token).json()["items"]
    assert len(events) == 2
    assert (events[0]["from_status"], events[0]["to_status"], events[0]["actor_user_id"]) == (
        None,
        "submitted",
        str(c["student_users"][0]),
    )
    assert (events[1]["from_status"], events[1]["to_status"], events[1]["actor_user_id"]) == (
        "submitted",
        "approved",
        None,
    )


def test_two_staff_sessions_race_first_commit_wins_without_partial_history(context):
    from threading import Barrier

    c = context
    identifier = c["application"]()
    barrier = Barrier(2)
    statements = []

    def synchronize_updates(_conn, _cursor, statement, parameters, _context, _many):
        if statement.startswith("UPDATE applications SET"):
            statements.append(statement)
            barrier.wait(timeout=10)

    event.listen(c["engine"], "before_cursor_execute", synchronize_updates)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(c["review"], identifier, "start_review", 1, index=i) for i in (0, 1)
            ]
            results = [future.result(timeout=20) for future in futures]
    finally:
        event.remove(c["engine"], "before_cursor_execute", synchronize_updates)
    assert sorted(result.status_code for result in results) == [200, 409]
    loser = next(result for result in results if result.status_code == 409)
    assert loser.json()["error"]["code"] == "version_conflict"
    assert len(statements) == 2
    assert all("applications.version =" in sql and "applications.id =" in sql for sql in statements)
    winner = results.index(next(result for result in results if result.status_code == 200))
    events = history(c, identifier, staff=True).json()["items"]
    assert len(events) == 1
    assert events[0]["actor_user_id"] == str(c["actors"][winner])
    with Session(c["engine"]) as db:
        row = db.get(Application, identifier)
        snapshot = (row.version, row.review_status, row.reviewer_user_id, row.updated_at)
        assert snapshot[:3] == (2, "in_review", c["actors"][winner])
    assert c["review"](identifier, "reject", 1, comment="Stale reason").status_code == 409
    with Session(c["engine"]) as db:
        row = db.get(Application, identifier)
        assert (row.version, row.review_status, row.reviewer_user_id, row.updated_at) == snapshot
        assert row.feedback is None
    assert history(c, identifier, staff=True).json()["items"] == events


def test_explicit_rollback_and_database_history_failure_rollback_parent_and_creation(context):
    c = context
    identifier = c["application"]()
    with Session(c["engine"]) as db:
        user = db.get(User, c["actors"][0])
        workflow.review_application(
            db,
            user,
            identifier,
            ReviewApplicationRequest(action="start_review", expected_version=1),
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(ApplicationHistory)
                .where(ApplicationHistory.application_id == identifier)
            )
            == 1
        )
        with Session(c["engine"]) as observer:
            assert observer.get(Application, identifier).version == 1
            assert not observer.scalar(
                select(ApplicationHistory.id).where(ApplicationHistory.application_id == identifier)
            )
        db.rollback()
    with Session(c["engine"]) as db:
        assert db.get(Application, identifier).version == 1
    # Force a real PostgreSQL error in the second write, after UPDATE/INSERT.
    with c["engine"].begin() as connection:
        connection.execute(
            text("""
            CREATE FUNCTION workflow_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'Fictional history failure'; END $$;
            CREATE TRIGGER workflow_history_failure BEFORE INSERT ON application_history
            FOR EACH ROW EXECUTE FUNCTION workflow_history_failure();
        """)
        )
    try:
        student = c["login"]()
        result = c["review"](identifier, "start_review", 1)
        assert result.status_code == 500
        with Session(c["engine"]) as db:
            count = db.scalar(select(func.count()).select_from(Application))
        created = c["request"](
            "POST",
            "/api/v1/applications",
            student,
            json={"service_code": "study_certificate", "form_data": {"place_of_submission": "X"}},
        )
        assert created.status_code == 500
        with Session(c["engine"]) as db:
            row = db.get(Application, identifier)
            assert (row.version, row.review_status, row.updated_at) == (
                1,
                "submitted",
                row.created_at,
            )
            assert db.scalar(select(func.count()).select_from(Application)) == count
            assert not db.scalar(
                select(ApplicationHistory.id).where(ApplicationHistory.application_id == identifier)
            )
    finally:
        with c["engine"].begin() as connection:
            connection.execute(text("DROP TRIGGER workflow_history_failure ON application_history"))
            connection.execute(text("DROP FUNCTION workflow_history_failure()"))
    assert c["review"](identifier, "start_review", 1).status_code == 200


def test_resubmit_conflict_and_failure_do_not_save_form_or_clear_reason(context):
    c = context
    identifier = c["application"](
        review_status="needs_correction",
        feedback="Original reason",
        reviewer_user_id=c["actors"][0],
        version=3,
    )
    token = c["login"]()
    for payload in (
        {"expected_version": 2, "form_data": {"place_of_submission": "Stale"}},
        {"expected_version": 3, "form_data": {"place_of_submission": "X", "extra": "forged"}},
    ):
        result = c["request"](
            "POST", f"/api/v1/applications/{identifier}/resubmit", token, json=payload
        )
        assert result.status_code in (409, 422)
    with Session(c["engine"]) as db:
        row = db.get(Application, identifier)
        # A real FK failure during history insertion invalidates the transaction.
        with pytest.raises(IntegrityError):
            workflow.update_application(
                db,
                row,
                expected_version=3,
                actor_user_id=9223372036854775807,
                access_predicate=Application.student_id == c["students"][0],
                from_statuses={"needs_correction"},
                to_status="resubmitted",
                form_data={"place_of_submission": "Must rollback"},
            )
        db.rollback()
    with Session(c["engine"]) as db:
        row = db.get(Application, identifier)
        assert (row.version, row.review_status, row.feedback, row.reviewer_user_id) == (
            3,
            "needs_correction",
            "Original reason",
            c["actors"][0],
        )
        assert row.form_data == {"place_of_submission": "Original"}
    assert history(c, identifier, token).json()["items"] == []


def test_new_endpoints_reject_forged_fields_versions_queries_and_missing_auth(context):
    c = context
    identifier = c["application"]()
    student = c["login"]()
    review_path = f"/api/v1/staff/applications/{identifier}/review"
    resubmit_path = f"/api/v1/applications/{identifier}/resubmit"
    for path, payload in (
        (review_path, {"action": "start_review", "expected_version": 1}),
        (resubmit_path, {"expected_version": 1, "form_data": {"place_of_submission": "X"}}),
    ):
        assert c["request"]("POST", path, json=payload).status_code == 401
    assert (
        c["request"](
            "POST", review_path, student, json={"action": "start_review", "expected_version": 1}
        ).status_code
        == 403
    )
    for version in (None, True, "1", 0, -1, 1.5, 2147483648):
        assert (
            c["request"](
                "POST",
                review_path,
                c["tokens"][0],
                json={"action": "start_review", "expected_version": version},
            ).status_code
            == 422
        )
    for extra in (
        "actor_user_id",
        "reviewer_user_id",
        "assigned_org_unit_id",
        "review_status",
        "document_status",
    ):
        assert c["review"](identifier, "start_review", 1, **{extra: "1"}).status_code == 422
    for path in (
        f"/api/v1/staff/applications/{identifier}",
        f"/api/v1/staff/applications/{identifier}/history",
        "/api/v1/staff/applications",
    ):
        assert (
            c["request"]("GET", path, c["tokens"][0], params={"student_id": "1"}).status_code == 422
        )
    assert (
        c["request"](
            "GET", "/api/v1/staff/applications/9223372036854775808", c["tokens"][0]
        ).status_code
        == 422
    )
    assert history(c, identifier, staff=True, cursor="bad").status_code == 422
    assert history(c, identifier, staff=True).json()["items"] == []
    # No responsible scope means no access, including the queue.
    with Session(c["engine"]) as db, db.begin():
        db.get(ServiceType, c["service_id"]).responsible_org_unit_id = None
    assert c["request"]("GET", "/api/v1/staff/applications", c["tokens"][0]).json()["items"] == []
    assert c["review"](identifier, "start_review", 1).status_code == 404


def test_academic_leave_approval_preserves_student_status_and_document_not_required(context):
    c = context
    with Session(c["engine"]) as db:
        service = db.scalar(select(ServiceType).where(ServiceType.code == "academic_leave"))
        assert service is not None
        service_id = service.id
    identifier = c["application"](
        service_type_id=service_id,
        assigned_org_unit_id=c["unit_ids"][0],
        document_status="not_required",
    )
    assert c["review"](identifier, "start_review", 1).status_code == 200
    approved = c["review"](identifier, "approve", 2)
    assert approved.status_code == 200
    assert approved.json()["document_status"] == "not_required"
    with Session(c["engine"]) as db:
        assert db.get(Student, c["students"][0]).academic_status == "enrolled"


@pytest.mark.parametrize(
    ("actor", "timing", "change_version"),
    [
        ("staff", "before_update", False),
        ("student", "before_update", False),
        ("staff", "while_locked", False),
        ("student", "while_locked", False),
        ("staff", "before_update", True),
        ("student", "before_update", True),
        ("staff_fallback", "before_update", False),
        ("staff_unassign", "before_update", False),
    ],
)
def test_concurrent_reassignment_denies_workflow_without_business_changes(
    context, actor, timing, change_version
):
    from threading import Event
    from time import monotonic, sleep

    c = context
    is_staff = actor.startswith("staff")
    if actor == "staff_unassign":
        with Session(c["engine"]) as db, db.begin():
            db.get(ServiceType, c["service_id"]).responsible_org_unit_id = c["unit_ids"][1]
    identifier = c["application"](
        assigned_org_unit_id=c["unit_ids"][0] if actor in ("staff", "staff_unassign") else None,
        review_status="submitted" if is_staff else "needs_correction",
        feedback="Preserve reason",
        reviewer_user_id=c["actors"][0],
    )
    student_token = c["login"]()
    before_update = Event()
    continue_update = Event()
    workflow_pids = []

    def pause_workflow_update(connection, _cursor, statement, _params, _context, _many):
        if (
            statement.startswith("UPDATE applications SET")
            and "applications.version =" in statement
        ):
            workflow_pids.append(connection.scalar(text("SELECT pg_backend_pid()")))
            before_update.set()
            assert continue_update.wait(timeout=15)

    def request_change():
        if is_staff:
            return c["review"](identifier, "start_review", 1)
        return c["request"](
            "POST",
            f"/api/v1/applications/{identifier}/resubmit",
            student_token,
            json={"expected_version": 1, "form_data": {"place_of_submission": "Must not save"}},
        )

    event.listen(c["engine"], "before_cursor_execute", pause_workflow_update)
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(request_change)
            try:
                assert before_update.wait(timeout=10)  # access SELECT has already succeeded
                with Session(c["engine"]) as admin:
                    admin_pid = admin.scalar(text("SELECT pg_backend_pid()"))
                    assert admin_pid != workflow_pids[0]
                    column = "assigned_org_unit_id" if is_staff else "student_id"
                    target = c["unit_ids"][1] if is_staff else c["students"][1]
                    if actor == "staff_unassign":
                        target = None
                    version_change = ", version=version+1" if change_version else ""
                    if actor == "staff_fallback":
                        admin.execute(
                            text(
                                "UPDATE service_types SET responsible_org_unit_id=:target "
                                "WHERE id=:id"
                            ),
                            {"target": target, "id": c["service_id"]},
                        )
                    else:
                        admin.execute(
                            text(
                                f"UPDATE applications SET {column}=:target{version_change} "
                                "WHERE id=:id"
                            ),
                            {"target": target, "id": identifier},
                        )
                    snapshot = admin.scalar(
                        text("SELECT to_jsonb(a) FROM applications a WHERE id=:id"),
                        {"id": identifier},
                    )
                    if timing == "while_locked":
                        # Ensure UPDATE started with the old READ COMMITTED snapshot
                        # and is waiting for the administrative transaction's row lock.
                        continue_update.set()
                        deadline = monotonic() + 10
                        with c["engine"].connect() as observer:
                            while not observer.scalar(
                                text("SELECT :admin = ANY(pg_blocking_pids(:workflow))"),
                                {"admin": admin_pid, "workflow": workflow_pids[0]},
                            ):
                                assert monotonic() < deadline
                                sleep(0.01)
                    admin.commit()
                # Confirm the reassignment is committed on an independent connection.
                with c["engine"].connect() as observer:
                    assert (
                        observer.scalar(
                            text("SELECT to_jsonb(a) FROM applications a WHERE id=:id"),
                            {"id": identifier},
                        )
                        == snapshot
                    )
                continue_update.set()
                response = future.result(timeout=15)
            finally:
                continue_update.set()
    finally:
        event.remove(c["engine"], "before_cursor_execute", pause_workflow_update)
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"
    with c["engine"].connect() as observer:
        assert (
            observer.scalar(
                text("SELECT to_jsonb(a) FROM applications a WHERE id=:id"), {"id": identifier}
            )
            == snapshot
        )  # includes version, status, form, feedback, reviewer and timestamps
        assert (
            observer.scalar(
                text("SELECT count(*) FROM application_history WHERE application_id=:id"),
                {"id": identifier},
            )
            == 0
        )
