"""The explicit demonstration seed is isolated from ordinary test fixtures and applications."""

import importlib.util
import os
import subprocess
import sys
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from secrets import token_urlsafe
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.academics.service import get_student_academics
from app.core.config import get_settings
from app.dependencies.database import get_db_session
from app.main import app
from app.models import (
    AcademicTerm,
    Application,
    AssessmentResult,
    CourseGroup,
    Lesson,
    LessonGroup,
    LessonRoom,
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


def configure_seed_target(monkeypatch, url, *, confirmation_url=None):
    confirmation_target = confirmation_url or url
    target = (
        confirmation_target.host,
        confirmation_target.port or 5432,
        confirmation_target.database,
        confirmation_target.username,
    )
    monkeypatch.setenv("DEMO_SEED_ALLOWED_HOST", url.host)
    monkeypatch.setenv("DEMO_SEED_ALLOWED_PORT", str(url.port or 5432))
    monkeypatch.setenv("DEMO_SEED_ALLOWED_DATABASE", url.database)
    monkeypatch.setenv("DEMO_SEED_ALLOWED_ROLE", url.username)
    monkeypatch.setenv("DEMO_SEED_CONFIRM", load_seed_module().expected_confirmation(target))


def test_demo_data_documentation_matches_seed_date_constants():
    seed = load_seed_module()
    documentation = Path(__file__).resolve().parents[2] / "docs" / "DEMO_DATA.md"
    content = " ".join(documentation.read_text().split())
    assert "## Опорная дата и окно конкурсной демонстрации" in content
    assert "19 ноября 2026 года" in content
    assert "8–28 ноября 2026 года" in content
    assert "1 сентября 2026 — 31 января 2027 года" in content
    assert "`Europe/Moscow`" in content
    assert seed.MOSCOW.key == "Europe/Moscow"
    assert "GET /academics" in content
    assert seed.date(2026, 9, 1) == seed.TERM_START
    assert seed.date(2027, 1, 31) == seed.TERM_END
    assert "19, 20, 21 и 23 ноября" in content
    assert "После 31 января 2027 года" in content
    assert "временной PostgreSQL-БД" in content


def test_demo_seed_is_repeatable_and_preserves_user_application(db_session, monkeypatch):
    from app.auth import router as auth_routes
    from app.auth.rate_limit import LoginRateLimiter

    # Each acceptance fixture owns its limiter; retain the real default limit.
    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter())
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    configure_seed_target(monkeypatch, url)
    student_a_password = token_urlsafe(24)
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", student_a_password)
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
    assert pz_user.full_name == "Иван Сергеевич Гончаров"
    assert pm_user.full_name == "Амели Викторовна Волкова"
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
    intro_lessons = db_session.scalars(
        select(Lesson)
        .join(seed.CourseOffering)
        .join(seed.Discipline)
        .where(seed.Discipline.name == "Введение в зельеварение")
        .order_by(Lesson.starts_at)
    ).all()
    intro_chain = {
        lesson.starts_at.date().isoformat(): lesson
        for lesson in intro_lessons
        if lesson.starts_at.date().isoformat() in {"2026-11-19", "2026-11-20", "2026-11-23"}
    }
    root = intro_chain["2026-11-19"]
    middle = intro_chain["2026-11-20"]
    final = intro_chain["2026-11-23"]
    assert (root.status, middle.status, final.status) == ("moved", "moved", "scheduled")
    assert middle.previous_lesson_id == root.id
    assert final.previous_lesson_id == middle.id
    schedule_news = db_session.scalar(select(News).where(News.title == seed.DEMO_NEWS[0][0]))
    assert schedule_news is not None
    assert "20 ноября" in schedule_news.body
    assert "23 ноября 2026 года" in schedule_news.body
    assert "проверка защитных контуров из-за нестабильного магического фона" in (schedule_news.body)

    chemistry_cancellation = db_session.scalar(
        select(Lesson)
        .join(seed.CourseOffering)
        .join(seed.Discipline)
        .where(
            seed.Discipline.name == "Общая и неорганическая химия",
            Lesson.starts_at == datetime(2026, 11, 19, 9, 0, tzinfo=seed.MOSCOW),
        )
    )
    assert chemistry_cancellation is not None and chemistry_cancellation.status == "cancelled"
    divination_lessons = db_session.scalars(
        select(Lesson)
        .join(seed.CourseOffering)
        .join(seed.Discipline)
        .where(seed.Discipline.name == "Практикум по гадательным системам")
        .order_by(Lesson.starts_at)
    ).all()
    divination_events = {
        lesson.starts_at.date(): lesson
        for lesson in divination_lessons
        if lesson.starts_at.date() in {seed.date(2026, 11, 19), seed.date(2026, 11, 21)}
    }
    assert divination_events[seed.date(2026, 11, 19)].status == "moved"
    assert divination_events[seed.date(2026, 11, 21)].status == "scheduled"

    def override_db_session():
        session = Session(bind=db_session.connection(), join_transaction_mode="create_savepoint")
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db_session] = override_db_session
    try:
        with TestClient(app) as client:
            origin = {"Origin": "http://localhost:5173"}
            login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": "demo-pz101", "password": os.environ["DEMO_STUDENT_A_PASSWORD"]},
            )
            assert login.status_code == 200
            token = login.json()["access_token"]
            headers = {"Authorization": f"Bearer {token}"}
            news_page = client.get("/api/v1/news", headers=headers)
            assert news_page.status_code == 200
            visible_news = next(
                item for item in news_page.json()["items"] if item["id"] == str(schedule_news.id)
            )
            assert (
                "проверка защитных контуров из-за нестабильного магического фона"
                in (visible_news["excerpt"])
            )
            news_detail = client.get(f"/api/v1/news/{schedule_news.id}", headers=headers)
            assert news_detail.status_code == 200
            assert "23 ноября 2026 года" in news_detail.json()["body"]
            pm_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": "demo-pm201", "password": os.environ["DEMO_STUDENT_B_PASSWORD"]},
            )
            assert pm_login.status_code == 200
            pm_token = pm_login.json()["access_token"]
            created = client.post(
                "/api/v1/applications",
                headers=headers,
                json={
                    "service_code": "study_certificate",
                    "form_data": {"place_of_submission": "деканат"},
                },
            )
            assert created.status_code == 201
            application_id = int(created.json()["id"])
            schedule_news.body = seed.PREVIOUS_INTRO_NEWS_BODY
            db_session.flush()
            pm_user.is_active = False
            db_session.flush()
            seed.seed_demo_data()
            refreshed_news = client.get(f"/api/v1/news/{schedule_news.id}", headers=headers)
            assert refreshed_news.status_code == 200
            assert (
                "проверка защитных контуров из-за нестабильного магического фона"
                in (refreshed_news.json()["body"])
            )
            assert "23 ноября 2026 года" in refreshed_news.json()["body"]
            assert pm_user.is_active is False
            inactive_access = client.get(
                "/api/v1/users/me", headers={"Authorization": f"Bearer {pm_token}"}
            )
            assert inactive_access.status_code == 401
            inactive_refresh = client.post("/api/v1/auth/refresh", headers=origin)
            assert inactive_refresh.status_code == 401
    finally:
        app.dependency_overrides.pop(get_db_session, None)
    application = db_session.get(Application, application_id)
    assert application is not None
    db_session.refresh(schedule_news)
    assert "проверка защитных контуров из-за нестабильного магического фона" in (schedule_news.body)
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
    read_notification = db_session.scalar(
        select(Notification).where(Notification.user_id == pz_user.id)
    )
    assert read_notification is not None
    read_at = datetime.now(UTC)
    read_notification.read_at = read_at
    db_session.flush()

    original_pz_id, original_student_id = pz_user.id, pz.id
    old_hash = pz_user.password_hash
    pz_user.full_name = "Артём Сергеевич Лавров"
    db_session.flush()
    seed.seed_demo_data()
    after = {
        "lessons": db_session.scalar(select(func.count()).select_from(Lesson)),
        "news": db_session.scalar(select(func.count()).select_from(News)),
        "notifications": db_session.scalar(select(func.count()).select_from(Notification)),
        "course_groups": db_session.scalar(select(func.count()).select_from(CourseGroup)),
        "results": db_session.scalar(select(func.count()).select_from(AssessmentResult)),
    }
    db_session.refresh(application)
    db_session.refresh(pz_user)
    assert (pz_user.id, pz.id) == (original_pz_id, original_student_id)
    assert pz_user.full_name == "Иван Сергеевич Гончаров"
    assert pz_user.password_hash == old_hash
    db_session.refresh(read_notification)
    assert read_notification.read_at == read_at
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

    # A deliberate password mismatch must abort without rotating hashes or changing
    # data written by the first student's HTTP request.
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", token_urlsafe(24))
    with pytest.raises(RuntimeError, match="does not match existing account"):
        seed.seed_demo_data()
    db_session.refresh(pz_user)
    db_session.refresh(application)
    assert pz_user.password_hash == old_hash
    assert application.id == application_id
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", student_a_password)
    trusted_group_id = pz.group_id
    pz_user.full_name = "Артём Сергеевич Лавров"
    pz.group_id = pm.group_id
    db_session.flush()
    with pytest.raises(RuntimeError, match="Cannot verify demonstration account ownership"):
        seed.seed_demo_data()
    db_session.refresh(pz_user)
    db_session.refresh(pz)
    assert pz_user.full_name == "Артём Сергеевич Лавров"
    assert pz.group_id == pm.group_id
    pz_user.full_name = "Иван Сергеевич Гончаров"
    pz.group_id = trusted_group_id
    db_session.flush()
    seed.validate_active_schedule(db_session)
    candidate = db_session.scalar(select(Lesson).where(Lesson.status == "scheduled"))
    assert candidate is not None
    candidate_group = db_session.scalar(
        select(LessonGroup.group_id).where(LessonGroup.lesson_id == candidate.id)
    )
    candidate_room = db_session.scalar(
        select(LessonRoom.room_id).where(LessonRoom.lesson_id == candidate.id)
    )
    assert candidate_group is not None and candidate_room is not None
    another_teacher = db_session.scalar(
        select(seed.Teacher.id).where(seed.Teacher.id != candidate.teacher_id)
    )
    another_room = db_session.scalar(select(seed.Room.id).where(seed.Room.id != candidate_room))
    assert another_teacher is not None and another_room is not None

    def assert_overlap_rejected(teacher_id, room_id=None, group_id=None):
        overlapping = Lesson(
            course_offering_id=candidate.course_offering_id,
            teacher_id=teacher_id,
            starts_at=candidate.starts_at + timedelta(minutes=60),
            ends_at=candidate.starts_at + timedelta(minutes=150),
            kind=candidate.kind,
            status="scheduled",
            previous_lesson_id=None,
            is_additional=False,
            created_by_user_id=None,
        )
        with (
            pytest.raises(RuntimeError, match="overlapping active lesson"),
            db_session.begin_nested(),
        ):
            db_session.add(overlapping)
            db_session.flush()
            if group_id is not None:
                db_session.add(LessonGroup(lesson_id=overlapping.id, group_id=group_id))
            if room_id is not None:
                db_session.add(LessonRoom(lesson_id=overlapping.id, room_id=room_id))
            db_session.flush()
            seed.validate_active_schedule(db_session)

    # Isolate each dimension so removing any single conflict check fails this test.
    assert_overlap_rejected(another_teacher, room_id=candidate_room)
    assert_overlap_rejected(candidate.teacher_id, room_id=another_room)
    assert_overlap_rejected(another_teacher, group_id=candidate_group)
    for group in (pz, pm):
        offered = {
            discipline.name
            for discipline in db_session.scalars(
                select(seed.Discipline)
                .join(seed.CourseOffering)
                .join(seed.CourseGroup)
                .where(seed.CourseGroup.group_id == group.group_id)
            ).all()
        }
        scheduled = {
            item.name
            for item in db_session.scalars(
                select(seed.Discipline)
                .join(seed.CourseOffering)
                .join(seed.Lesson)
                .join(seed.LessonGroup)
                .where(seed.LessonGroup.group_id == group.group_id)
            ).all()
        }
        assert offered <= scheduled
    assert (
        db_session.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == pm.user_id)
        )
        == 2
    )

    # If the seed-owned row was removed and a foreign row reuses its title, fail
    # transactionally instead of treating the title as ownership proof.
    owned_news = db_session.scalar(select(News).where(News.title == seed.DEMO_NEWS[0][0]))
    assert owned_news is not None
    collision_title, _, collision_date = seed.DEMO_NEWS[0]
    db_session.delete(owned_news)
    db_session.flush()
    foreign_news = News(
        title=collision_title,
        body="Посторонняя запись с совпавшим заголовком",
        author_user_id=None,
        published_at=collision_date,
        is_published=True,
    )
    db_session.add(foreign_news)
    db_session.flush()
    with pytest.raises(RuntimeError, match="not owned by the demonstration seed"):
        seed.seed_demo_data()
    db_session.refresh(foreign_news)
    assert foreign_news.body == "Посторонняя запись с совпавшим заголовком"


