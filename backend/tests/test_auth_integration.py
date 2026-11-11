import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from typing import Annotated
from uuid import uuid4

import httpx
import jwt
import pytest
from fastapi import Depends, FastAPI
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.orm import Session

from app.auth import router as auth_routes
from app.auth.rate_limit import LoginRateLimiter
from app.auth.router import COOKIE_NAME, COOKIE_PATH, router
from app.auth.security import PASSWORD_HASHER
from app.auth.service import hash_refresh_token
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.models import (
    AuthSession,
    Notification,
    OrgUnit,
    Program,
    RefreshToken,
    Student,
    StudyGroup,
    User,
)
from app.notifications import router as notification_routes

pytestmark = pytest.mark.integration
PASSWORD = "fictional-auth-password"
ORIGIN = "https://uni.example"
KEY = "test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"


class AuthClient:
    def __init__(self, app):
        self.app = app

    def request(self, method, path, *, token=None, access=None, origin=ORIGIN, **kwargs):
        headers = kwargs.pop("headers", {})
        if origin is not None:
            headers["Origin"] = origin
        if token is not None:
            headers["Cookie"] = f"{COOKIE_NAME}={token}"
        if access is not None:
            headers["Authorization"] = f"Bearer {access}"

        async def send():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app), base_url=ORIGIN
            ) as client:
                return await client.request(method, path, headers=headers, **kwargs)

        return asyncio.run(send())

    def login(self, **kwargs):
        return self.request("POST", COOKIE_PATH + "/login", **kwargs)

    def refresh(self, token, **kwargs):
        return self.request("POST", COOKIE_PATH + "/refresh", token=token, **kwargs)

    def logout(self, token=None, **kwargs):
        return self.request("POST", COOKIE_PATH + "/logout", token=token, **kwargs)


@pytest.fixture
def auth(postgresql_engine, monkeypatch):
    test_app = FastAPI()
    test_app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(test_app)
    test_app.include_router(router)
    test_app.include_router(notification_routes)
    settings = Settings(
        _env_file=None,
        app_env="test",
        jwt_signing_key=KEY,
        database_url="postgresql+psycopg://unused:unused@localhost/unused",
        allowed_origins=[ORIGIN],
    )

    def get_test_session():
        with Session(postgresql_engine, expire_on_commit=False) as db:
            yield db

    test_app.dependency_overrides[get_db_session] = get_test_session
    test_app.dependency_overrides[get_settings] = lambda: settings
    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter(limit=1000))

    @test_app.get("/api/v1/test/user")
    def get_test_user(user: Annotated[User, Depends(get_current_user)]):
        return {"id": str(user.id), "role": user.role}

    @test_app.get("/api/v1/test/student")
    def get_test_student(student: Annotated[Student, Depends(get_current_student)]):
        return {"id": str(student.id)}

    unique = uuid4().hex
    with Session(postgresql_engine) as db:
        faculty = OrgUnit(name="Fictional Faculty", type="faculty")
        db.add(faculty)
        db.flush()
        program = Program(
            code=unique,
            name="Fictional Program",
            direction_code="00.00.00",
            direction_name="Fictional Direction",
            faculty_id=faculty.id,
        )
        db.add(program)
        db.flush()
        group = StudyGroup(name="Fictional Group", program_id=program.id, course_number=1)
        db.add(group)
        db.flush()
        users = [
            User(
                login=f"auth-{unique}-{i}",
                password_hash=PASSWORD_HASHER.hash(PASSWORD),
                full_name="Fictional Student",
                role="student",
                is_active=True,
            )
            for i in range(2)
        ]
        db.add_all(users)
        db.flush()
        students = [
            Student(user_id=user.id, group_id=group.id, academic_status="enrolled")
            for user in users
        ]
        db.add_all(students)
        db.flush()
        ids = [user.id for user in users]
        logins = [user.login for user in users]
        student_ids = [student.id for student in students]
        cleanup_ids = faculty.id, program.id, group.id
        db.commit()
    try:
        yield AuthClient(test_app), postgresql_engine, ids, logins, student_ids
    finally:
        with Session(postgresql_engine) as db, db.begin():
            db.execute(delete(Notification).where(Notification.user_id.in_(ids)))
            session_ids = select(AuthSession.id).where(AuthSession.user_id.in_(ids))
            db.execute(delete(RefreshToken).where(RefreshToken.session_id.in_(session_ids)))
            db.execute(delete(AuthSession).where(AuthSession.user_id.in_(ids)))
            db.execute(delete(Student).where(Student.user_id.in_(ids)))
            db.execute(delete(User).where(User.id.in_(ids)))
            db.execute(delete(StudyGroup).where(StudyGroup.id == cleanup_ids[2]))
            db.execute(delete(Program).where(Program.id == cleanup_ids[1]))
            db.execute(delete(OrgUnit).where(OrgUnit.id == cleanup_ids[0]))


