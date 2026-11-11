import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

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
    malformed_values = [("not-a-number", 1), (1, 0), (10**30, 1)]
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
    second = list_published_news(db_session, limit=2, cursor=first.next_cursor)
    third = list_published_news(db_session, limit=2, cursor=second.next_cursor)
    seen = [item.id for page in (first, second, third) for item in page.items]
    assert len(seen) == len(set(seen)) == len(rows) + 1
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
def test_news_cursor_uses_absolute_time_across_offset_boundaries(db_session) -> None:
    first_moment = datetime.fromisoformat("2026-10-25T02:30:00+02:00")
    second_moment = datetime.fromisoformat("2026-10-25T02:15:00+01:00")
    older = News(title="offset-older", body="old", published_at=first_moment, is_published=True)
    newer = News(title="offset-newer", body="new", published_at=second_moment, is_published=True)
    db_session.add_all([older, newer])
    db_session.flush()

    first = list_published_news(db_session, limit=1, cursor=None)
    second = list_published_news(db_session, limit=1, cursor=first.next_cursor)

    assert first.items[0].id == str(newer.id)
    assert second.items[0].id == str(older.id)
    assert first.items[0].published_at.astimezone(UTC) > second.items[0].published_at.astimezone(
        UTC
    )


@pytest.mark.integration
def test_news_keyset_survives_new_publication_between_transactions(postgresql_engine) -> None:
    prefix = f"cursor-arrival-{uuid4()}"
    titles = [f"{prefix}-{index}" for index in range(5)]
    try:
        with Session(postgresql_engine) as seed_session:
            now = datetime.now(UTC) - timedelta(minutes=2)
            seed_session.add_all(
                [
                    News(title=title, body=title, published_at=now, is_published=True)
                    for title in titles
                ]
            )
            seed_session.commit()

        with Session(postgresql_engine) as first_session:
            first = list_published_news(first_session, limit=2, cursor=None)
        assert first.next_cursor is not None

        with Session(postgresql_engine) as publisher_session:
            arrived = News(
                title=f"{prefix}-new",
                body="newly visible",
                published_at=func.clock_timestamp(),
                is_published=True,
            )
            publisher_session.add(arrived)
            publisher_session.commit()
            arrived_id = arrived.id

        with Session(postgresql_engine) as visibility_session:
            head = list_published_news(visibility_session, limit=2, cursor=None)
        assert head.items[0].id == str(arrived_id)

        with Session(postgresql_engine) as continuation_session:
            second = list_published_news(continuation_session, limit=2, cursor=first.next_cursor)
        assert second.next_cursor is not None
        with Session(postgresql_engine) as final_session:
            third = list_published_news(final_session, limit=2, cursor=second.next_cursor)

        original_ids = {item.id for item in first.items + second.items + third.items}
        assert len(original_ids) == 5
        assert {item.title for page in (first, second, third) for item in page.items} == set(titles)
        assert str(arrived_id) not in original_ids
    finally:
        with Session(postgresql_engine) as cleanup_session:
            cleanup_session.execute(delete(News).where(News.title.like(f"{prefix}%")))
            cleanup_session.commit()


@pytest.mark.integration
def test_news_title_constraint_rejects_whitespace_only_titles(db_session) -> None:
    for index, title in enumerate(("\t", "\n", " \t\r\n ")):
        with db_session.begin_nested():
            db_session.add(
                News(title=title, body=f"blank-{index}", published_at=None, is_published=False)
            )
            with pytest.raises(IntegrityError):
                db_session.flush()


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
            assert client.get("/api/v1/news/" + "9" * 5000).status_code == 422
            assert client.get("/api/v1/news/9223372036854775808").status_code == 422
            assert client.get("/api/v1/news/99999999?limit=1").status_code == 422
            assert client.get("/api/v1/news/99999999?cursor=broken").status_code == 422
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
