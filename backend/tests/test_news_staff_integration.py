from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth.security import create_access_token
from app.core.config import get_settings
from app.dependencies.database import get_db_session
from app.main import app
from app.models import (
    AuditEvent,
    AuthSession,
    News,
    OrgUnit,
    Program,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    User,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def news_client(db_session):
    unit = OrgUnit(name=f"News unit {uuid4().hex}", type="dean_office")
    faculty = OrgUnit(name=f"Faculty {uuid4().hex}", type="faculty")
    db_session.add_all([unit, faculty])
    db_session.flush()
    program = Program(
        code=uuid4().hex,
        name="Fictional",
        direction_code="00",
        direction_name="Fictional",
        faculty_id=faculty.id,
    )
    db_session.add(program)
    db_session.flush()
    group = StudyGroup(name=f"Group {uuid4().hex}", program_id=program.id, course_number=1)
    db_session.add(group)
    db_session.flush()

    def create_account(role="staff", *, permission=True):
        user = User(
            login=uuid4().hex,
            password_hash="fictional",
            full_name="Fictional User",
            role=role,
            is_active=True,
        )
        db_session.add(user)
        db_session.flush()
        if role == "staff":
            profile = StaffProfile(user_id=user.id, org_unit_id=unit.id)
            db_session.add(profile)
            db_session.flush()
            if permission:
                db_session.add(
                    StaffPermission(
                        staff_profile_id=profile.id,
                        permission_code="news.publish",
                        scope_org_unit_id=unit.id,
                    )
                )
        if role == "student":
            db_session.add(Student(user_id=user.id, group_id=group.id, academic_status="enrolled"))
        session = AuthSession(
            user_id=user.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db_session.add(session)
        db_session.flush()
        token = create_access_token(session, get_settings())["access_token"]
        return user, token

    app.dependency_overrides[get_db_session] = lambda: db_session
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client, create_account, db_session
    finally:
        app.dependency_overrides.clear()


def test_staff_news_full_publication_cycle_and_student_visibility(news_client):
    client, create_account, db = news_client
    author, author_token = create_account()
    editor, editor_token = create_account()
    student, student_token = create_account("student")
    created = client.post(
        "/api/v1/staff/news",
        headers={"Authorization": f"Bearer {author_token}"},
        json={"title": "  Открытая лекция  ", "body": "Первая строка\nВторая строка"},
    )
    assert created.status_code == 201
    item = created.json()
    assert item["title"] == "Открытая лекция"
    assert item["body"] == "Первая строка\nВторая строка"
    assert item["author_user_id"] == str(author.id)
    assert item["is_published"] is False and item["published_at"] is None
    item_id = item["id"]
    second = client.post(
        "/api/v1/staff/news",
        headers={"Authorization": "Bearer " + author_token},
        json={"title": "Вторая новость", "body": "Текст"},
    ).json()
    third = client.post(
        "/api/v1/staff/news",
        headers={"Authorization": "Bearer " + author_token},
        json={"title": "Третья новость", "body": "Текст"},
    ).json()
    first_page = client.get(
        "/api/v1/staff/news?limit=2", headers={"Authorization": f"Bearer {author_token}"}
    ).json()
    next_page = client.get(
        f"/api/v1/staff/news?limit=2&cursor={first_page['next_cursor']}",
        headers={"Authorization": f"Bearer {author_token}"},
    ).json()
    listed_ids = [row["id"] for row in first_page["items"] + next_page["items"]]
    assert listed_ids == sorted([item_id, second["id"], third["id"]], key=int, reverse=True)
    assert (
        client.get(
            f"/api/v1/staff/news/{item_id}", headers={"Authorization": f"Bearer {editor_token}"}
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/v1/news/{item_id}", headers={"Authorization": f"Bearer {student_token}"}
        ).status_code
        == 404
    )
    student_feed = client.get(
        "/api/v1/news", headers={"Authorization": f"Bearer {student_token}"}
    ).json()
    assert not student_feed["items"]

    published = client.post(
        f"/api/v1/staff/news/{item_id}/publish", headers={"Authorization": f"Bearer {editor_token}"}
    )
    assert published.status_code == 200
    first_published_at = published.json()["published_at"]
    assert published.json()["author_user_id"] == str(author.id)
    repeated_publish = client.post(
        f"/api/v1/staff/news/{item_id}/publish",
        headers={"Authorization": f"Bearer {editor_token}"},
    )
    assert repeated_publish.json()["published_at"] == first_published_at
    assert (
        client.get(
            f"/api/v1/news/{item_id}", headers={"Authorization": f"Bearer {student_token}"}
        ).status_code
        == 200
    )

    updated = client.patch(
        f"/api/v1/staff/news/{item_id}",
        headers={"Authorization": f"Bearer {editor_token}"},
        json={"title": "Обновлённая лекция", "body": "Текст\nс переносом"},
    )
    assert updated.status_code == 200
    assert updated.json()["published_at"] == first_published_at
    assert updated.json()["author_user_id"] == str(author.id)
    same_update = client.patch(
        f"/api/v1/staff/news/{item_id}",
        headers={"Authorization": f"Bearer {editor_token}"},
        json={"title": "Обновлённая лекция", "body": "Текст\nс переносом"},
    )
    assert same_update.status_code == 200

    assert (
        client.post(
            f"/api/v1/staff/news/{item_id}/unpublish",
            headers={"Authorization": f"Bearer {editor_token}"},
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/v1/news/{item_id}", headers={"Authorization": f"Bearer {student_token}"}
        ).status_code
        == 404
    )
    republished = client.post(
        f"/api/v1/staff/news/{item_id}/publish", headers={"Authorization": f"Bearer {editor_token}"}
    )
    assert republished.status_code == 200
    assert republished.json()["published_at"] >= first_published_at

    audit = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.entity_type == "news", AuditEvent.entity_id == int(item_id))
        .order_by(AuditEvent.id)
    ).all()
    assert [event.action for event in audit] == [
        "create",
        "publish",
        "update",
        "unpublish",
        "publish",
    ]
    assert all(event.actor_user_id in {author.id, editor.id} for event in audit)
    assert audit[2].actor_user_id == editor.id