def login(auth, index=0):
    client, _engine, _ids, logins, _student_ids = auth
    response = client.login(json={"login": logins[index], "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response, response.cookies[COOKIE_NAME], response.json()["access_token"]


def assert_logout(response, session_revoked):
    assert response.status_code == 200, response.text
    assert response.json() == {"session_revoked": session_revoked}


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    assert isinstance(response.json()["error"]["details"], list)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"]


def test_login_rotation_cookie_and_logout_revoke_access(auth):
    client, engine, ids, _logins, student_ids = auth
    response, old, access = login(auth)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"]
    assert response.json()["token_type"] == "bearer"
    cookie = response.headers["set-cookie"]
    for value in ["HttpOnly", "Secure", "SameSite=lax", f"Path={COOKIE_PATH}"]:
        assert value in cookie
    assert "Domain=" not in cookie
    assert client.request("GET", "/api/v1/test/user", access=access).json()["id"] == str(ids[0])
    assert client.request("GET", "/api/v1/test/student?student_id=999", access=access).json() == {
        "id": str(student_ids[0])
    }
    with Session(engine) as db:
        session = db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))
        expiry, sid = session.expires_at, session.id
        assert session.last_used_at is None
        first = db.scalar(select(RefreshToken).where(RefreshToken.session_id == sid))
        first_id = first.id
        assert first.token_hash == hash_refresh_token(old)
    result = client.refresh(old)
    assert result.status_code == 200
    current = result.cookies[COOKIE_NAME]
    assert current != old
    with Session(engine) as db:
        session = db.get(AuthSession, sid)
        assert session.expires_at == expiry
        assert session.last_used_at is not None
        first = db.get(RefreshToken, first_id)
        child = db.scalar(select(RefreshToken).where(RefreshToken.parent_token_id == first_id))
        assert first.used_at and not first.revoked_at
        assert child.session_id == sid and child.expires_at == expiry
        max_age = int(result.headers["set-cookie"].split("Max-Age=")[1].split(";")[0])
        assert 0 < max_age <= (expiry - datetime.now(UTC)).total_seconds()
    assert_logout(client.logout(current), True)
    assert_error(client.request("GET", "/api/v1/test/user", access=access), 401, "session_invalid")
    assert_error(client.refresh(current), 401, "invalid_refresh")


def test_successful_login_revokes_the_presented_browser_session(auth):
    client, engine, ids, logins, _student_ids = auth
    _response, previous_refresh, previous_access = login(auth)
    _response, independent_refresh, independent_access = login(auth)

    replacement = client.login(
        token=previous_refresh,
        json={"login": logins[0], "password": PASSWORD},
    )

    assert replacement.status_code == 200, replacement.text
    replacement_refresh = replacement.cookies[COOKIE_NAME]
    assert replacement_refresh != previous_refresh
    assert_error(
        client.request("GET", "/api/v1/test/user", access=previous_access),
        401,
        "session_invalid",
    )
    assert_error(client.refresh(previous_refresh), 401, "invalid_refresh")
    assert (
        client.request(
            "GET", "/api/v1/test/user", access=replacement.json()["access_token"]
        ).status_code
        == 200
    )
    assert client.request("GET", "/api/v1/test/user", access=independent_access).status_code == 200
    assert client.refresh(independent_refresh).status_code == 200

    with Session(engine) as db:
        sessions = db.scalars(
            select(AuthSession).where(AuthSession.user_id == ids[0]).order_by(AuthSession.id)
        ).all()
        assert len(sessions) == 3
        assert sessions[0].revoked_at is not None
        assert sessions[0].revocation_reason == "login_replaced"
        assert sessions[1].revoked_at is None
        assert sessions[2].revoked_at is None


def test_rejected_login_does_not_revoke_the_presented_browser_session(auth):
    client, _engine, _ids, logins, _student_ids = auth
    _response, refresh_token, access = login(auth)

    rejected = client.login(
        token=refresh_token,
        json={"login": logins[0], "password": "incorrect-fictional-password"},
    )

    assert_error(rejected, 401, "invalid_credentials")
    assert client.request("GET", "/api/v1/test/user", access=access).status_code == 200
    assert client.refresh(refresh_token).status_code == 200


