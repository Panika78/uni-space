from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, Lock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.orm import Session
from test_student_course_integration import course as course_fixture

from app.applications.router import router as applications_router
from app.auth.security import create_access_token
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.dependencies.database import get_db_session
from app.models import (
    Application,
    AuthSession,
    LessonGroup,
    Notification,
    OrgUnit,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Subgroup,
    User,
)
from app.notifications import router

pytestmark = pytest.mark.integration
BASE = "/api/v1/notifications"


@pytest.fixture
def notifications(db_session):
    s = course_fixture.__wrapped__(db_session)
    s.app.include_router(router)
    s.app.include_router(applications_router)

    def add_notification(user=None, **kwargs):
        return s.add(
            Notification,
            user_id=(user or s.users[0]).id,
            type="unknown-kind",
            title="Вымышленное сообщение",
            body="Текст",
            **kwargs,
        )

    def request(method, suffix="", headers=None, **kwargs):
        return s.client.request(method, BASE + suffix, headers=headers or s.headers(), **kwargs)

    s.notification, s.notify = add_notification, request
    return s


def test_read_contract_count_pagination_and_idempotency(notifications):
    s = notifications
    assert s.notify("GET", "/unread-count").json() == {"count": 0}
    original = datetime(2020, 1, 1, tzinfo=UTC)
    old = s.notification(read_at=original)
    rows = [s.notification() for _ in range(24)]
    other = s.notification(s.users[1])
    first = s.notify("GET", params={"limit": 2}).json()
    assert len(first["items"]) == 2 and first["next_cursor"]
    assert all(
        row["read_at"] is None and row["entity_type"] is None and row["entity_id"] is None
        for row in first["items"]
    )
    assert s.notify("GET", "/unread-count").json() == {"count": 24}
    assert s.notify("GET", "/unread-count").json() == {"count": 24}  # reads do not mark
    mark = s.notify("PATCH", f"/{rows[0].id}/read")
    assert mark.status_code == 200, mark.text
    assert mark.json()["id"] == str(rows[0].id)
    assert datetime.fromisoformat(
        mark.json()["read_at"].replace("Z", "+00:00")
    ).utcoffset() == timedelta(0)
    assert s.notify("PATCH", f"/{rows[0].id}/read").json() == mark.json()
    assert s.notify("POST", "/read-all").json() == {"updated_count": 23}
    assert s.notify("POST", "/read-all").json() == {"updated_count": 0}
    assert s.notify("GET", "/unread-count").json() == {"count": 0}
    s.db.refresh(old)
    s.db.refresh(other)
    assert old.read_at == original and other.read_at is None
    assert s.notify("PATCH", f"/{rows[0].id}/read").json() == mark.json()
    s.notification()
    assert s.notify("GET", "/unread-count").json() == {"count": 1}
    assert s.notify("GET", params={"limit": 100}).json()["items"][-1]["id"] == str(old.id)


def test_all_roles_own_notifications_and_uniform_not_found(notifications):
    s = notifications
    for role in ("student", "teacher", "staff", "admin"):
        user = s.add(
            User,
            login=uuid4().hex,
            password_hash="unused",
            full_name="Вымышленный пользователь",
            role=role,
            is_active=True,
        )
        session = s.add(
            AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
        )
        headers = {
            "Authorization": "Bearer " + create_access_token(session, s.settings)["access_token"]
        }
        own = s.notification(user)
        other = s.notification()
        assert [n["id"] for n in s.notify("GET", headers=headers).json()["items"]] == [str(own.id)]
        assert s.notify("GET", "/unread-count", headers=headers).json() == {"count": 1}
        for suffix, method in (("read", "PATCH"), ("target", "GET")):
            foreign = s.notify(method, f"/{other.id}/{suffix}", headers=headers)
            missing = s.notify(method, f"/9223372036854775807/{suffix}", headers=headers)
            assert foreign.status_code == missing.status_code == 404
            assert foreign.json() == missing.json()
        assert s.notify("PATCH", f"/{own.id}/read", headers=headers).status_code == 200
        assert s.notify("POST", "/read-all", headers=headers).json() == {"updated_count": 0}
        session.revoked_at = datetime.now(UTC)
        s.db.flush()
        for method, suffix in (
            ("GET", ""),
            ("GET", "/unread-count"),
            ("GET", f"/{own.id}/target"),
            ("PATCH", f"/{own.id}/read"),
            ("POST", "/read-all"),
        ):
            assert s.notify(method, suffix, headers=headers).status_code == 401
            if method in {"PATCH", "POST"}:
                assert s.notify(method, suffix, headers=headers, json={}).status_code == 401


