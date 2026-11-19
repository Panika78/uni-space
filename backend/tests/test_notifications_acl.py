"""Exercise notification writes through the actual restricted production DB role."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401

from app.auth.security import create_access_token
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.dependencies.database import get_db_session
from app.models import AuthSession, Notification, User
from app.notifications import router

pytestmark = pytest.mark.integration


def test_production_role_can_only_update_notification_read_state(runtime_engine):  # noqa: F811
    admin_engine, api_engine = runtime_engine
    settings = Settings(
        _env_file=None,
        app_env="test",
        jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )
    with Session(admin_engine) as db:
        user = User(
            login=uuid4().hex,
            password_hash="unused",
            full_name="Вымышленный преподаватель",
            role="teacher",
            is_active=True,
        )
        db.add(user)
        db.flush()
        session = AuthSession(user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
        db.add(session)
        rows = [
            Notification(user_id=user.id, type="test", title="Тест", body="Текст") for _ in range(2)
        ]
        db.add_all(rows)
        db.commit()
        identifier = rows[0].id
        headers = {
            "Authorization": "Bearer " + create_access_token(session, settings)["access_token"]
        }
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[get_settings] = lambda: settings

    def get_runtime_db():
        with Session(api_engine) as db:
            yield db

    app.dependency_overrides[get_db_session] = get_runtime_db
    with TestClient(app) as client:
        assert client.get("/api/v1/notifications/unread-count", headers=headers).json() == {
            "count": 2
        }
        marked = client.patch(f"/api/v1/notifications/{identifier}/read", headers=headers)
        assert marked.status_code == 200, marked.text
        assert client.post("/api/v1/notifications/read-all", headers=headers).json() == {
            "updated_count": 1
        }
        assert (
            client.patch(f"/api/v1/notifications/{identifier}/read", headers=headers).json()
            == marked.json()
        )
        assert client.get("/api/v1/notifications/unread-count", headers=headers).json() == {
            "count": 0
        }
    with api_engine.connect() as db:
        for column in (
            "id",
            "user_id",
            "type",
            "title",
            "body",
            "entity_type",
            "entity_id",
            "created_at",
        ):
            assert not db.scalar(
                text("SELECT has_column_privilege(current_user,'notifications',:column,'UPDATE')"),
                {"column": column},
            )
            with pytest.raises(DBAPIError):
                db.execute(
                    text(f"UPDATE notifications SET {column}={column} WHERE id=:id"),
                    {"id": identifier},
                )
            db.rollback()
        for column in (
            "user_id",
            "logical_event_key",
            "audience_group_id",
            "type",
            "title",
            "body",
            "entity_type",
            "entity_id",
        ):
            assert db.scalar(
                text("SELECT has_column_privilege(current_user,'notifications',:column,'INSERT')"),
                {"column": column},
            )
        for column in ("id", "read_at", "created_at"):
            assert not db.scalar(
                text("SELECT has_column_privilege(current_user,'notifications',:column,'INSERT')"),
                {"column": column},
            )
        for privilege in ("INSERT", "DELETE"):
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'notifications',:privilege)"),
                {"privilege": privilege},
            )