def test_login_as_another_account_replaces_only_the_presented_cookie_session(auth):
    client, engine, ids, logins, _student_ids = auth
    _response, old_cookie, old_access = login(auth)
    _response, independent_cookie, independent_access = login(auth)

    rejected = client.login(
        token=old_cookie,
        json={"login": logins[1], "password": "incorrect-fictional-password"},
    )
    assert_error(rejected, 401, "invalid_credentials")
    assert client.request("GET", "/api/v1/test/user", access=old_access).status_code == 200

    replacement = client.login(
        token=old_cookie,
        json={"login": logins[1], "password": PASSWORD},
    )
    assert replacement.status_code == 200, replacement.text
    assert_error(
        client.request("GET", "/api/v1/test/user", access=old_access), 401, "session_invalid"
    )
    assert_error(client.refresh(old_cookie), 401, "invalid_refresh")
    assert client.request("GET", "/api/v1/test/user", access=independent_access).status_code == 200
    assert client.refresh(independent_cookie).status_code == 200
    replacement_user = client.request(
        "GET", "/api/v1/test/user", access=replacement.json()["access_token"]
    )
    assert replacement_user.status_code == 200
    assert replacement_user.json()["id"] == str(ids[1])
    with Session(engine) as db:
        sessions = db.scalars(select(AuthSession).where(AuthSession.user_id == ids[0])).all()
        assert sum(session.revocation_reason == "login_replaced" for session in sessions) == 1
        assert sum(session.revoked_at is None for session in sessions) == 1


def test_reuse_commits_revocation_and_keeps_other_session_independent(auth):
    client, engine, _ids, _logins, _student_ids = auth
    _response, old, access = login(auth)
    _response, independent, independent_access = login(auth)
    rotated = client.refresh(old)
    current = rotated.cookies[COOKIE_NAME]
    assert_error(client.refresh(old), 401, "invalid_refresh")
    with Session(engine) as db:
        token = db.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(current))
        )
        session = db.get(AuthSession, token.session_id)
        assert session.revoked_at and session.revocation_reason == "reuse_detected"
        assert all(
            t.revoked_at
            for t in db.scalars(select(RefreshToken).where(RefreshToken.session_id == session.id))
        )
    for bearer in [access, rotated.json()["access_token"]]:
        assert_error(
            client.request("GET", "/api/v1/test/user", access=bearer), 401, "session_invalid"
        )
    assert_error(client.refresh(current), 401, "invalid_refresh")
    assert client.request("GET", "/api/v1/test/user", access=independent_access).status_code == 200
    assert client.refresh(independent).status_code == 200


@pytest.mark.parametrize("condition", ["inactive", "expired", "revoked", "wrong_owner"])
def test_protected_request_rechecks_database(auth, condition):
    client, engine, ids, _logins, _student_ids = auth
    _response, token, access = login(auth)
    with Session(engine) as db, db.begin():
        session = db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))
        if condition == "inactive":
            db.get(User, ids[0]).is_active = False
        elif condition == "expired":
            session.created_at = datetime.now(UTC) - timedelta(days=2)
            session.expires_at = datetime.now(UTC) - timedelta(days=1)
        elif condition == "revoked":
            session.revoked_at = datetime.now(UTC)
        else:
            session.user_id = ids[1]
    assert_error(client.request("GET", "/api/v1/test/user", access=access), 401, "session_invalid")
    if condition != "wrong_owner":
        assert_error(client.refresh(token), 401, "invalid_refresh")


@pytest.mark.parametrize("condition", ["role", "missing_profile"])
def test_student_dependency_requires_current_role_and_profile(auth, condition):
    client, engine, ids, _logins, _student_ids = auth
    _response, _token, access = login(auth)
    with Session(engine) as db, db.begin():
        if condition == "role":
            db.get(User, ids[0]).role = "admin"
        else:
            db.execute(delete(Student).where(Student.user_id == ids[0]))
    assert_error(client.request("GET", "/api/v1/test/student", access=access), 403, "forbidden")


@pytest.mark.parametrize(
    "condition", ["unknown", "missing", "expired", "revoked", "other_parent", "outlives_session"]
)
def test_refresh_rejects_invalid_token_and_parent(auth, condition):
    client, engine, _ids, _logins, _student_ids = auth
    _response, token, _access = login(auth)
    if condition in {"unknown", "missing"}:
        token = "unknown-token" if condition == "unknown" else None
    else:
        with Session(engine) as db, db.begin():
            row = db.scalar(
                select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token))
            )
            if condition == "expired":
                row.created_at = datetime.now(UTC) - timedelta(days=2)
                row.expires_at = datetime.now(UTC) - timedelta(days=1)
            elif condition == "revoked":
                row.revoked_at = datetime.now(UTC)
            elif condition == "outlives_session":
                db.get(AuthSession, row.session_id).expires_at = datetime.now(UTC) + timedelta(
                    seconds=60
                )
        if condition == "other_parent":
            _response, other, _access = login(auth, 1)
            with Session(engine) as db, db.begin():
                row = db.scalar(
                    select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token))
                )
                other_row = db.scalar(
                    select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(other))
                )
                row.parent_token_id = other_row.id
    assert_error(client.refresh(token), 401, "invalid_refresh")


