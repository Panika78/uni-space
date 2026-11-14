"""Real request sessions observing RBAC changes committed in independent transactions."""

from types import SimpleNamespace
from typing import Annotated

import pytest
from fastapi import Depends
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from test_auth_integration import PASSWORD
from test_auth_integration import auth as auth_fixture

from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db_session
from app.models import (
    Application,
    OrgUnit,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    User,
)
from app.permissions import get_application_scope, require_application_review, router

pytestmark = pytest.mark.integration


@pytest.fixture
def auth(postgresql_engine, monkeypatch):
    yield from auth_fixture.__wrapped__(postgresql_engine, monkeypatch)


@pytest.fixture
def application_access(auth):
    client, engine, users, logins, students = auth
    client.app.include_router(router)

    @client.app.get("/test/review/{application_id}")
    def get_review_application(
        application_id: int,
        user: Annotated[User, Depends(get_current_user)],
        db: Annotated[Session, Depends(get_db_session)],
    ):
        application = require_application_review(db, user, application_id)
        return {"id": str(application.id)}

    with Session(engine) as db, db.begin():
        db.execute(delete(Student).where(Student.user_id == users[0]))
        db.get(User, users[0]).role = "staff"
        units = [
            OrgUnit(name="Fictional Dean", type="dean_office"),
            OrgUnit(name="Fictional Accounting", type="accounting"),
        ]
        db.add_all(units)
        db.flush()
        profile = StaffProfile(user_id=users[0], org_unit_id=units[0].id)
        db.add(profile)
        db.flush()
        permissions = [
            StaffPermission(
                staff_profile_id=profile.id,
                permission_code="applications.review",
                scope_org_unit_id=units[0].id,
            ),
            StaffPermission(staff_profile_id=profile.id, permission_code="grades.edit"),
        ]
        services = [
            ServiceType(
                code=f"{logins[0]}-{i}",
                title="Fictional Service",
                processing_mode="review",
                responsible_org_unit_id=scope,
                produces_document=False,
            )
            for i, scope in enumerate([units[0].id, units[1].id, None])
        ]
        db.add_all([*permissions, *services])
        db.flush()
        applications = [
            Application(
                student_id=students[1],
                service_type_id=services[i].id,
                assigned_org_unit_id=assigned,
                review_status="submitted",
                document_status="not_required",
                form_data={},
            )
            for i, assigned in [(0, None), (1, None), (2, None), (1, units[0].id), (0, units[1].id)]
        ]
        db.add_all(applications)
        db.flush()
        state = SimpleNamespace(
            client=client,
            engine=engine,
            user_id=users[0],
            profile_id=profile.id,
            permission_id=permissions[0].id,
            units=[u.id for u in units],
            services=[s.id for s in services],
            applications=[a.id for a in applications],
        )
    try:
        login = client.login(json={"login": logins[0], "password": PASSWORD})
        assert login.status_code == 200
        state.token = login.json()["access_token"]
        yield state
    finally:
        with Session(engine) as db, db.begin():
            db.execute(delete(Application).where(Application.id.in_(state.applications)))
            db.execute(delete(ServiceType).where(ServiceType.id.in_(state.services)))
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id == state.profile_id)
            )
            db.execute(delete(StaffProfile).where(StaffProfile.id == state.profile_id))
            db.execute(delete(OrgUnit).where(OrgUnit.id.in_(state.units)))


def test_scope_expression_without_join_isolates_units_and_preserves_assignment_priority(
    application_access,
):
    state = application_access
    own, other, unknown, assigned_own, assigned_other = state.applications
    # No JOIN: unrelated service rows must never affect a specific application's scope.
    with Session(state.engine) as db:
        query = select(Application.id).where(Application.id.in_(state.applications))
        for unit, expected in [
            (state.units[0], {own, assigned_own}),
            (state.units[1], {other, assigned_other}),
        ]:
            assert set(db.scalars(query.where(get_application_scope() == unit))) == expected
            # Existing callers with explicit JOIN retain the same contract.
            assert (
                set(db.scalars(query.join(ServiceType).where(get_application_scope() == unit)))
                == expected
            )
        assert set(db.scalars(query.where(get_application_scope().is_(None)))) == {unknown}


@pytest.mark.parametrize("change", ["department", "role", "scope", "revoke", "blocked"])
def test_old_jwt_observes_committed_changes_in_context_and_application_access(
    application_access,
    change,
):
    state = application_access
    client, token = state.client, state.token
    path = "/api/v1/auth/context"
    own, other, unknown, assigned_own, assigned_other = state.applications

    def get_application(identifier):
        return client.request("GET", f"/test/review/{identifier}", access=token)

    context = client.request("GET", path, access=token)
    assert context.status_code == 200
    assert context.json() == {
        "user_id": str(state.user_id),
        "role": "staff",
        "org_unit_id": str(state.units[0]),
        "permissions": [
            {"permission_code": "applications.review", "scope_org_unit_id": str(state.units[0])},
            {"permission_code": "grades.edit", "scope_org_unit_id": None},
        ],
    }
    for identifier in (own, assigned_own):
        assert get_application(identifier).status_code == 200
    missing = get_application(9223372036854775807)
    assert missing.status_code == 404
    for identifier in (other, unknown, assigned_other):
        response = get_application(identifier)
        assert response.status_code == 404
        assert response.json() == missing.json()

    # This session commits before subsequent HTTP requests create their own sessions.
    with Session(state.engine) as db, db.begin():
        if change == "department":
            db.get(StaffProfile, state.profile_id).org_unit_id = state.units[1]
        elif change == "role":
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id == state.profile_id)
            )
            db.execute(delete(StaffProfile).where(StaffProfile.id == state.profile_id))
            db.get(User, state.user_id).role = "admin"
        elif change == "scope":
            db.get(StaffPermission, state.permission_id).scope_org_unit_id = state.units[1]
        elif change == "revoke":
            db.execute(delete(StaffPermission).where(StaffPermission.id == state.permission_id))
        else:
            db.get(User, state.user_id).is_active = False

    context = client.request("GET", path, access=token)
    if change == "blocked":
        assert context.status_code == 401
    else:
        assert context.status_code == 200
        expected = {
            "user_id": str(state.user_id),
            "role": "staff",
            "org_unit_id": str(state.units[0]),
            "permissions": [{"permission_code": "grades.edit", "scope_org_unit_id": None}],
        }
        if change == "department":
            expected.update(org_unit_id=str(state.units[1]), permissions=[])
        elif change == "role":
            expected.update(role="admin", org_unit_id=None, permissions=[])
        assert context.json() == expected
    for identifier in (*state.applications, 9223372036854775807):
        response = get_application(identifier)
        assert response.status_code == (401 if change == "blocked" else 403)
