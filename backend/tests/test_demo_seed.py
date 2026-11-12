"""The explicit demonstration seed is isolated from ordinary test fixtures and applications."""

import importlib.util
from contextlib import contextmanager
from pathlib import Path
from secrets import token_urlsafe

import pytest
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.academics.service import get_student_academics
from app.core.config import get_settings
from app.models import (
    AcademicTerm,
    Application,
    AssessmentResult,
    CourseGroup,
    Lesson,
    News,
    Notification,
    Student,
    User,
)
from app.schedule.schemas import ScheduleParams
from app.schedule.service import list_student_schedule

pytestmark = pytest.mark.integration


def load_seed_module():
    path = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo_data.py"
    spec = importlib.util.spec_from_file_location("seed_demo_data", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_demo_seed_is_repeatable_and_preserves_user_application(db_session, monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    monkeypatch.setenv("DEMO_SEED_ALLOWED_DATABASE", url.database)
    monkeypatch.setenv("DEMO_SEED_ALLOWED_HOST", url.host)
    monkeypatch.setenv("DEMO_SEED_CONFIRM", f"SEED_UNI_SPACE_DEMO_DATA:{url.database}@{url.host}")
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_STUDENT_B_PASSWORD", token_urlsafe(24))

    def new_session():
        return Session(bind=db_session.connection(), join_transaction_mode="create_savepoint")

    class SessionFactory:
        @contextmanager
        def begin(self):
            with new_session() as session, session.begin():
                yield session

        def __call__(self):
            return new_session()

    monkeypatch.setattr(seed, "SessionLocal", SessionFactory())

    seed.seed_demo_data()
    pz = db_session.scalar(select(Student).join(User).where(User.login == "demo-pz101"))
    pm = db_session.scalar(select(Student).join(User).where(User.login == "demo-pm201"))
    assert pz is not None and pm is not None and pz.group_id != pm.group_id
    pz_user = db_session.get(User, pz.user_id)
    pm_user = db_session.get(User, pm.user_id)
    assert pz_user.password_hash.startswith("$argon2id$")
    assert pm_user.password_hash.startswith("$argon2id$")
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(AcademicTerm)
            .where(AcademicTerm.name == "Осенний семестр 2026/2027")
        )
        == 1
    )
    pz_academics = get_student_academics(db_session, pz)
    math = next(
        item for item in pz_academics.items if item.discipline.name == "Математический анализ"
    )
    history = next(item for item in pz_academics.items if item.discipline.name == "История России")
    assert (math.total_score, math.max_score, math.graded_assessment_count) == (0, 20, 1)
    assert math.final_result.has_debt is False
    assert (history.total_score, history.max_score, history.graded_assessment_count) == (0, 10, 0)
    pm_academics = get_student_academics(db_session, pm)
    assert all(item.total_score > 0 for item in pm_academics.items if item.assessment_count)
    schedule = list_student_schedule(
        db_session,
        pz.group_id,
        ScheduleParams(date_from="2026-11-19", date_to="2026-11-19"),
    )
    assert {item.status for item in schedule.items} >= {"moved", "cancelled"}
    moved_intro = next(
        item
        for item in schedule.items
        if item.course_offering.discipline.name == "Введение в зельеварение"
    )
    assert moved_intro.latest_lesson.starts_at.date().isoformat() == "2026-11-23"

    application = Application(
        student_id=pz.id,
        service_type_id=db_session.scalar(
            select(seed.ServiceType.id).where(seed.ServiceType.code == "study_certificate")
        ),
        review_status="submitted",
        document_status="pending",
        form_data={"place": "деканат"},
    )
    db_session.add(application)
    db_session.flush()
    application_snapshot = (
        application.id,
        application.student_id,
        application.review_status,
        application.form_data.copy(),
    )
    before = {
        "lessons": db_session.scalar(select(func.count()).select_from(Lesson)),
        "news": db_session.scalar(select(func.count()).select_from(News)),
        "notifications": db_session.scalar(select(func.count()).select_from(Notification)),
        "course_groups": db_session.scalar(select(func.count()).select_from(CourseGroup)),
        "results": db_session.scalar(select(func.count()).select_from(AssessmentResult)),
    }

    seed.seed_demo_data()
    after = {
        "lessons": db_session.scalar(select(func.count()).select_from(Lesson)),
        "news": db_session.scalar(select(func.count()).select_from(News)),
        "notifications": db_session.scalar(select(func.count()).select_from(Notification)),
        "course_groups": db_session.scalar(select(func.count()).select_from(CourseGroup)),
        "results": db_session.scalar(select(func.count()).select_from(AssessmentResult)),
    }
    db_session.refresh(application)
    assert after == before
    assert (
        application.id,
        application.student_id,
        application.review_status,
        application.form_data,
    ) == application_snapshot
    assert (
        db_session.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == pz.user_id)
        )
        == 2
    )
    assert (
        db_session.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == pm.user_id)
        )
        == 2
    )


def test_demo_seed_refuses_unconfirmed_database(monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    monkeypatch.setenv("DEMO_SEED_ALLOWED_DATABASE", url.database)
    monkeypatch.setenv("DEMO_SEED_ALLOWED_HOST", url.host)
    monkeypatch.delenv("DEMO_SEED_CONFIRM", raising=False)
    with pytest.raises(RuntimeError, match="Explicit DEMO_SEED_CONFIRM"):
        seed.require_safe_target()