@pytest.mark.parametrize("token", [None, "unknown-token", "x" * 513])
def test_logout_without_valid_cookie_is_idempotent_and_clears_cookie(auth, token):
    client = auth[0]
    response = client.logout(token)
    assert_logout(response, False)
    cookie = response.headers["set-cookie"]
    assert "Max-Age=0" in cookie and f"Path={COOKIE_PATH}" in cookie
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    assert "Domain=" not in cookie


@pytest.mark.parametrize("path", ["login", "refresh", "logout"])
@pytest.mark.parametrize(
    "origin", [None, "null", "https://evil.example", ORIGIN + "/", ORIGIN + ".evil"]
)
def test_auth_rejects_missing_and_disallowed_origin(auth, path, origin):
    assert_error(
        auth[0].request("POST", COOKIE_PATH + "/" + path, origin=origin), 403, "origin_not_allowed"
    )


def test_auth_validation_rate_limit_and_no_secret_leaks(auth, monkeypatch, caplog):
    client, engine, ids, logins, _student_ids = auth
    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter())
    for index in range(5):
        response = client.login(
            json={"login": logins[0], "password": "incorrect-password"},
            headers={"X-Forwarded-For": f"192.0.2.{index}"},
        )
        assert_error(response, 401, "invalid_credentials")
    response = client.login(
        json={"login": logins[0], "password": PASSWORD}, headers={"X-Forwarded-For": "192.0.2.200"}
    )
    assert_error(response, 429, "rate_limited")
    assert 1 <= int(response.headers["Retry-After"]) <= 60
    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter(limit=1000))
    for body in [
        {"login": "unknown", "password": PASSWORD},
        {"login": logins[0], "password": "incorrect-password"},
    ]:
        assert_error(client.login(json=body), 401, "invalid_credentials")
    with Session(engine) as db, db.begin():
        db.get(User, ids[0]).is_active = False
    inactive = client.login(json={"login": logins[0], "password": PASSWORD})
    assert_error(inactive, 401, "invalid_credentials")
    for body in [
        {"login": logins[0], "password": PASSWORD, "extra": "private-extra"},
        {"login": 1, "password": PASSWORD},
        {"login": "", "password": ""},
        {"login": logins[0]},
        {"login": "x" * 257, "password": PASSWORD},
    ]:
        response = client.login(json=body)
        assert_error(response, 422, "validation_error")
        for secret in [PASSWORD, "private-extra", KEY]:
            assert secret not in response.text
    assert_error(client.refresh("private-refresh", content=b"{}"), 422, "validation_error")
    assert_error(client.logout(content=b"{}"), 422, "validation_error")
    assert_error(
        client.request("GET", "/api/v1/test/user", access="private-jwt"), 401, "invalid_access"
    )
    for secret in [PASSWORD, "incorrect-password", KEY, "private-refresh", "private-jwt"]:
        assert secret not in caplog.text
    with Session(engine) as db:
        assert not db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))


def test_login_rolls_back_session_if_first_token_insert_fails(auth):
    client, engine, ids, logins, _student_ids = auth

    def reject_token(_mapper, _connection, _target):
        raise RuntimeError("synthetic token insert failure")

    event.listen(RefreshToken, "before_insert", reject_token)
    try:
        response = client.login(json={"login": logins[0], "password": PASSWORD})
        assert_error(response, 500, "internal_error")
        assert "set-cookie" not in response.headers
    finally:
        event.remove(RefreshToken, "before_insert", reject_token)
    with Session(engine) as db:
        assert not db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))


def test_jwt_owner_signature_expiry_and_missing_bearer_over_http(auth):
    client = auth[0]
    _response, _token, access = login(auth)
    payload = jwt.decode(access, KEY, algorithms=["HS256"], audience="uni-space-api")
    for changes, expected in [
        ({"sub": str(auth[2][1])}, "session_invalid"),
        ({"exp": payload["iat"] - 1, "iat": payload["iat"] - 10}, "access_expired"),
        ({"sid": False}, "invalid_access"),
    ]:
        bad = jwt.encode(payload | changes, KEY, algorithm="HS256")
        assert_error(client.request("GET", "/api/v1/test/user", access=bad), 401, expected)
    assert_error(client.request("GET", "/api/v1/test/user"), 401, "invalid_access")


