"""Exercise all administration writes as the actual production runtime role."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_admin_integration import admin, create, request  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401

from app.models import User

pytestmark = pytest.mark.integration


@pytest.fixture
def engine(runtime_engine):  # noqa: F811
    return runtime_engine[0]


def test_admin_operations_with_production_acl(admin, runtime_engine):  # noqa: F811
    from app.dependencies.database import get_db_session

    engine = runtime_engine[1]

    def runtime_session():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    admin[0].app.dependency_overrides[get_db_session] = runtime_session
    for role in ("student", "teacher", "staff", "admin"):
        result = create(admin, role)
        uid = result["user"]["id"]
        login = admin[0].login(json={"login": role, "password": result["initial_password"]})
        assert login.status_code == 200
        with Session(engine) as db:
            assert db.scalar(select(User.id).where(User.id == int(uid)).with_for_update()) == int(
                uid
            )
        with engine.begin() as db, pytest.raises(DBAPIError) as denied:
            db.execute(text("UPDATE users SET id=id WHERE id=:id"), {"id": int(uid)})
        assert denied.value.orig.sqlstate == "42501"
        assert request(admin, "PUT", f"/{uid}/active", json={"is_active": False}).status_code == 200
        assert request(admin, "PUT", f"/{uid}/active", json={"is_active": True}).status_code == 200
        if role == "staff":
            grant = {"permission_code": "grades.edit", "scope_org_unit_id": None}
            assert request(admin, "PUT", f"/{uid}/permissions", json=grant).status_code == 200
            assert request(admin, "DELETE", f"/{uid}/permissions", json=grant).status_code == 200
            assert request(admin, "PUT", f"/{uid}/permissions", json=grant).status_code == 200
            assert (
                request(
                    admin, "PUT", f"/{uid}/department", json={"org_unit_id": admin[3]["other_unit"]}
                ).status_code
                == 200
            )
    with Session(engine) as db:
        for table, column in [
            ("users", "id"),
            ("users", "password_hash"),
            ("users", "role"),
            ("students", "user_id"),
            ("teachers", "full_name"),
            ("staff_profiles", "user_id"),
        ]:
            assert not db.scalar(
                text("SELECT has_column_privilege(current_user,:table,:column,'UPDATE')"),
                {"table": table, "column": column},
            )
        for operation in ("UPDATE", "DELETE"):
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'audit_events',:operation)"),
                {"operation": operation},
            )
        assert not db.scalar(
            text("SELECT has_column_privilege(current_user,'audit_events','after_data','SELECT')")
        )


def test_bootstrap_with_production_runtime_acl(runtime_engine):  # noqa: F811
    from sqlalchemy import select

    from app.admin.bootstrap import bootstrap_admin
    from app.models import User

    engine = runtime_engine[1]
    with Session(engine) as db, db.begin():
        uid, password = bootstrap_admin(db, login="bootstrap-runtime", full_name="Fictional")
    with Session(engine) as db:
        assert db.get(User, uid).role == "admin"
        assert len(password) >= 32
        # Runtime cannot read audit payload/actor; trusted operator verifies below.
        assert db.scalar(select(User.id)) == uid
    with runtime_engine[0].connect() as db:
        assert db.scalar(text("SELECT actor_user_id IS NULL FROM audit_events"))


def test_bootstrap_runtime_audit_denial_rolls_back(runtime_engine):  # noqa: F811
    from sqlalchemy import func, select
    from sqlalchemy.exc import DBAPIError

    from app.admin.bootstrap import bootstrap_admin
    from app.models import User

    owner, runtime = runtime_engine
    with owner.begin() as db:
        db.execute(text("REVOKE INSERT ON audit_events FROM uni_space_api"))
    with pytest.raises(DBAPIError), Session(runtime) as db, db.begin():
        bootstrap_admin(db, login="must-rollback", full_name="Fictional")
    with owner.connect() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0
