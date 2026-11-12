"""Exercise the real E2E seed scripts against PostgreSQL past the original term."""

import importlib.util
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.academics.service import get_student_academics
from app.models import Student, User

pytestmark = pytest.mark.integration


def load_fixture_module(name):
    path = Path(__file__).resolve().parents[2] / "deploy" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "moment",
    [
        "2027-01-31T20:59:59+00:00",
        "2027-01-31T21:00:00+00:00",
        "2028-02-29T09:00:00+00:00",
        "2032-08-31T21:00:00+00:00",
    ],
)
def test_browser_fixtures_have_active_term_across_moscow_boundaries(
    db_session, monkeypatch, moment
):
    schedule = load_fixture_module("schedule_fixtures")
    academics = load_fixture_module("academics_fixtures")

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromisoformat(moment).astimezone(tz or UTC)

    @contextmanager
    def transaction():
        yield db_session

    for module in (schedule, academics):
        monkeypatch.setattr(module, "SessionLocal", SimpleNamespace(begin=transaction))
        monkeypatch.setattr(module, "datetime", Clock)
    monkeypatch.setattr("app.academics.service.datetime", Clock)
    schedule.seed_schedule_fixtures("fictional-fixture-password")
    academics.seed_academics_fixtures()
    student = db_session.scalar(
        select(Student).join(User).where(User.login == "schedule-fixture-1")
    )
    response = get_student_academics(db_session, student)
    assert response.term is not None
    today = Clock.now(ZoneInfo("Europe/Moscow")).date()
    assert response.term.starts_on <= today <= response.term.ends_on
    item = next(
        i for i in response.items if i.discipline.name == "Успеваемость: тестовый предмет 1"
    )
    assert (item.total_score, item.max_score) == (6, 30)