@pytest.mark.parametrize(
    "first_operation,second_operation",
    [
        ("refresh", "refresh"),
        ("refresh", "logout"),
        ("logout", "refresh"),
        ("refresh", "logout_bearer"),
        ("logout_bearer", "refresh"),
        ("logout_bearer", "logout_bearer"),
    ],
)
def test_concurrent_operations_wait_on_same_session_and_reread_state(
    auth, first_operation, second_operation
):
    import time
    from contextvars import ContextVar

    client, engine, ids, _logins, _student_ids = auth
    _response, token, access = login(auth)
    first_locked, release_first, second_started = Event(), Event(), Event()
    request_label = ContextVar("auth_test_request", default="")
    pids = {}
    failures = []

    # Both request sessions deliberately retain stale ORM objects across a commit.
    # The service must refresh them after acquiring the session lock.
    def get_preloaded_session():
        with Session(engine, expire_on_commit=False) as db:
            session = db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))
            refresh = db.scalar(
                select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token))
            )
            db.commit()
            assert session and refresh
            yield db

    client.app.dependency_overrides[get_db_session] = get_preloaded_session

    def before_query(connection, _cursor, statement, _parameters, _context, _many):
        if "FOR UPDATE" in statement and "auth_sessions" in statement:
            label = request_label.get()
            if label in {"auth-first", "auth-second"}:
                pids[label] = connection.connection.driver_connection.info.backend_pid
                if label == "auth-second":
                    second_started.set()

    def after_query(_connection, _cursor, statement, _parameters, _context, _many):
        if (
            "FOR UPDATE" in statement
            and "auth_sessions" in statement
            and request_label.get() == "auth-first"
        ):
            first_locked.set()
            if not release_first.wait(10):
                failures.append("first transaction timed out waiting for test release")

    def run(operation, label):
        request_label.set(label)
        return (
            client.logout(access=access)
            if operation == "logout_bearer"
            else getattr(client, operation)(token)
        )

    event.listen(engine, "before_cursor_execute", before_query)
    event.listen(engine, "after_cursor_execute", after_query)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(run, first_operation, "auth-first")
            try:
                assert first_locked.wait(5)
                second = pool.submit(run, second_operation, "auth-second")
                assert second_started.wait(5)
                assert pids["auth-first"] != pids["auth-second"]
                deadline = time.monotonic() + 5
                blocked = False
                while time.monotonic() < deadline:
                    with engine.connect() as monitor:
                        blockers = monitor.scalar(
                            text("SELECT pg_blocking_pids(:pid)"), {"pid": pids["auth-second"]}
                        )
                    if pids["auth-first"] in blockers:
                        blocked = True
                        break
                    time.sleep(0.01)
                assert blocked, "second PostgreSQL transaction did not wait for the first"
            finally:
                release_first.set()
            first_response, second_response = first.result(10), second.result(10)
        assert not failures
    finally:
        release_first.set()
        event.remove(engine, "before_cursor_execute", before_query)
        event.remove(engine, "after_cursor_execute", after_query)
        del client.app.dependency_overrides[get_db_session]

        # Restore the ordinary dependency after the concurrency-only preload.
        def get_test_session():
            with Session(engine, expire_on_commit=False) as db:
                yield db

        client.app.dependency_overrides[get_db_session] = get_test_session
    if first_operation == "refresh":
        assert first_response.status_code == 200
    else:
        assert_logout(first_response, True)
    if second_operation == "refresh":
        assert second_response.status_code == 401
    else:
        assert_logout(second_response, True)
    with Session(engine) as db:
        session = db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))
        assert session.revoked_at
        assert session.revocation_reason == (
            "reuse_detected" if first_operation == second_operation == "refresh" else "logout"
        )
        tokens = list(db.scalars(select(RefreshToken).where(RefreshToken.session_id == session.id)))
        assert len(tokens) == (2 if first_operation == "refresh" else 1)
        assert all(row.revoked_at is not None for row in tokens)
    assert_error(client.request("GET", "/api/v1/test/user", access=access), 401, "session_invalid")
    if first_operation == "refresh":
        current = first_response.cookies[COOKIE_NAME]
        assert_error(client.refresh(current), 401, "invalid_refresh")


@pytest.mark.parametrize("operation", ["refresh", "logout_bearer"])
def test_errors_and_logs_never_include_auth_values_even_on_internal_failure(
    auth, caplog, monkeypatch, operation
):
    import logging

    # Alembic's fileConfig disables pre-existing loggers in the migration fixture.
    # Re-enable the actual error logger so this test observes a real log record.
    monkeypatch.setattr(logging.getLogger("app.core.errors"), "disabled", False)
    client, engine, _ids, logins, _student_ids = auth
    response, refresh, access = login(auth)

    def reject_query(_connection, _cursor, statement, _parameters, _context, _many):
        if "FROM auth_sessions" in statement:
            raise RuntimeError(f"synthetic failure {PASSWORD} {KEY} {refresh} {access}")

    event.listen(engine, "before_cursor_execute", reject_query)
    try:
        error = client.refresh(refresh) if operation == "refresh" else client.logout(access=access)
        assert_error(error, 500, "internal_error")
        for secret in [PASSWORD, KEY, refresh, access, "test-only-password"]:
            assert secret not in error.text
            assert secret not in caplog.text
        assert "set-cookie" not in error.headers
        assert "Unhandled API exception type=RuntimeError" in caplog.text
    finally:
        event.remove(engine, "before_cursor_execute", reject_query)
    # The successful response carries only the contractual access field and cookie.
    assert refresh not in response.text
    assert set(response.json()) == {"access_token", "token_type", "expires_in"}