def test_demo_seed_rejects_modified_lesson_relations_without_repairing_them(
    db_session, monkeypatch
):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    configure_seed_target(monkeypatch, url)
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

    lesson = db_session.scalar(
        select(Lesson)
        .join(seed.CourseOffering)
        .join(seed.Discipline)
        .where(
            seed.Discipline.name == "Иностранный язык",
            Lesson.starts_at == datetime(2026, 11, 16, 11, tzinfo=seed.MOSCOW),
        )
    )
    assert lesson is not None
    expected_room = db_session.scalar(
        select(LessonRoom.room_id).where(LessonRoom.lesson_id == lesson.id)
    )
    expected_group = db_session.scalar(
        select(LessonGroup.group_id).where(LessonGroup.lesson_id == lesson.id)
    )
    extra_room = db_session.scalar(select(seed.Room.id).where(seed.Room.id != expected_room))
    extra_group = db_session.scalar(
        select(seed.StudyGroup.id).where(seed.StudyGroup.id != expected_group)
    )
    assert expected_room is not None and expected_group is not None
    assert extra_room is not None and extra_group is not None
    lesson_id = lesson.id

    scenarios = (
        ("extra room", lambda: db_session.add(LessonRoom(lesson_id=lesson_id, room_id=extra_room))),
        (
            "missing room",
            lambda: db_session.delete(db_session.get(LessonRoom, (lesson_id, expected_room))),
        ),
        (
            "replacement room",
            lambda: (
                db_session.delete(db_session.get(LessonRoom, (lesson_id, expected_room))),
                db_session.add(LessonRoom(lesson_id=lesson_id, room_id=extra_room)),
            ),
        ),
        (
            "extra group",
            lambda: db_session.add(LessonGroup(lesson_id=lesson_id, group_id=extra_group)),
        ),
        (
            "missing group",
            lambda: db_session.delete(
                db_session.scalar(select(LessonGroup).where(LessonGroup.lesson_id == lesson_id))
            ),
        ),
    )
    for description, mutate in scenarios:
        mutate()
        db_session.flush()
        damaged = {
            table: tuple(tuple(row) for row in db_session.execute(text(f'SELECT * FROM "{table}"')))
            for table in ("lessons", "lesson_groups", "lesson_rooms")
        }
        with pytest.raises(RuntimeError, match="unexpected lesson_"):
            seed.seed_demo_data()
        after = {
            table: tuple(tuple(row) for row in db_session.execute(text(f'SELECT * FROM "{table}"')))
            for table in ("lessons", "lesson_groups", "lesson_rooms")
        }
        assert after == damaged, description
        # Restore only the test's deliberate mutation before checking the next case.
        for row in db_session.scalars(
            select(LessonRoom).where(LessonRoom.lesson_id == lesson_id)
        ).all():
            db_session.delete(row)
        for row in db_session.scalars(
            select(LessonGroup).where(LessonGroup.lesson_id == lesson_id)
        ).all():
            db_session.delete(row)
        db_session.flush()
        db_session.add(LessonRoom(lesson_id=lesson_id, room_id=expected_room))
        db_session.add(LessonGroup(lesson_id=lesson_id, group_id=expected_group))
        db_session.flush()

    # Seed-generated move nodes must use trusted template relations, and a
    # corrupted source/intermediate/final node must not propagate down-chain.
    moved_nodes = (
        ("Введение в зельеварение", datetime(2026, 11, 19, 13, tzinfo=seed.MOSCOW)),
        ("Введение в зельеварение", datetime(2026, 11, 20, 15, tzinfo=seed.MOSCOW)),
        ("Введение в зельеварение", datetime(2026, 11, 23, 15, tzinfo=seed.MOSCOW)),
        ("Практикум по гадательным системам", datetime(2026, 11, 21, 11, tzinfo=seed.MOSCOW)),
    )
    for discipline_name, starts_at in moved_nodes:
        moved = db_session.scalar(
            select(Lesson)
            .join(seed.CourseOffering)
            .join(seed.Discipline)
            .where(seed.Discipline.name == discipline_name, Lesson.starts_at == starts_at)
        )
        assert moved is not None
        moved_id = moved.id
        original_room = db_session.scalar(
            select(LessonRoom.room_id).where(LessonRoom.lesson_id == moved_id)
        )
        assert original_room is not None
        replacement_room = db_session.scalar(
            select(seed.Room.id).where(seed.Room.id != original_room)
        )
        assert replacement_room is not None
        db_session.delete(db_session.get(LessonRoom, (moved_id, original_room)))
        db_session.add(LessonRoom(lesson_id=moved_id, room_id=replacement_room))
        db_session.flush()
        before_chain_failure = tuple(
            tuple(row) for row in db_session.execute(text('SELECT * FROM "lessons"'))
        )
        with pytest.raises(RuntimeError, match="unexpected lesson_rooms"):
            seed.seed_demo_data()
        assert (
            tuple(tuple(row) for row in db_session.execute(text('SELECT * FROM "lessons"')))
            == before_chain_failure
        )
        assert set(
            db_session.scalars(select(LessonRoom.room_id).where(LessonRoom.lesson_id == moved_id))
        ) == {replacement_room}
        db_session.delete(db_session.get(LessonRoom, (moved_id, replacement_room)))
        db_session.add(LessonRoom(lesson_id=moved_id, room_id=original_room))
        db_session.flush()


