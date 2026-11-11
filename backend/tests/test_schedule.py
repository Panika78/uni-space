from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.errors import install_exception_handlers
from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Student
from app.schedule.router import router
from app.schedule.schemas import ScheduleParams


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"date_from": "2026-11-01"},
        {"date_from": "2026-11-02", "date_to": "2026-11-01"},
        {"date_from": "2026-01-01", "date_to": "2026-02-01"},
        {"date_from": "2026-02-29", "date_to": "2026-03-01"},
        {"date_from": "2026-1-01", "date_to": "2026-01-01"},
        {"date_from": "2026-11-01T00:00:00Z", "date_to": "2026-11-01"},
        {"date_from": "2026-11-01", "date_to": "2026-11-01", "student_id": "2"},
        {"date_from": "2026-11-01", "date_to": "2026-11-01", "group_id": "2"},
    ],
)
def test_schedule_rejects_invalid_or_foreign_selector_params(params):
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[get_current_student] = lambda: Student(id=1, group_id=1)
    app.dependency_overrides[get_db_session] = lambda: None
    response = TestClient(app).get("/api/v1/schedule", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize(
    "start,end",
    [
        ("2026-01-01", "2026-01-31"),
        ("2026-11-01", "2026-11-01"),
        ("2028-02-01", "2028-03-02"),
        ("9999-12-31", "9999-12-31"),
    ],
)
def test_schedule_accepts_one_through_31_calendar_days(start, end):
    assert ScheduleParams(date_from=start, date_to=end).date_from == date.fromisoformat(start)