def test_openapi_auth_contract_uses_shared_errors_and_cookie():
    from app.main import app

    schema = app.openapi()
    assert "/api/v1/users/me" not in schema["paths"]
    for path in ["login", "refresh", "logout"]:
        operation = schema["paths"][COOKIE_PATH + "/" + path]["post"]
        for status in ["401", "403", "422", "500"]:
            assert operation["responses"][status]["content"]["application/json"]["schema"] == {
                "$ref": "#/components/schemas/ApiError"
            }
        assert any(
            param["in"] == "header" and param["name"] == "origin"
            for param in operation["parameters"]
        )
        if path != "login":
            assert "requestBody" not in operation
            assert any(
                param["in"] == "cookie" and param["name"] == COOKIE_NAME
                for param in operation["parameters"]
            )
    assert "429" in schema["paths"][COOKIE_PATH + "/login"]["post"]["responses"]
    logout_operation = schema["paths"][COOKIE_PATH + "/logout"]["post"]
    assert logout_operation["security"] == [{"HTTPBearer": []}, {}]
    assert logout_operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/LogoutResponse"
    }
    assert schema["components"]["schemas"]["LogoutResponse"]["required"] == ["session_revoked"]


def test_rate_limit_counts_invalid_bodies_and_skips_disallowed_origins(auth, monkeypatch):
    client, _engine, _ids, logins, _students = auth
    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter())
    for _ in range(5):
        assert_error(
            client.login(json={}, origin="https://evil.example"), 403, "origin_not_allowed"
        )
    for _ in range(5):
        assert_error(client.login(json={}), 422, "validation_error")
    assert_error(client.login(json={"login": logins[0], "password": PASSWORD}), 429, "rate_limited")


def test_invalid_logins_do_not_wait_for_existing_user_row_lock(auth):
    client, engine, ids, logins, _students = auth
    with Session(engine) as blocker:
        blocker.scalar(select(User).where(User.id == ids[0]).with_for_update())
        blocker_pid = blocker.connection().connection.driver_connection.info.backend_pid
        with ThreadPoolExecutor(max_workers=2) as pool:
            try:
                existing = pool.submit(
                    client.login,
                    json={"login": logins[0], "password": "incorrect-fictional-password"},
                )
                absent = pool.submit(
                    client.login,
                    json={
                        "login": "absent-" + uuid4().hex,
                        "password": "incorrect-fictional-password",
                    },
                )
                # Both HTTP requests must finish while the external lock is still held.
                existing_response, absent_response = existing.result(5), absent.result(5)
                assert_error(existing_response, 401, "invalid_credentials")
                assert existing_response.json() == absent_response.json()
                assert absent_response.status_code == 401
                assert (
                    blocker.connection().connection.driver_connection.info.backend_pid
                    == blocker_pid
                )
            finally:
                blocker.rollback()
    with Session(engine) as db:
        assert not db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))


def test_concurrent_invalid_logins_do_not_lock_user_during_argon2id(auth, monkeypatch):
    from threading import Barrier

    from app.auth import service

    client, engine, ids, logins, _students = auth
    verifying = Barrier(3)
    release_verification = Event()
    pids = set()
    original = service.verify_password

    def observe_verification(password_hash, password):
        verifying.wait(timeout=5)
        assert release_verification.wait(10)
        return original(password_hash, password)  # Real Argon2id, not a stub.

    def observe_query(connection, _cursor, statement, _parameters, _context, _many):
        if "FROM users" in statement and "FOR UPDATE" not in statement:
            pids.add(connection.connection.driver_connection.info.backend_pid)

    monkeypatch.setattr(service, "verify_password", observe_verification)
    event.listen(engine, "before_cursor_execute", observe_query)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(client.login, json={"login": logins[0], "password": "wrong"})
                for _ in range(2)
            ]
            try:
                verifying.wait(timeout=5)
                assert len(pids) == 2
                with Session(engine) as probe:
                    probe_pid = probe.connection().connection.driver_connection.info.backend_pid
                    assert probe_pid not in pids
                    # A third real transaction can acquire the user lock without waiting.
                    probe.scalar(select(User).where(User.id == ids[0]).with_for_update(nowait=True))
                    release_verification.set()
                    for future in futures:
                        assert_error(future.result(5), 401, "invalid_credentials")
                    probe.rollback()
            finally:
                release_verification.set()
    finally:
        event.remove(engine, "before_cursor_execute", observe_query)


