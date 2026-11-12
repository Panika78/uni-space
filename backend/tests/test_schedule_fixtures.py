"""Validate the actual deployment/browser fixtures against PostgreSQL."""

from contextlib import nullcontext
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import CourseOffering, Lesson

pytestmark = pytest.mark.integration


def test_schedule_fixture_moves_preserve_course_and_discipline(db_session, monkeypatch):
    spec = spec_from_file_location(
        "schedule_fixtures", Path(__file__).resolve().parents[2] / "deploy/schedule_fixtures.py"
    )
    fixtures = module_from_spec(spec)
    spec.loader.exec_module(fixtures)
    monkeypatch.setattr(
        fixtures, "SessionLocal", SimpleNamespace(begin=lambda: nullcontext(db_session))
    )
    monkeypatch.setattr(
        fixtures, "PASSWORD_HASHER", SimpleNamespace(hash=lambda _: "unusable-fictional-fixture")
    )
    existing_ids = set(db_session.scalars(select(Lesson.id)))
    fixtures.seed_schedule_fixtures("fictional-test-password")
    lessons = {
        lesson.id: lesson
        for lesson in db_session.scalars(select(Lesson))
        if lesson.id not in existing_ids
    }
    courses = {course.id: course for course in db_session.scalars(select(CourseOffering))}
    continuations = [lesson for lesson in lessons.values() if lesson.previous_lesson_id]
    assert len(continuations) == 6  # A→B and A→B→C, including unavailable/cancelled terminals.
    for lesson in continuations:
        previous = lessons[lesson.previous_lesson_id]
        assert lesson.course_offering_id == previous.course_offering_id
        assert (
            courses[lesson.course_offering_id].discipline_id
            == courses[previous.course_offering_id].discipline_id
        )
