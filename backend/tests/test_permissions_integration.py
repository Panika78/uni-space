from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import delete, text
from sqlalchemy.exc import IntegrityError
from test_auth_integration import AuthClient
from test_auth_integration import auth as auth_fixture

from app.auth.security import create_access_token
from app.core.config import get_settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import (
    Application,
    AuthSession,
    OrgUnit,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Teacher,
    User,
)
from app.permissions import (
    ACADEMIC_PERMISSIONS,
    PermissionCode,
    get_authorization_context,
    require_application_review,
    require_permission,
    require_staff_permission,
    router,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def auth(postgresql_engine, monkeypatch):
    yield from auth_fixture.__wrapped__(postgresql_engine, monkeypatch)


@pytest.fixture
def rbac(db_session):
    db = db_session
    dean = OrgUnit(name="Fictional Dean", type="dean_office")
    accounting = OrgUnit(name="Fictional Accounting", type="accounting")
    db.add_all([dean, accounting])
    db.flush()

    def create_user(role="staff", unit=None):
        user = User(
            login=uuid4().hex,
            password_hash="unused",
            full_name="Fictional User",
            role=role,
            is_active=True,
        )
        db.add(user)
        db.flush()
        profile = None
        if role == "staff":
            profile = StaffProfile(user_id=user.id, org_unit_id=(unit or dean).id)
            db.add(profile)
            db.flush()
        now = datetime.now(UTC)
        session = AuthSession(user_id=user.id, created_at=now, expires_at=now + timedelta(hours=1))
        db.add(session)
        db.flush()
        token = create_access_token(session, get_settings())["access_token"]
        return user, profile, token

    def grant(profile, code, scope=None):
        permission = StaffPermission(
            staff_profile_id=profile.id, permission_code=code, scope_org_unit_id=scope
        )
        db.add(permission)
        db.flush()
        return permission

    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[get_db_session] = lambda: db
    for code in ACADEMIC_PERMISSIONS:

        def operation(user: Annotated[User, Depends(require_permission(code))]):
            return {"allowed": True}

        app.add_api_route("/test/" + code, operation)

    @app.get("/test/applications/{application_id}")
    def get_application(application_id: int, user: Annotated[User, Depends(get_current_user)]):
        application = require_application_review(db, user, application_id)
        return {"id": application.id}

    return db, dean, accounting, create_user, grant, AuthClient(app)


@pytest.mark.parametrize("code", sorted(ACADEMIC_PERMISSIONS))
def test_academic_permissions_are_independent_and_explicit(rbac, code):
    db, dean, accounting, create, grant, client = rbac
    user, profile, token = create()
    assert client.request("GET", "/test/" + code, access=token).status_code == 403
    grant(profile, code)
    for action in ACADEMIC_PERMISSIONS:
        response = client.request("GET", "/test/" + action, access=token)
        assert response.status_code == (200 if action == code else 403)
    for other in (PermissionCode.APPLICATIONS_REVIEW, PermissionCode.NEWS_PUBLISH):
        with pytest.raises(HTTPException) as exc:
            require_staff_permission(db, user, other, org_unit_id=dean.id)
        assert exc.value.status_code == 403
    assert (
        len(client.request("GET", "/api/v1/auth/context", access=token).json()["permissions"]) == 1
    )


@pytest.mark.parametrize("role", ["student", "teacher", "admin"])
def test_other_roles_do_not_inherit_staff_actions(rbac, role):
    db, dean, accounting, create, grant, client = rbac
    user, _, token = create(role)
    context = client.request("GET", "/api/v1/auth/context", access=token)
    assert context.status_code == 200
    assert context.json() == dict(user_id=str(user.id), role=role, org_unit_id=None, permissions=[])
    for code in ACADEMIC_PERMISSIONS:
        assert client.request("GET", "/test/" + code, access=token).status_code == 403
    assert client.request("GET", "/test/applications/123", access=token).status_code == 403


def test_permissions_and_context_refresh_with_old_jwt(rbac):
    db, dean, accounting, create, grant, client = rbac
    user, profile, token = create()
    permission = grant(profile, PermissionCode.GRADES_EDIT)
    path = "/test/grades.edit"
    assert client.request("GET", path, access=token).status_code == 200
    db.delete(permission)
    db.flush()
    assert client.request("GET", path, access=token).status_code == 403
    assert client.request("GET", "/api/v1/auth/context", access=token).json()["permissions"] == []
    grant(profile, PermissionCode.GRADES_EDIT)
    profile.org_unit_id = accounting.id
    db.flush()
    assert client.request("GET", path, access=token).status_code == 403
    assert client.request("GET", "/api/v1/auth/context", access=token).json()["org_unit_id"] == str(
        accounting.id
    )
    profile.org_unit_id = dean.id
    db.flush()
    assert client.request("GET", path, access=token).status_code == 200
    db.execute(delete(StaffPermission).where(StaffPermission.staff_profile_id == profile.id))
    db.delete(profile)
    user.role = "admin"
    db.flush()
    assert client.request("GET", path, access=token).status_code == 403
    assert client.request("GET", "/api/v1/auth/context", access=token).json()["role"] == "admin"
    user.is_active = False
    db.flush()
    assert client.request("GET", "/api/v1/auth/context", access=token).status_code == 401


def test_application_scope_isolated_and_assignment_takes_priority(rbac):
    db, dean, accounting, create, grant, client = rbac
    # Reuse the project fixture builder for a valid student and group.
    from app.models import Program, Student, StudyGroup

    faculty = OrgUnit(name="Fictional Faculty", type="faculty")
    db.add(faculty)
    db.flush()
    program = Program(
        code="fictional",
        name="Fictional",
        direction_code="00",
        direction_name="Fictional",
        faculty_id=faculty.id,
    )
    db.add(program)
    db.flush()
    group = StudyGroup(name="Fictional", program_id=program.id, course_number=1)
    db.add(group)
    db.flush()
    student_user, _, _ = create("student")
    student = Student(user_id=student_user.id, group_id=group.id, academic_status="enrolled")
    db.add(student)
    db.flush()
    service = ServiceType(
        code=uuid4().hex,
        title="Fictional",
        processing_mode="review",
        responsible_org_unit_id=accounting.id,
        produces_document=False,
    )
    db.add(service)
    db.flush()
    application = Application(
        student_id=student.id,
        service_type_id=service.id,
        review_status="submitted",
        document_status="not_required",
        form_data={},
    )
    db.add(application)
    db.flush()
    a, pa, ta = create(unit=accounting)
    b, pb, tb = create()
    c, pc, tc = create(unit=accounting)
    grant(pa, PermissionCode.APPLICATIONS_REVIEW, accounting.id)
    grant(pb, PermissionCode.APPLICATIONS_REVIEW, dean.id)
    grant(pc, PermissionCode.APPLICATIONS_REVIEW)  # NULL never means global.
    path = f"/test/applications/{application.id}"
    assert client.request("GET", path, access=ta).status_code == 200
    assert client.request("GET", path, access=tb).status_code == 404
    assert client.request("GET", path, access=tc).status_code == 403
    assert (
        client.request("GET", "/test/applications/9223372036854775807", access=tb).status_code
        == 404
    )
    application.assigned_org_unit_id = dean.id
    db.flush()
    assert client.request("GET", path, access=ta).status_code == 404
    assert client.request("GET", path, access=tb).status_code == 200
    application.assigned_org_unit_id = None
    service.responsible_org_unit_id = None
    db.flush()
    assert client.request("GET", path, access=ta).status_code == 404
    assert client.request("GET", path, access=tb).status_code == 404
    pa.org_unit_id = dean.id
    db.flush()
    assert client.request("GET", path, access=ta).status_code == 403


def test_invalid_scope_and_non_dean_grants_fail_closed(rbac):
    db, dean, accounting, create, grant, client = rbac
    user, profile, token = create(unit=accounting)
    for code in ACADEMIC_PERMISSIONS:
        grant(profile, code)
    grant(profile, PermissionCode.NEWS_PUBLISH)
    grant(profile, PermissionCode.APPLICATIONS_REVIEW, dean.id)
    assert get_authorization_context(db, user).permissions == []
    profile.org_unit_id = dean.id
    db.flush()
    grant(profile, PermissionCode.NEWS_PUBLISH, dean.id)
    require_staff_permission(db, user, PermissionCode.NEWS_PUBLISH, org_unit_id=dean.id)
    assert (
        client.request("GET", "/api/v1/auth/context?user_id=123", access=token).status_code == 422
    )
    assert client.request("GET", "/api/v1/auth/context").status_code == 401
    assert (
        client.request("GET", "/api/v1/auth/context", access=token).headers["cache-control"]
        == "no-store"
    )
    assert (
        client.request(
            "POST", "/api/v1/auth/context", access=token, json={"role": "admin"}
        ).status_code
        == 405
    )


def test_database_rejects_profile_role_mismatch_and_duplicate_permissions(rbac):
    db, dean, accounting, create, grant, client = rbac
    user, profile, token = create()
    grant(profile, PermissionCode.GRADES_EDIT)
    with pytest.raises(IntegrityError), db.begin_nested():
        grant(profile, PermissionCode.GRADES_EDIT)
    with pytest.raises(IntegrityError), db.begin_nested():
        grant(profile, "invented.permission")
    with pytest.raises(IntegrityError), db.begin_nested():
        db.add(Teacher(full_name="Fictional", user_id=user.id))
        db.flush()
        db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    with pytest.raises(IntegrityError), db.begin_nested():
        user.role = "admin"
        db.flush()
        db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    grant(profile, PermissionCode.NEWS_PUBLISH, dean.id)
    with pytest.raises(IntegrityError), db.begin_nested():
        grant(profile, PermissionCode.NEWS_PUBLISH, dean.id)


def test_application_permission_revocation_and_scope_change_with_old_jwt(rbac):
    db, dean, accounting, create, grant, client = rbac
    user, profile, token = create()
    permission = grant(profile, PermissionCode.APPLICATIONS_REVIEW, dean.id)
    path = "/api/v1/auth/context"
    assert client.request("GET", path, access=token).json()["permissions"]
    permission.scope_org_unit_id = accounting.id
    db.flush()
    assert client.request("GET", path, access=token).json()["permissions"] == []
    assert client.request("GET", "/test/applications/1", access=token).status_code == 403
    permission.scope_org_unit_id = dean.id
    db.flush()
    assert client.request("GET", path, access=token).json()["permissions"]
    db.delete(permission)
    db.flush()
    assert client.request("GET", path, access=token).json()["permissions"] == []
    assert client.request("GET", "/test/applications/1", access=token).status_code == 403


def test_dean_academic_scope_must_be_explicitly_university_wide(rbac):
    db, dean, accounting, create, grant, client = rbac
    user, profile, token = create()
    for code in ACADEMIC_PERMISSIONS:
        grant(profile, code, dean.id)
        assert client.request("GET", "/test/" + code, access=token).status_code == 403
    assert client.request("GET", "/api/v1/auth/context", access=token).json()["permissions"] == []


def test_grants_committed_in_another_session_apply_to_old_jwt(auth):
    # The regular auth fixture creates a fresh DB session for every actual request.
    from sqlalchemy.orm import Session

    from app.models import Student
    from app.permissions import router as context_router

    client, engine, user_ids, logins, _ = auth
    client.app.include_router(context_router)
    access = client.login(json={"login": logins[0], "password": "fictional-auth-password"}).json()[
        "access_token"
    ]
    with Session(engine) as db, db.begin():
        db.execute(delete(Student).where(Student.user_id == user_ids[0]))
        db.get(User, user_ids[0]).role = "staff"
        unit = OrgUnit(name="Fictional RBAC Dean", type="dean_office")
        db.add(unit)
        db.flush()
        profile = StaffProfile(user_id=user_ids[0], org_unit_id=unit.id)
        db.add(profile)
        db.flush()
        grant = StaffPermission(staff_profile_id=profile.id, permission_code="grades.edit")
        db.add(grant)
        db.flush()
        profile_id, unit_id, grant_id = profile.id, unit.id, grant.id
    try:
        path = "/api/v1/auth/context"
        assert client.request("GET", path, access=access).json()["permissions"] == [
            {"permission_code": "grades.edit", "scope_org_unit_id": None}
        ]
        with Session(engine) as db, db.begin():
            db.execute(delete(StaffPermission).where(StaffPermission.id == grant_id))
        assert client.request("GET", path, access=access).json()["permissions"] == []
    finally:
        with Session(engine) as db, db.begin():
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id == profile_id)
            )
            db.execute(delete(StaffProfile).where(StaffProfile.id == profile_id))
            db.execute(delete(OrgUnit).where(OrgUnit.id == unit_id))