@pytest.mark.parametrize("mutation", ["deactivate", "change_password"])
def test_login_rechecks_user_after_waiting_for_concurrent_update(auth, mutation):
    import time

    client, engine, ids, logins, _students = auth
    waiting = Event()
    login_pids = []
    replacement_hash = PASSWORD_HASHER.hash("new-fictional-password")

    def observe_lock(connection, _cursor, statement, _parameters, _context, _many):
        if "FROM users" in statement and "FOR UPDATE" in statement:
            login_pids.append(connection.connection.driver_connection.info.backend_pid)
            waiting.set()

    with Session(engine) as updater:
        user = updater.scalar(select(User).where(User.id == ids[0]).with_for_update())
        updater_pid = updater.connection().connection.driver_connection.info.backend_pid
        if mutation == "deactivate":
            user.is_active = False
        else:
            user.password_hash = replacement_hash
        updater.flush()  # Uncommitted: the login snapshot must still see the old version.
        event.listen(engine, "before_cursor_execute", observe_lock)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(client.login, json={"login": logins[0], "password": PASSWORD})
                try:
                    assert waiting.wait(5)
                    assert login_pids[0] != updater_pid
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        with engine.connect() as monitor:
                            blockers = monitor.scalar(
                                text("SELECT pg_blocking_pids(:pid)"), {"pid": login_pids[0]}
                            )
                        if updater_pid in blockers:
                            break
                        time.sleep(0.01)
                    else:
                        pytest.fail("valid login must wait for the concurrent user update")
                    assert not future.done()
                    updater.commit()
                    assert_error(future.result(5), 401, "invalid_credentials")
                finally:
                    updater.rollback()
        finally:
            event.remove(engine, "before_cursor_execute", observe_lock)
    with Session(engine) as db:
        assert not db.scalar(select(AuthSession).where(AuthSession.user_id == ids[0]))
        assert not db.scalar(
            select(RefreshToken).join(AuthSession).where(AuthSession.user_id == ids[0])
        )


@pytest.mark.parametrize("cookie", [None, "unknown-refresh-cookie", "x" * 513])
def test_logout_falls_back_to_access_and_revokes_session_when_cookie_cannot_identify_it(
    auth, cookie
):
    client, engine, _ids, _logins, _students = auth
    _response, refresh, access = login(auth)
    response = client.logout(cookie, access=access)
    assert_logout(response, True)
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert_error(client.request("GET", "/api/v1/test/user", access=access), 401, "session_invalid")
    with Session(engine) as db:
        row = db.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(refresh))
        )
        session = db.get(AuthSession, row.session_id)
        revoked_at = session.revoked_at
        assert revoked_at and session.revocation_reason == "logout"
        assert all(
            token.revoked_at
            for token in db.scalars(
                select(RefreshToken).where(RefreshToken.session_id == session.id)
            )
        )
    assert_logout(client.logout(access=access), True)
    with Session(engine) as db:
        assert db.get(AuthSession, session.id).revoked_at == revoked_at


@pytest.mark.parametrize("cookie_state", ["current", "used", "revoked"])
def test_logout_cookie_takes_priority_over_an_independent_access_session(auth, cookie_state):
    client = auth[0]
    _response, cookie, access_a = login(auth)
    _response, _cookie_b, access_b = login(auth, 1)
    if cookie_state == "used":
        assert client.refresh(cookie).status_code == 200
    if cookie_state == "revoked":
        assert_logout(client.logout(cookie), True)
    assert_logout(client.logout(cookie, access=access_b), True)
    assert_error(
        client.request("GET", "/api/v1/test/user", access=access_a), 401, "session_invalid"
    )
    assert client.request("GET", "/api/v1/test/user", access=access_b).status_code == 200