def test_targets_reuse_current_student_acl_and_never_mark_on_get(notifications):
    s = notifications
    lesson = s.lesson(-1)
    offering = s.courses[0]
    unit = s.add(OrgUnit, name="Вымышленное подразделение", type="dean_office")
    service = s.add(
        ServiceType,
        code=uuid4().hex,
        title="Вымышленная услуга",
        processing_mode="manual",
        produces_document=False,
        responsible_org_unit_id=unit.id,
    )
    application = s.add(
        Application,
        student_id=s.students[0].id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="not_required",
        form_data={},
    )
    targets = [
        (
            "lesson",
            lesson.id,
            f"/schedule?date={lesson.starts_at.date()}&mode=day&lesson_id={lesson.id}",
        ),
        ("course_offering", offering.id, f"/academics/courses/{offering.id}"),
        ("application", application.id, f"/applications/{application.id}"),
    ]
    for kind, identifier, path in targets:
        item = s.notification(entity_type=kind, entity_id=identifier)
        result = s.notify("GET", f"/{item.id}/target")
        assert result.status_code == 200, result.text
        assert result.json() == {"path": path}
        serialized = next(
            n
            for n in s.notify("GET", params={"limit": 100}).json()["items"]
            if n["id"] == str(item.id)
        )
        assert serialized["entity_type"] == kind and serialized["entity_id"] == str(identifier)
        assert serialized["read_at"] is None
        for student in (1,):
            wrong = s.notification(s.users[student], entity_type=kind, entity_id=identifier)
            # course 0 contains both groups; use course 1 below for isolation.
            if kind != "course_offering":
                assert (
                    s.notify("GET", f"/{wrong.id}/target", headers=s.headers(student)).status_code
                    == 404
                )
    course_item = s.notification(entity_type="course_offering", entity_id=s.courses[1].id)
    lesson_item = s.notification(entity_type="lesson", entity_id=lesson.id)
    s.students[0].group_id = s.groups[1].id
    s.db.flush()
    assert s.notify("GET", f"/{course_item.id}/target").status_code == 404
    assert (
        s.client.get(
            f"/api/v1/academics/courses/{s.courses[1].id}", headers=s.headers()
        ).status_code
        == 404
    )
    assert s.notify("GET", f"/{lesson_item.id}/target").status_code == 404
    assert str(lesson.id) not in s.schedule()
    application.student_id = s.students[1].id
    s.db.flush()
    assert (
        s.client.get(f"/api/v1/applications/{application.id}", headers=s.headers()).status_code
        == 404
    )


