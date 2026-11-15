"""Real PostgreSQL transactions, HTTP auth, races, audit and production runtime ACL."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_auth_integration import KEY, ORIGIN, AuthClient

from app.admin import service
from app.admin.bootstrap import bootstrap_admin
from app.admin.router import router
from app.auth.router import COOKIE_NAME
from app.auth.router import router as auth_router
from app.auth.security import verify_password
from app.auth.service import create_login_session
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.dependencies.database import get_db_session
from app.models import (
    AuditEvent,
    AuthSession,
    OrgUnit,
    Program,
    RefreshToken,
    StaffProfile,
    Student,
    StudyGroup,
    Teacher,
    User,
)
from app.permissions import router as context_router

pytestmark = pytest.mark.integration


@pytest.fixture
def engine(migration_database):  # noqa: F811
    run_migration(migration_database, "upgrade", "head")
    return migration_database


def bootstrap(engine, login="operator"):
    with Session(engine) as db, db.begin():
        return bootstrap_admin(db, login=login, full_name="Fictional Administrator")


@pytest.fixture
def admin(engine, monkeypatch):
    from app.auth import router as auth_routes
    from app.auth.rate_limit import LoginRateLimiter

    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter(limit=1000))
    uid, password = bootstrap(engine)
    settings = Settings(
        _env_file=None,
        app_env="test",
        cookie_secure=True,
        jwt_signing_key=KEY,
        database_url=engine.url.render_as_string(hide_password=False),
        allowed_origins=[ORIGIN],
    )
    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)
    app.include_router(auth_router)
    app.include_router(context_router)

    def get_db():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db_session] = get_db
    app.dependency_overrides[get_settings] = lambda: settings
    client = AuthClient(app)
    result = client.login(json={"login": "operator", "password": password})
    assert result.status_code == 200, result.text
    access = result.json()["access_token"]
    with Session(engine) as db, db.begin():
        units = [
            OrgUnit(name="Fictional Dean", type="dean_office"),
            OrgUnit(name="Fictional Accounting", type="accounting"),
        ]
        db.add_all(units)
        db.flush()
        program = Program(
            code="00",
            name="Fictional",
            direction_code="00",
            direction_name="Fictional",
            faculty_id=units[0].id,
        )
        db.add(program)
        db.flush()
        group = StudyGroup(name="Fictional Group", program_id=program.id, course_number=1)
        teacher = Teacher(full_name="Fictional Teacher")
        db.add_all([group, teacher])
        db.flush()
        options = {
            "group_id": str(group.id),
            "teacher_id": str(teacher.id),
            "org_unit_id": str(units[0].id),
            "other_unit": str(units[1].id),
        }
    return client, access, uid, options, settings


def request(admin, method, path="", **kwargs):
    client, token, *_ = admin
    return client.request(method, "/api/v1/admin/users" + path, access=token, **kwargs)


def create(admin, role="admin", login=None):
    profile = {"student": "group_id", "teacher": "teacher_id", "staff": "org_unit_id"}.get(role)
    body = {"login": login or role, "full_name": "Fictional User", "role": role}
    if profile:
        body[profile] = admin[3][profile]
    response = request(admin, "POST", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_create_roles_profiles_secret_duplicates_and_lost_response(admin, engine):
    for role in ("student", "teacher", "staff", "admin"):
        result = create(admin, role)
        user = result["user"]
        password = result["initial_password"]
        assert len(password) >= 32
        detail = request(admin, "GET", "/" + user["id"])
        assert detail.status_code == 200
        assert "initial_password" not in detail.text and password not in detail.text
        assert request(admin, "GET").headers["cache-control"] == "no-store"
        with Session(engine) as db:
            account = db.get(User, int(user["id"]))
            assert verify_password(account.password_hash, password)
            assert account.password_hash != password
            counts = [
                db.scalar(select(func.count()).select_from(m).where(m.user_id == account.id))
                for m in (Student, Teacher, StaffProfile)
            ]
            assert sum(counts) == (0 if role == "admin" else 1)
            assert user["permissions"] == []
            if role == "student":
                assert db.get(Student, int(user["student_id"])).academic_status == "enrolled"
        # Treat successful response as lost: only search can recover the account.
        found = request(admin, "GET", "?q=" + role).json()["items"]
        assert any(u["id"] == user["id"] for u in found)
        duplicate = request(
            admin, "POST", json={"login": role, "full_name": "Fictional", "role": "admin"}
        )
        assert duplicate.status_code == 409
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Teacher)) == 1
        events = db.scalars(select(AuditEvent))
        for item in events:
            snapshot = str(item.after_data) + str(item.before_data)
            assert all(
                secret not in snapshot
                for secret in ("password", "hash", "login", "full_name", "token")
            )
    bad = request(
        admin,
        "POST",
        json={"login": "bad", "full_name": "Fictional", "role": "student", "group_id": "9999999"},
    )
    assert bad.status_code == 422
    assert not request(admin, "GET", "?q=bad").json()["items"]
    teacher = request(
        admin,
        "POST",
        json={
            "login": "teacher2",
            "full_name": "Fictional",
            "role": "teacher",
            "teacher_id": admin[3]["teacher_id"],
        },
    )
    assert teacher.status_code == 409


def test_permission_scope_noops_transfer_back_and_current_jwt(admin, engine):
    created = create(admin, "staff")
    uid = created["user"]["id"]
    client = admin[0]
    login = client.login(json={"login": "staff", "password": created["initial_password"]})
    token = login.json()["access_token"]

    def grant(code, scope, method="PUT"):
        return request(
            admin,
            method,
            f"/{uid}/permissions",
            json={"permission_code": code, "scope_org_unit_id": scope},
        )

    for code in service.ACADEMIC_PERMISSIONS:
        assert grant(code, None).status_code == 200
        assert grant(code, admin[3]["org_unit_id"]).status_code == 422
    assert grant("applications.review", admin[3]["other_unit"]).status_code == 422
    assert grant("invented", None).status_code == 422
    assert grant("news.publish", admin[3]["org_unit_id"]).status_code == 200
    with Session(engine) as db:
        before = db.scalar(select(func.count()).select_from(AuditEvent))
    assert grant("news.publish", admin[3]["org_unit_id"]).status_code == 200
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == before
    assert client.request("GET", "/api/v1/auth/context", access=token).json()["permissions"]
    assert grant("grades.edit", None, "DELETE").status_code == 200
    for target in (admin[3]["other_unit"], admin[3]["org_unit_id"]):
        response = request(admin, "PUT", f"/{uid}/department", json={"org_unit_id": target})
        assert response.status_code == 200, response.text
        assert response.json()["permissions"] == []
        assert (
            client.request("GET", "/api/v1/auth/context", access=token).json()["permissions"] == []
        )
    assert (
        request(
            admin,
            "PUT",
            f"/{admin[2]}/permissions",
            json={"permission_code": "grades.edit", "scope_org_unit_id": None},
        ).status_code
        == 404
    )


def test_block_revokes_all_sessions_and_unblock_never_restores(admin, engine):
    created = create(admin, "staff")
    uid = created["user"]["id"]
    client = admin[0]
    logins = [
        client.login(json={"login": "staff", "password": created["initial_password"]})
        for _ in range(2)
    ]
    assert request(admin, "PUT", f"/{uid}/active", json={"is_active": False}).status_code == 200
    for login in logins:
        assert (
            client.request(
                "GET", "/api/v1/auth/context", access=login.json()["access_token"]
            ).status_code
            == 401
        )
        assert client.refresh(login.cookies[COOKIE_NAME]).status_code == 401
    with Session(engine) as db:
        sessions = list(db.scalars(select(AuthSession).where(AuthSession.user_id == int(uid))))
        assert len(sessions) == 2 and all(
            s.revoked_at and s.revocation_reason == "user_blocked" for s in sessions
        )
        assert all(
            t.revoked_at
            for t in db.scalars(
                select(RefreshToken).where(RefreshToken.session_id.in_([s.id for s in sessions]))
            )
        )
        count = db.scalar(select(func.count()).select_from(AuditEvent))
    assert request(admin, "PUT", f"/{uid}/active", json={"is_active": False}).status_code == 200
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == count
    assert (
        client.login(json={"login": "staff", "password": created["initial_password"]}).status_code
        == 401
    )
    assert request(admin, "PUT", f"/{uid}/active", json={"is_active": True}).status_code == 200
    for login in logins:
        assert client.refresh(login.cookies[COOKIE_NAME]).status_code == 401
    assert (
        client.login(json={"login": "staff", "password": created["initial_password"]}).status_code
        == 200
    )
    assert (
        request(admin, "PUT", f"/{admin[2]}/active", json={"is_active": False}).status_code == 409
    )


def test_audit_failure_rolls_back_creation_activity_permissions_and_transfer(
    admin, engine, monkeypatch
):
    created = create(admin, "staff")
    uid = created["user"]["id"]
    grant = {"permission_code": "grades.edit", "scope_org_unit_id": None}
    assert request(admin, "PUT", f"/{uid}/permissions", json=grant).status_code == 200

    def fail(*args, **kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(service, "write_audit_event", fail)
    attempts = [
        ("POST", "", {"login": "rollback", "full_name": "Fictional", "role": "admin"}),
        ("PUT", f"/{uid}/active", {"is_active": False}),
        ("DELETE", f"/{uid}/permissions", grant),
        ("PUT", f"/{uid}/department", {"org_unit_id": admin[3]["other_unit"]}),
    ]
    for method, path, body in attempts:
        assert request(admin, method, path, json=body).status_code == 500
    detail = request(admin, "GET", "/" + uid).json()
    assert detail["is_active"] and len(detail["permissions"]) == 1
    assert detail["org_unit_id"] == admin[3]["org_unit_id"]
    assert not request(admin, "GET", "?q=rollback").json()["items"]


def test_non_admin_and_missing_credentials_cannot_access_admin(admin):
    for role in ("student", "teacher", "staff"):
        created = create(admin, role)
        token = (
            admin[0]
            .login(json={"login": role, "password": created["initial_password"]})
            .json()["access_token"]
        )
        for method, path, body in [
            ("GET", "", None),
            ("GET", "/999999", None),
            ("POST", "", {"login": "escalate", "full_name": "Fictional", "role": "admin"}),
            ("PUT", "/999999/active", {"is_active": False}),
        ]:
            response = admin[0].request(
                method,
                "/api/v1/admin/users" + path,
                access=token,
                **({"json": body} if body else {}),
            )
            assert response.status_code == 403
    assert admin[0].request("GET", "/api/v1/admin/users").status_code == 401
    assert request(admin, "GET", "/999999").status_code == 404
    assert request(admin, "GET", "/9999999999999999999").status_code == 422


def test_bootstrap_empty_repeat_inactive_and_concurrent(engine):
    def run(login):
        try:
            with Session(engine) as db, db.begin():
                return bootstrap_admin(db, login=login, full_name="Fictional")
        except ValueError:
            return None

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, ["first", "second"]))
    assert sum(r is not None for r in results) == 1
    with Session(engine) as db, db.begin():
        user = db.scalar(select(User))
        event_row = db.scalar(select(AuditEvent))
        assert user.role == "admin" and user.is_active
        assert event_row.actor_user_id is None and event_row.entity_id == user.id
        assert event_row.before_data is None and event_row.after_data == {
            "role": "admin",
            "is_active": True,
        }
        assert verify_password(user.password_hash, next(r[1] for r in results if r))
        user.is_active = False
    assert run("third") is None
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1


def test_bootstrap_audit_failure_rolls_back(engine):
    def fail(_mapper, _connection, _target):
        raise RuntimeError("audit refused")

    event.listen(AuditEvent, "before_insert", fail)
    try:
        with pytest.raises(RuntimeError), Session(engine) as db, db.begin():
            bootstrap_admin(db, login="bootstrap", full_name="Fictional")
    finally:
        event.remove(AuditEvent, "before_insert", fail)
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == 0


def test_two_admins_cannot_concurrently_block_each_other(admin, engine):
    other = int(create(admin)["user"]["id"])
    first = admin[2]

    def block(pair):
        actor_id, target_id = pair
        try:
            with Session(engine) as db, db.begin():
                service.set_user_active(db, db.get(User, actor_id), target_id, False)
            return 200
        except HTTPException as error:
            return error.status_code

    with ThreadPoolExecutor(2) as pool:
        statuses = list(pool.map(block, [(first, other), (other, first)]))
    assert sorted(statuses) == [200, 403]
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(User).where(User.role == "admin", User.is_active)
            )
            == 1
        )


def test_login_waiting_for_block_cannot_create_session(admin, engine, monkeypatch):
    created = create(admin, "staff")
    uid = int(created["user"]["id"])
    entered = Event()
    from app.auth import service as auth_service

    original = auth_service.verify_password

    def verify(*args):
        valid = original(*args)
        entered.set()
        return valid

    monkeypatch.setattr(auth_service, "verify_password", verify)

    def login():
        with Session(engine) as db:
            try:
                create_login_session(db, "staff", created["initial_password"], admin[4])
                return 200
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(1) as pool:
        with Session(engine) as db, db.begin():
            db.execute(select(User).where(User.id == uid).with_for_update())
            future = pool.submit(login)
            assert entered.wait(5)
            service.set_user_active(db, db.get(User, admin[2]), uid, False)
        assert future.result(10) == 401
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(AuthSession).where(AuthSession.user_id == uid)
            )
            == 0
        )