@pytest.mark.parametrize(
    "mutation",
    [
        "expired",
        "signature",
        "algorithm",
        "missing_claim",
        "issuer",
        "audience",
        "type",
        "owner",
        "missing_session",
        "malformed",
        "scheme",
    ],
)
def test_logout_ignores_unusable_bearer_and_does_not_revoke_an_unrelated_session(auth, mutation):
    client = auth[0]
    _response, _cookie, access = login(auth)
    payload = jwt.decode(access, KEY, algorithms=["HS256"], audience="uni-space-api")
    key, algorithm = KEY, "HS256"
    if mutation == "expired":
        payload.update(exp=payload["iat"] - 1, iat=payload["iat"] - 10)
    elif mutation == "signature":
        key += "-incorrect"
    elif mutation == "algorithm":
        algorithm = "HS512"
    elif mutation == "missing_claim":
        del payload["sid"]
    elif mutation == "issuer":
        payload["iss"] = "different-issuer"
    elif mutation == "audience":
        payload["aud"] = "different-audience"
    elif mutation == "type":
        payload["token_type"] = "refresh"
    elif mutation == "owner":
        payload["sub"] = str(auth[2][1])
    elif mutation == "missing_session":
        payload["sid"] = "9223372036854775807"
    bad_access = jwt.encode(payload, key, algorithm=algorithm)
    if mutation == "malformed":
        bad_access = "fictional-invalid-token"
    response = (
        client.logout(headers={"Authorization": "Basic " + bad_access})
        if mutation == "scheme"
        else client.logout(access=bad_access)
    )
    assert_logout(response, False)
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert client.request("GET", "/api/v1/test/user", access=access).status_code == 200


def test_bearer_fallback_preserves_origin_and_body_protection(auth):
    client = auth[0]
    _response, _cookie, access = login(auth)
    assert_error(client.logout(access=access, origin=None), 403, "origin_not_allowed")
    assert_error(client.logout(access=access, content=b"{}"), 422, "validation_error")
    assert_error(client.logout(access=access, content=b"x" * 16385), 413, "request_too_large")
    assert client.request("GET", "/api/v1/test/user", access=access).status_code == 200


def test_notifications_are_private_and_use_stable_keyset_pagination(auth):
    client, engine, user_ids, _logins, _student_ids = auth
    _first_login, _cookie, first_access = login(auth, 0)
    _second_login, _cookie, second_access = login(auth, 1)
    created_at = datetime(2026, 1, 1, tzinfo=UTC)
    with Session(engine) as db, db.begin():
        rows = [
            Notification(
                user_id=user_ids[0],
                type="fixture_type",
                title=f"Student one {index}",
                body="<script>alert('text')</script>\nПример",
                created_at=created_at,
            )
            for index in range(3)
        ]
        rows.append(
            Notification(
                user_id=user_ids[1],
                type="unknown_future_type",
                title="Student two only",
                body="Личное сообщение",
                created_at=created_at,
            )
        )
        db.add_all(rows)
        db.flush()
        expected_ids = [
            str(row.id) for row in sorted(rows[:3], key=lambda item: item.id, reverse=True)
        ]

    assert_error(client.request("GET", "/api/v1/notifications"), 401, "invalid_access")
    first = client.request(
        "GET",
        "/api/v1/notifications?limit=2",
        access=first_access,
    )
    assert first.status_code == 200, first.text
    assert [item["id"] for item in first.json()["items"]] == expected_ids[:2]
    assert first.json()["next_cursor"]
    assert first.json()["items"][0]["body"].startswith("<script>")
    for parameter in ("user_id=" + str(user_ids[1]), "student_id=999", "arbitrary=value"):
        assert_error(
            client.request("GET", f"/api/v1/notifications?{parameter}", access=first_access),
            422,
            "validation_error",
        )

    with Session(engine) as db, db.begin():
        db.add(
            Notification(
                user_id=user_ids[0],
                type="new",
                title="Arrived later",
                body="Новая запись",
                created_at=datetime(2027, 1, 1, tzinfo=UTC),
            )
        )
    second = client.request(
        "GET",
        "/api/v1/notifications?limit=2&cursor=" + first.json()["next_cursor"],
        access=first_access,
    )
    assert second.status_code == 200, second.text
    assert [item["id"] for item in second.json()["items"]] == expected_ids[2:]
    assert second.json()["next_cursor"] is None

    private = client.request("GET", "/api/v1/notifications?limit=100", access=second_access)
    assert [item["title"] for item in private.json()["items"]] == ["Student two only"]
    with Session(engine) as db, db.begin():
        db.execute(update(User).where(User.id == user_ids[0]).values(role="teacher"))
    assert_error(
        client.request("GET", "/api/v1/notifications", access=first_access), 403, "forbidden"
    )
    with Session(engine) as db, db.begin():
        db.execute(update(User).where(User.id == user_ids[0]).values(role="student"))
    assert_error(
        client.request("GET", "/api/v1/notifications?limit=0", access=first_access),
        422,
        "validation_error",
    )
    assert_error(
        client.request("GET", "/api/v1/notifications?limit=1.0", access=first_access),
        422,
        "validation_error",
    )
    assert_error(
        client.request("GET", "/api/v1/notifications?cursor=bad", access=first_access),
        422,
        "validation_error",
    )