def test_staff_target_permission_scope_and_final_api_recheck(notifications):
    s = notifications
    unit, other_unit = [s.add(OrgUnit, name=uuid4().hex, type="dean_office") for _ in range(2)]
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Сотрудник",
        role="staff",
        is_active=True,
    )
    profile = s.add(StaffProfile, user_id=user.id, org_unit_id=unit.id)
    grant = s.add(
        StaffPermission,
        staff_profile_id=profile.id,
        permission_code="applications.review",
        scope_org_unit_id=unit.id,
    )
    session = s.add(AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
    headers = {
        "Authorization": "Bearer " + create_access_token(session, s.settings)["access_token"]
    }
    service = s.add(
        ServiceType,
        code=uuid4().hex,
        title="Услуга",
        processing_mode="manual",
        produces_document=False,
        responsible_org_unit_id=unit.id,
    )
    application = s.add(
        Application,
        student_id=s.students[0].id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="not_required",
        form_data={},
    )
    item = s.notification(user, entity_type="application", entity_id=application.id)
    target = f"/{item.id}/target"
    assert s.notify("GET", target, headers=headers).json() == {
        "path": f"/staff/applications/{application.id}"
    }
    assert (
        s.client.get(f"/api/v1/staff/applications/{application.id}", headers=headers).status_code
        == 200
    )
    application.assigned_org_unit_id = other_unit.id
    s.db.flush()
    assert s.notify("GET", target, headers=headers).status_code == 404
    assert (
        s.client.get(f"/api/v1/staff/applications/{application.id}", headers=headers).status_code
        == 404
    )
    application.assigned_org_unit_id = None
    s.db.delete(grant)
    s.db.flush()
    assert s.notify("GET", target, headers=headers).status_code == 404
    assert (
        s.client.get(f"/api/v1/staff/applications/{application.id}", headers=headers).status_code
        == 403
    )
    assert s.notify("GET", "/unread-count", headers=headers).json() == {"count": 1}


@pytest.mark.parametrize(
    "kind,identifier",
    [
        (None, None),
        ("lesson", None),
        (None, 1),
        ("https://evil.example", 1),
        ("discipline", 1),
        ("lesson", 9223372036854775807),
    ],
)
def test_missing_unknown_and_deleted_targets_are_uniform_and_explicitly_readable(
    notifications, kind, identifier
):
    s = notifications
    item = s.notification(entity_type=kind, entity_id=identifier)
    response = s.notify("GET", f"/{item.id}/target")
    assert response.status_code == 404
    assert s.notify("GET", "/unread-count").json() == {"count": 1}
    assert s.notify("PATCH", f"/{item.id}/read").status_code == 200


def test_mutation_and_resolver_reject_invalid_ids_and_parameters(notifications):
    s = notifications
    item = s.notification()
    for method, suffix in (
        ("GET", "/unread-count"),
        ("POST", "/read-all"),
        ("PATCH", f"/{item.id}/read"),
        ("GET", f"/{item.id}/target"),
    ):
        assert s.notify(method, suffix, params={"user_id": s.users[1].id}).status_code == 422
    for method, suffix in (("POST", "/read-all"), ("PATCH", f"/{item.id}/read")):
        assert s.notify(method, suffix, json={}).status_code == 422
    for identifier in ("0", "-1", "abc", "9223372036854775808", "9" * 5000):
        for method, suffix in (("PATCH", "read"), ("GET", "target")):
            assert s.notify(method, f"/{identifier}/{suffix}").status_code == 422


@pytest.mark.parametrize("operations", [("single", "single"), ("single", "all"), ("all", "all")])
def test_concurrent_api_reads_preserve_first_timestamp_and_exact_update_count(
    postgresql_engine, operations
):
    settings = Settings(
        _env_file=None,
        app_env="test",
        jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )
    with Session(postgresql_engine) as db:
        user = User(
            login=uuid4().hex,
            password_hash="unused",
            full_name="Параллельный тест",
            role="teacher",
            is_active=True,
        )
        db.add(user)
        db.flush()
        session = AuthSession(user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
        db.add(session)
        rows = [
            Notification(user_id=user.id, type="test", title="Тест", body="Текст") for _ in range(6)
        ]
        db.add_all(rows)
        db.commit()
        user_id, session_id, item_id = user.id, session.id, rows[0].id
        headers = {
            "Authorization": "Bearer " + create_access_token(session, settings)["access_token"]
        }
    barrier = Barrier(2)
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[get_settings] = lambda: settings

    def get_db():
        with Session(postgresql_engine) as db:
            yield db

    app.dependency_overrides[get_db_session] = get_db

    def request(operation):
        barrier.wait(timeout=5)
        with TestClient(app) as client:
            return (
                client.patch(f"{BASE}/{item_id}/read", headers=headers)
                if operation == "single"
                else client.post(BASE + "/read-all", headers=headers)
            )

    updates_started = Event()
    counter_lock = Lock()
    update_count = 0

    def observe_updates(_connection, _cursor, statement, _parameters, _context, _many):
        nonlocal update_count
        if statement.startswith("UPDATE notifications "):
            with counter_lock:
                update_count += 1
                if update_count == 2:
                    updates_started.set()

    event.listen(postgresql_engine, "before_cursor_execute", observe_updates)
    try:
        # Hold a real PostgreSQL lock until both API mutations reach UPDATE.
        # This makes the race exercise predicate rechecking after a lock wait.
        with Session(postgresql_engine) as locker, ThreadPoolExecutor(max_workers=2) as pool:
            locker.scalar(select(Notification).where(Notification.id == item_id).with_for_update())
            futures = [pool.submit(request, operation) for operation in operations]
            have_concurrent_updates = updates_started.wait(timeout=10)
            locker.rollback()
            responses = [future.result(timeout=10) for future in futures]
            assert have_concurrent_updates

        assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
        with TestClient(app) as client:
            first = client.patch(f"{BASE}/{item_id}/read", headers=headers).json()
            repeated = client.patch(f"{BASE}/{item_id}/read", headers=headers).json()
            assert first == repeated
            for operation, response in zip(operations, responses, strict=True):
                if operation == "single":
                    assert response.json() == first
            counts = sum(
                r.json()["updated_count"]
                for op, r in zip(operations, responses, strict=True)
                if op == "all"
            )
            if operations == ("all", "all"):
                assert sorted(r.json()["updated_count"] for r in responses) == [0, 6]
            elif operations == ("single", "all"):
                assert counts in (5, 6)
            else:
                assert counts == 0
            if "all" in operations:
                assert client.get(BASE + "/unread-count", headers=headers).json() == {"count": 0}
                assert client.post(BASE + "/read-all", headers=headers).json() == {
                    "updated_count": 0
                }
            else:
                assert client.get(BASE + "/unread-count", headers=headers).json() == {"count": 5}
        with Session(postgresql_engine) as db:
            marks = db.scalars(
                select(Notification.read_at).where(Notification.user_id == user_id)
            ).all()
            assert sum(value is not None for value in marks) == (6 if "all" in operations else 1)
    finally:
        event.remove(postgresql_engine, "before_cursor_execute", observe_updates)
        with Session(postgresql_engine) as db:
            db.execute(delete(Notification).where(Notification.user_id == user_id))
            db.execute(delete(AuthSession).where(AuthSession.id == session_id))
            db.execute(delete(User).where(User.id == user_id))
            db.commit()


def test_lesson_target_tracks_formal_subgroup_and_deleted_target(notifications):
    s = notifications
    subgroups = [s.add(Subgroup, group_id=s.groups[0].id, name=name) for name in ("А", "Б")]
    lesson = s.lesson(-1, subgroup=subgroups[0].id)
    item = s.notification(entity_type="lesson", entity_id=lesson.id)
    path = f"/{item.id}/target"
    # An unassigned student receives whole-group lessons only.
    assert s.notify("GET", path).status_code == 404
    s.students[0].subgroup_id = subgroups[0].id
    s.db.flush()
    assert s.notify("GET", path).status_code == 200
    assert str(lesson.id) in s.schedule()
    s.students[0].subgroup_id = subgroups[1].id
    s.db.flush()
    assert s.notify("GET", path).status_code == 404
    assert str(lesson.id) not in s.schedule()
    # Targets have no FK: a removed object leaves a readable notification.
    s.db.execute(delete(LessonGroup).where(LessonGroup.lesson_id == lesson.id))
    s.db.delete(lesson)
    s.db.flush()
    assert s.notify("GET", path).status_code == 404
    assert s.notify("GET", "/unread-count").json() == {"count": 1}
    assert s.notify("PATCH", f"/{item.id}/read").status_code == 200


def test_lesson_target_uses_moscow_calendar_date_at_utc_day_boundary(notifications):
    s = notifications
    lesson = s.lesson(-1)
    lesson.starts_at = datetime.combine(s.today, datetime.min.time(), UTC) - timedelta(hours=2)
    lesson.ends_at = lesson.starts_at + timedelta(hours=1)
    s.db.flush()
    item = s.notification(entity_type="lesson", entity_id=lesson.id)
    assert s.notify("GET", f"/{item.id}/target").json() == {
        "path": f"/schedule?date={s.today.isoformat()}&mode=day&lesson_id={lesson.id}"
    }
