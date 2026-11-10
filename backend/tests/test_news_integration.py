import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.main import app
from app.models.accounts import User
from app.models.news import News
from app.news.service import create_excerpt, get_published_news, list_published_news


def test_create_excerpt_normalizes_unicode_whitespace_and_limits_length() -> None:
    assert create_excerpt("  Привет\n\tмир  ") == "Привет мир"
    assert create_excerpt("😀" * 181) == "😀" * 179 + "…"
    assert len(create_excerpt("слово " * 100)) == 180
    assert create_excerpt(" \n\t ") == ""


def test_news_list_rejects_cursors_with_invalid_timestamp_or_id(db_session) -> None:
    malformed_values = [("not-a-date", 1), ("2026-11-10T12:00:00", 1), ("2026-11-10T12:00:00Z", 0)]
    for key in malformed_values:
        raw = json.dumps({"v": 2, "direction": "desc", "key": key}, separators=(",", ":"))
        cursor = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
        with pytest.raises(ValueError):
            list_published_news(db_session, limit=20, cursor=cursor)


@pytest.mark.integration
def test_news_sql_filters_visibility_and_keyset_pages_are_stable(db_session) -> None:
    now = datetime.now(UTC).replace(microsecond=0)
    exact_boundary = db_session.scalar(select(func.now()))
    rows = [
        News(title=f"news-{index}", body=f"body-{index}", published_at=now, is_published=True)
        for index in range(5)
    ]
    hidden = [
        News(title="draft", body="x", published_at=now, is_published=False),
        News(title="future", body="x", published_at=now + timedelta(days=1), is_published=True),
        News(title="undated", body="x", published_at=None, is_published=True),
    ]
    boundary = News(
        title="exact-current-time",
        body="boundary",
        published_at=exact_boundary,
        is_published=True,
    )
    db_session.add_all([*rows, *hidden, boundary])
    db_session.flush()

    first = list_published_news(db_session, limit=2, cursor=None)
    assert len(first.items) == 2
    assert first.next_cursor is not None
    # A newly published item sorts ahead of page one and does not shift its cursor boundary.
    latest = News(
        title="arrived-between-pages",
        body="new",
        published_at=now + timedelta(seconds=1),
        is_published=True,
    )
    db_session.add(latest)
    db_session.flush()

    second = list_published_news(db_session, limit=2, cursor=first.next_cursor)
    third = list_published_news(db_session, limit=2, cursor=second.next_cursor)
    seen = [item.id for page in (first, second, third) for item in page.items]
    assert len(seen) == len(set(seen)) == len(rows) + 1
    assert str(latest.id) not in seen
    same_time_ids = [
        int(item.id)
        for page in (first, second, third)
        for item in page.items
        if item.published_at == now
    ]
    assert same_time_ids == sorted(same_time_ids, reverse=True)

    for row in hidden:
        assert get_published_news(db_session, row.id) is None
    assert get_published_news(db_session, 9_999_999) is None
    assert get_published_news(db_session, rows[0].id) is not None
    assert get_published_news(db_session, boundary.id) is not None


@pytest.mark.integration
def test_news_api_returns_same_not_found_for_hidden_and_missing_ids(db_session) -> None:
    now = datetime.now(UTC)
    visible = News(title="Visible", body="Text", published_at=now, is_published=True)
    hidden = News(title="Hidden", body="Secret", published_at=now, is_published=False)
    db_session.add_all([visible, hidden])
    db_session.flush()
    app.dependency_overrides[get_current_student] = lambda: object()
    app.dependency_overrides[get_db_session] = lambda: db_session
    try:
        with TestClient(app) as client:
            app.dependency_overrides.pop(get_current_student)
            assert client.get(f"/api/v1/news/{visible.id}").status_code == 401
            app.dependency_overrides[get_current_student] = lambda: object()
            assert client.get(f"/api/v1/news/{hidden.id}").status_code == 404
            assert client.get("/api/v1/news/99999999").status_code == 404
            assert client.get("/api/v1/news?limit=0").status_code == 422
            assert client.get("/api/v1/news?cursor=broken").status_code == 422
            invalid_key = (
                base64.urlsafe_b64encode(
                    json.dumps(
                        {"v": 2, "direction": "desc", "key": ["not-a-date", 1]},
                        separators=(",", ":"),
                    ).encode()
                )
                .decode()
                .rstrip("=")
            )
            assert client.get(f"/api/v1/news?cursor={invalid_key}").status_code == 422
            assert client.get("/api/v1/news?limit=2&limit=3").status_code == 422
            assert client.get("/api/v1/news?offset=1").status_code == 422
            assert client.get("/api/v1/news?limit=1").status_code == 200
            assert client.get("/api/v1/news?limit=100").status_code == 200
            app.dependency_overrides.pop(get_current_student)
            app.dependency_overrides[get_current_user] = lambda: User(
                id=1,
                login="fictional-staff",
                password_hash="not-used",
                full_name="Fictional Staff",
                role="staff",
                is_active=True,
            )
            response = client.get("/api/v1/news")
            assert response.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.integration
def test_news_api_hides_unexpected_server_errors(db_session, monkeypatch) -> None:
    from app.news import router as news_router

    def fail_query(*_args, **_kwargs):
        raise RuntimeError("sensitive database failure")

    monkeypatch.setattr(news_router, "list_published_news", fail_query)
    app.dependency_overrides[get_current_student] = lambda: object()
    app.dependency_overrides[get_db_session] = lambda: db_session
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get("/api/v1/news")
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "internal_error"
        assert "sensitive database failure" not in response.text
    finally:
        app.dependency_overrides.clear()