def test_demo_seed_refuses_unconfirmed_database(monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    configure_seed_target(monkeypatch, url)
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_STUDENT_B_PASSWORD", token_urlsafe(24))
    monkeypatch.delenv("DEMO_SEED_CONFIRM", raising=False)
    with pytest.raises(RuntimeError, match="Explicit confirmation"):
        seed.require_safe_target()


def test_demo_seed_refuses_incomplete_allowed_target(monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    configure_seed_target(monkeypatch, url)
    monkeypatch.delenv("DEMO_SEED_ALLOWED_ROLE", raising=False)
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_STUDENT_B_PASSWORD", token_urlsafe(24))
    with pytest.raises(RuntimeError, match=r"DEMO_SEED_ALLOWED_\* values"):
        seed.require_safe_target()


@pytest.mark.parametrize(
    ("target_field", "wrong_value"),
    (
        ("DEMO_SEED_ALLOWED_DATABASE", "another_demo_db"),
        ("DEMO_SEED_ALLOWED_HOST", "another-db"),
        ("DEMO_SEED_ALLOWED_PORT", "55433"),
        ("DEMO_SEED_ALLOWED_ROLE", "uni_space_api"),
    ),
)
def test_demo_seed_requires_confirmation_of_full_target(monkeypatch, target_field, wrong_value):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    configure_seed_target(monkeypatch, url)
    monkeypatch.setenv(target_field, wrong_value)
    with pytest.raises(RuntimeError, match=r"DEMO_SEED_ALLOWED_\* values"):
        seed.require_safe_target()


def test_production_seed_requires_fixed_target_and_interactive_confirmation(monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    actual_target = (url.host, url.port or 5432, url.database, url.username)
    monkeypatch.setattr(seed, "PRODUCTION_DEMO_TARGET", actual_target)
    monkeypatch.setenv("DEMO_SEED_ALLOW_PRODUCTION", "YES_I_HAVE_A_BACKUP")
    monkeypatch.setenv("DEMO_STUDENT_A_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_STUDENT_B_PASSWORD", token_urlsafe(24))
    monkeypatch.setattr("builtins.input", lambda _prompt: "")
    with pytest.raises(RuntimeError, match="Explicit confirmation"):
        seed.require_safe_target()


@pytest.mark.parametrize(
    "target_field",
    ("host", "port", "database", "role"),
)
def test_production_seed_rejects_every_target_mismatch(monkeypatch, target_field):
    seed = load_seed_module()
    host, port, database, role = seed.PRODUCTION_DEMO_TARGET
    target = {"host": host, "port": port, "database": database, "role": role}
    target[target_field] = {
        "host": "wrong-db",
        "port": 55432,
        "database": "wrong_database",
        "role": "uni_space_api",
    }[target_field]
    production_url = (
        f"postgresql+psycopg://{target['role']}@{target['host']}:{target['port']}"
        f"/{target['database']}"
    )
    monkeypatch.setattr(
        seed,
        "get_settings",
        lambda: SimpleNamespace(
            app_env="test",
            database_url=SimpleNamespace(get_secret_value=lambda: production_url),
        ),
    )
    monkeypatch.setenv("DEMO_SEED_ALLOW_PRODUCTION", "YES_I_HAVE_A_BACKUP")
    with pytest.raises(RuntimeError, match="pinned demonstration deployment"):
        seed.require_safe_target()


def test_production_environment_without_production_approval_is_refused(monkeypatch):
    seed = load_seed_module()
    host, port, database, role = seed.PRODUCTION_DEMO_TARGET
    production_url = f"postgresql+psycopg://{role}@{host}:{port}/{database}"
    monkeypatch.setattr(
        seed,
        "get_settings",
        lambda: SimpleNamespace(
            app_env="production",
            database_url=SimpleNamespace(get_secret_value=lambda: production_url),
        ),
    )
    monkeypatch.delenv("DEMO_SEED_ALLOW_PRODUCTION", raising=False)
    with pytest.raises(RuntimeError, match="requires DEMO_SEED_ALLOW_PRODUCTION"):
        seed.require_safe_target()


def test_demo_seed_cli_migrates_clean_database_and_preserves_records(postgresql_engine):
    """Run the documented executable against an isolated, freshly migrated PostgreSQL DB."""
    seed = load_seed_module()
    database_name = f"demo_seed_{uuid4().hex[:16]}"
    with postgresql_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as admin:
        admin.execute(text(f'CREATE DATABASE "{database_name}"'))
    database_url = postgresql_engine.url.set(database=database_name)
    app_database = create_engine(database_url)
    backend_directory = Path(__file__).resolve().parents[1]
    seed_path = backend_directory / "scripts" / "seed_demo_data.py"
    password_a = token_urlsafe(24)
    password_b = token_urlsafe(24)
    database_host = database_url.host or "localhost"
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "test",
            "DATABASE_URL": database_url.render_as_string(hide_password=False),
            "DEMO_SEED_ALLOWED_DATABASE": database_name,
            "DEMO_SEED_ALLOWED_HOST": database_host,
            "DEMO_SEED_ALLOWED_PORT": str(database_url.port or 5432),
            "DEMO_SEED_ALLOWED_ROLE": database_url.username,
            "DEMO_SEED_CONFIRM": load_seed_module().expected_confirmation(
                (database_host, database_url.port or 5432, database_name, database_url.username)
            ),
            "DEMO_STUDENT_A_PASSWORD": password_a,
            "DEMO_STUDENT_B_PASSWORD": password_b,
        }
    )

    def run(*arguments: str, **overrides: str):
        process_environment = environment | overrides
        return subprocess.run(
            [sys.executable, *arguments],
            cwd=backend_directory,
            env=process_environment,
            text=True,
            capture_output=True,
            check=False,
        )

    try:
        migration = run("-m", "alembic", "upgrade", "head")
        assert migration.returncode == 0, migration.stderr
        first = run(str(seed_path))
        assert first.returncode == 0, first.stderr
        assert password_a not in first.stdout + first.stderr
        assert password_b not in first.stdout + first.stderr
        with Session(app_database, expire_on_commit=False) as db:
            pz = db.scalar(select(Student).join(User).where(User.login == "demo-pz101"))
            pm = db.scalar(select(Student).join(User).where(User.login == "demo-pm201"))
            assert pz is not None and pm is not None
            pz_id, pm_id, pz_student_id, pm_student_id = pz.user_id, pm.user_id, pz.id, pm.id
            pz_hash = db.get(User, pz_id).password_hash
            assert db.get(User, pz_id).full_name == "Иван Сергеевич Гончаров"
            application = Application(
                student_id=pz.id,
                service_type_id=db.scalar(
                    select(seed.ServiceType.id).where(seed.ServiceType.code == "study_certificate")
                ),
                review_status="submitted",
                document_status="pending",
                form_data={"place_of_submission": "приёмная комиссия"},
            )
            db.add(application)
            db.commit()
            application_id = application.id
            before_counts = {
                table: db.scalar(text(f"SELECT count(*) FROM {table}"))
                for table in ("lessons", "news", "notifications", "course_groups")
            }
        second = run(str(seed_path))
        assert second.returncode == 0, second.stderr
        wrong_password = run(str(seed_path), DEMO_STUDENT_A_PASSWORD=token_urlsafe(24))
        assert wrong_password.returncode != 0
        wrong_target = run(str(seed_path), DEMO_SEED_ALLOWED_DATABASE="wrong_database")
        assert wrong_target.returncode != 0
        wrong_database_name = f"demo_seed_wrong_{uuid4().hex[:12]}"
        with postgresql_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as admin:
            admin.execute(text(f'CREATE DATABASE "{wrong_database_name}"'))
        wrong_database_url = database_url.set(database=wrong_database_name)
        wrong_database_engine = create_engine(wrong_database_url)
        try:
            wrong_migration_environment = environment | {
                "DATABASE_URL": wrong_database_url.render_as_string(hide_password=False),
                "DEMO_SEED_ALLOWED_DATABASE": wrong_database_name,
                "DEMO_SEED_ALLOWED_HOST": wrong_database_url.host,
                "DEMO_SEED_ALLOWED_PORT": str(wrong_database_url.port or 5432),
                "DEMO_SEED_ALLOWED_ROLE": wrong_database_url.username,
            }
            wrong_migration = subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", "head"],
                cwd=backend_directory,
                env=wrong_migration_environment,
                text=True,
                capture_output=True,
                check=False,
            )
            assert wrong_migration.returncode == 0, wrong_migration.stderr
            wrong_tables = tuple(inspect(wrong_database_engine).get_table_names())

            def snapshot_wrong_database():
                with wrong_database_engine.connect() as wrong_connection:
                    return {
                        table: tuple(
                            tuple(row)
                            for row in wrong_connection.execute(text(f'SELECT * FROM "{table}"'))
                        )
                        for table in wrong_tables
                    }

            wrong_before = snapshot_wrong_database()
            refused_wrong_target = subprocess.run(
                [sys.executable, str(seed_path)],
                cwd=backend_directory,
                env=wrong_migration_environment,
                text=True,
                capture_output=True,
                check=False,
            )
            assert refused_wrong_target.returncode != 0
            assert "Demo seed database target" in refused_wrong_target.stdout
            assert snapshot_wrong_database() == wrong_before
        finally:
            wrong_database_engine.dispose()
            with postgresql_engine.connect().execution_options(
                isolation_level="AUTOCOMMIT"
            ) as admin:
                admin.execute(
                    text(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                        "WHERE datname = :database_name"
                    ),
                    {"database_name": wrong_database_name},
                )
                admin.execute(text(f'DROP DATABASE IF EXISTS "{wrong_database_name}"'))
        with Session(app_database) as db:
            assert db.get(User, pz_id).password_hash == pz_hash
            assert db.get(Student, pz_student_id).user_id == pz_id
            assert db.get(Student, pm_student_id).user_id == pm_id
            assert db.get(Application, application_id).review_status == "submitted"
            assert {
                table: db.scalar(text(f"SELECT count(*) FROM {table}")) for table in before_counts
            } == before_counts

            pz_group_id = db.scalar(select(Student.group_id).where(Student.id == pz_student_id))
            target_lesson = db.scalar(
                select(seed.Lesson)
                .join(seed.LessonGroup)
                .join(seed.CourseOffering)
                .join(seed.Discipline)
                .where(
                    seed.LessonGroup.group_id == pz_group_id,
                    seed.Discipline.name == "Иностранный язык",
                    seed.Lesson.starts_at == datetime(2026, 11, 16, 11, 0, tzinfo=seed.MOSCOW),
                )
            )
            expected_room_id = db.scalar(
                select(seed.Room.id)
                .join(seed.Building)
                .where(
                    seed.Room.name == "215", seed.Building.name == "Главный учебный корпус (ГУК)"
                )
            )
            unexpected_room_id = db.scalar(
                select(seed.Room.id)
                .join(seed.Building)
                .where(
                    seed.Room.name == "304", seed.Building.name == "Главный учебный корпус (ГУК)"
                )
            )
            assert target_lesson is not None
            target_lesson_id = target_lesson.id
            assert expected_room_id is not None and unexpected_room_id is not None
            assert db.get(seed.LessonRoom, (target_lesson.id, expected_room_id)) is not None
            assert db.get(seed.LessonRoom, (target_lesson.id, unexpected_room_id)) is None
            db.delete(db.get(seed.LessonRoom, (target_lesson.id, expected_room_id)))
            db.add(seed.LessonRoom(lesson_id=target_lesson.id, room_id=unexpected_room_id))
            db.commit()

        def snapshot_database():
            with app_database.connect() as connection:
                return {
                    table: tuple(
                        tuple(row) for row in connection.execute(text(f'SELECT * FROM "{table}"'))
                    )
                    for table in inspect(app_database).get_table_names()
                }

        damaged_relations = snapshot_database()
        rejected_modified_relation = run(str(seed_path))
        assert rejected_modified_relation.returncode != 0
        assert snapshot_database() == damaged_relations
        with Session(app_database) as db:
            actual_rooms = set(
                db.scalars(
                    select(seed.LessonRoom.room_id).where(
                        seed.LessonRoom.lesson_id == target_lesson_id
                    )
                )
            )
            assert actual_rooms == {unexpected_room_id}
    finally:
        app_database.dispose()
        with postgresql_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as admin:
            admin.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :database_name"
                ),
                {"database_name": database_name},
            )
            admin.execute(text(f'DROP DATABASE IF EXISTS "{database_name}"'))
