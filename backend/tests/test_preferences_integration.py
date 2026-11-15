"""Real PostgreSQL and existing JWT/session authorization; no identity overrides."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from test_schedule_integration import schedule  # noqa: F401

from app.models import UserPreferences
from app.preferences import router

pytestmark = pytest.mark.integration
PATH = "/api/v1/users/me/preferences"


@pytest.fixture
def preferences(schedule):  # noqa: F811
    schedule.app.include_router(router)
    return schedule


def request(s, method="GET", index=0, **kwargs):
    return s.client.request(
        method, PATH, headers={"Authorization": f"Bearer {s.tokens[index]}"}, **kwargs
    )


def test_preferences_default_upsert_restore_and_account_isolation(preferences):
    s = preferences
    assert request(s).json() == {"show_cancelled_lessons": True}
    assert s.db.scalar(select(UserPreferences)) is None
    for show in (False, True, False):
        response = request(s, "PATCH", json={"show_cancelled_lessons": show})
        assert response.status_code == 200
        assert response.json() == {"show_cancelled_lessons": show}
        s.db.expire_all()
        assert request(s).json() == response.json()
        assert request(s, index=1).json() == {"show_cancelled_lessons": True}
    assert len(s.db.scalars(select(UserPreferences)).all()) == 1
    row = s.db.get(UserPreferences, s.users[0].id)
    assert row.preferences == {"show_cancelled_lessons": False}
    assert row.updated_at.tzinfo is not None


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"show_cancelled_lessons": None},
        {"show_cancelled_lessons": "false"},
        {"show_cancelled_lessons": 0},
        {"show_cancelled_lessons": 1},
        {"show_cancelled_lessons": []},
        {"show_cancelled_lessons": {}},
        {"show_cancelled_lessons": False, "theme": "dark"},
        {"show_cancelled_lessons": False, "user_id": "2"},
        {"preferences": {"show_cancelled_lessons": False}},
    ],
)
def test_preferences_reject_invalid_keys_types_and_foreign_identity(preferences, payload):
    s = preferences
    assert request(s, "PATCH", json=payload).status_code == 422
    assert request(s).json() == {"show_cancelled_lessons": True}
    assert s.db.scalar(select(UserPreferences)) is None


def test_preferences_require_live_session_and_have_no_other_user_route(preferences):
    s = preferences
    for method in ("GET", "PATCH"):
        assert (
            s.client.request(method, PATH, json={"show_cancelled_lessons": False}).status_code
            == 401
        )
    assert (
        s.client.patch(
            f"/api/v1/users/{s.users[1].id}/preferences",
            headers={"Authorization": f"Bearer {s.tokens[0]}"},
            json={"show_cancelled_lessons": False},
        ).status_code
        == 404
    )
    from datetime import UTC, datetime

    s.sessions[0].revoked_at = datetime.now(UTC)
    s.db.flush()
    assert request(s).status_code == 401
    assert request(s, "PATCH", json={"show_cancelled_lessons": False}).status_code == 401


@pytest.mark.parametrize(
    "values",
    [{}, [], {"theme": True}, {"show_cancelled_lessons": "true"}, {"show_cancelled_lessons": None}],
)
def test_database_rejects_invalid_preference_values(preferences, values):
    s = preferences
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.add(UserPreferences(user_id=s.users[0].id, preferences=values))
        s.db.flush()
