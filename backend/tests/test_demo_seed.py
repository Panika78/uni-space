"""The explicit demonstration seed is isolated from ordinary test fixtures and applications."""

import importlib.util
import os
import subprocess
import sys
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from secrets import token_urlsafe
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
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


def test_demo_seed_is_repeatable_and_preserves_user_application(db_session, monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    monkeypatch.setenv("DEMO_SEED_ALLOWED_DATABASE", url.database)
    monkeypatch.setenv("DEMO_SEED_ALLOWED_HOST", url.host)
    monkeypatch.setenv("DEMO_SEED_CONFIRM", f"SEED_UNI_SPACE_DEMO_DATA:{url.database}@{url.host}")
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
            pm_user.is_active = False
            db_session.flush()
            seed.seed_demo_data()
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


def test_demo_seed_refuses_unconfirmed_database(monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    monkeypatch.setenv("DEMO_SEED_ALLOWED_DATABASE", url.database)
    monkeypatch.setenv("DEMO_SEED_ALLOWED_HOST", url.host)
    monkeypatch.delenv("DEMO_SEED_CONFIRM", raising=False)
    with pytest.raises(RuntimeError, match="Explicit DEMO_SEED_CONFIRM"):
        seed.require_safe_target()


def test_demo_seed_cli_migrates_clean_database_and_preserves_records(postgresql_engine):
    """Run the documented executable against an isolated, freshly migrated PostgreSQL DB."""
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
            "DEMO_SEED_CONFIRM": f"SEED_UNI_SPACE_DEMO_DATA:{database_name}@{database_host}",
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
                    select(load_seed_module().ServiceType.id).where(
                        load_seed_module().ServiceType.code == "study_certificate"
                    )
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
        with Session(app_database) as db:
            assert db.get(User, pz_id).password_hash == pz_hash
            assert db.get(Student, pz_student_id).user_id == pz_id
            assert db.get(Student, pm_student_id).user_id == pm_id
            assert db.get(Application, application_id).review_status == "submitted"
            assert {
                table: db.scalar(text(f"SELECT count(*) FROM {table}")) for table in before_counts
            } == before_counts
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