def test_staff_news_rechecks_permission_roles_and_input_validation(news_client):
    client, create_account, db = news_client
    staff, token = create_account(permission=False)
    assert (
        client.get("/api/v1/staff/news", headers={"Authorization": f"Bearer {token}"}).status_code
        == 403
    )
    profile = db.scalar(select(StaffProfile).where(StaffProfile.user_id == staff.id))
    db.add(
        StaffPermission(
            staff_profile_id=profile.id,
            permission_code="news.publish",
            scope_org_unit_id=profile.org_unit_id,
        )
    )
    db.flush()
    assert (
        client.get("/api/v1/staff/news", headers={"Authorization": f"Bearer {token}"}).status_code
        == 200
    )
    permission = db.scalar(
        select(StaffPermission).where(StaffPermission.staff_profile_id == profile.id)
    )
    original_unit_id = profile.org_unit_id
    other_unit = OrgUnit(name=f"Other unit {uuid4().hex}", type="dean_office")
    db.add(other_unit)
    db.flush()
    profile.org_unit_id = other_unit.id
    db.flush()
    assert (
        client.get("/api/v1/staff/news", headers={"Authorization": f"Bearer {token}"}).status_code
        == 403
    )
    profile.org_unit_id = original_unit_id
    db.delete(permission)
    db.flush()
    assert (
        client.get("/api/v1/staff/news", headers={"Authorization": f"Bearer {token}"}).status_code
        == 403
    )
    for role in ("student", "teacher", "admin"):
        _, denied = create_account(role)
        assert (
            client.post(
                "/api/v1/staff/news",
                headers={"Authorization": f"Bearer {denied}"},
                json={"title": "T", "body": "B"},
            ).status_code
            == 403
        )
    for payload in (
        {"title": "  ", "body": "body"},
        {"title": "x" * 201, "body": "body"},
        {"title": "title", "body": " \n "},
        {"title": "title", "body": "bad\u0000text"},
        {"title": "title", "body": "x" * 20_001},
        {"title": "title", "body": "body", "is_published": True},
    ):
        assert (
            client.post(
                "/api/v1/staff/news", headers={"Authorization": f"Bearer {token}"}, json=payload
            ).status_code
            == 422
        )
    db.add(
        StaffPermission(
            staff_profile_id=profile.id,
            permission_code="news.publish",
            scope_org_unit_id=profile.org_unit_id,
        )
    )
    db.flush()
    valid = client.post(
        "/api/v1/staff/news",
        headers={"Authorization": f"Bearer {token}"},
        json={"title": "x" * 200, "body": "Ж" * 20_000},
    )
    assert valid.status_code == 201
    assert len(valid.json()["title"]) == 200 and len(valid.json()["body"]) == 20_000
    assert db.scalar(select(func.count()).select_from(News)) == 1


def test_staff_news_audit_failure_rolls_back_create(news_client, monkeypatch):
    client, create_account, db = news_client
    _, token = create_account()
    from app.news import service

    def fail_audit(*_args, **_kwargs):
        raise RuntimeError("writer failed")

    monkeypatch.setattr(service, "write_audit_event", fail_audit)
    response = client.post(
        "/api/v1/staff/news",
        headers={"Authorization": f"Bearer {token}"},
        json={"title": "Title", "body": "Body"},
    )
    assert response.status_code == 500
    assert db.scalar(select(func.count()).select_from(News)) == 0
    assert (
        db.scalar(
            select(func.count()).select_from(AuditEvent).where(AuditEvent.entity_type == "news")
        )
        == 0
    )


def test_staff_news_keeps_nullable_author_for_legacy_rows(news_client):
    client, create_account, db = news_client
    _, token = create_account()
    legacy = News(title="Историческая новость", body="Без автора", author_user_id=None)
    db.add(legacy)
    db.flush()
    response = client.get(
        f"/api/v1/staff/news/{legacy.id}", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    assert response.json()["author_user_id"] is None
