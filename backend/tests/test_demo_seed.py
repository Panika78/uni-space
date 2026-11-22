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
    AuditEvent,
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
    for variable in (
        "DEMO_STUDENT_A_PASSWORD",
        "DEMO_STUDENT_B_PASSWORD",
        "DEMO_TEACHER_PASSWORD",
        "DEMO_DEAN_STAFF_PASSWORD",
        "DEMO_ACCOUNTING_STAFF_PASSWORD",
    ):
        monkeypatch.setenv(variable, token_urlsafe(24))


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
    assert "не раскрывает конкретные" in content
    assert "21 и 23 ноября" in content
    assert "события 19, 20" in content
    assert "После 31 января 2027 года" in content
    assert "временной PostgreSQL-БД" in content


def test_demo_seed_updates_seed_owned_mvp1_data_without_removing_history(db_session, monkeypatch):
    seed = load_seed_module()
    url = make_url(get_settings().database_url.get_secret_value())
    configure_seed_target(monkeypatch, url)
    passwords = {
        "DEMO_STUDENT_A_PASSWORD": token_urlsafe(24),
        "DEMO_STUDENT_B_PASSWORD": token_urlsafe(24),
    }
    for name, password in passwords.items():
        monkeypatch.setenv(name, password)

    faculty = seed.OrgUnit(name="Факультет естественных наук", type="faculty")
    db_session.add(faculty)
    db_session.flush()
    sciences = seed.OrgUnit(
        name="Кафедра естественных наук", type="department", parent_id=faculty.id
    )
    applied = seed.OrgUnit(
        name="Кафедра прикладных дисциплин", type="department", parent_id=faculty.id
    )
    db_session.add_all([sciences, applied])
    programs = {
        "pz": seed.Program(
            code="ПЗ",
            name="Прикладное зельеварение",
            direction_code="04.03.01",
            direction_name="Химия",
            faculty_id=faculty.id,
        ),
        "pm": seed.Program(
            code="ПМ",
            name="Прикладная мантика и прогностика",
            direction_code="01.03.02",
            direction_name="Прикладная математика и информатика",
            faculty_id=faculty.id,
        ),
    }
    db_session.add_all(programs.values())
    db_session.flush()
    groups = {
        "pz": seed.StudyGroup(name="ПЗ-101", program_id=programs["pz"].id, course_number=1),
        "pm": seed.StudyGroup(name="ПМ-201", program_id=programs["pm"].id, course_number=2),
    }
    db_session.add_all(groups.values())
    db_session.flush()
    users = {}
    students = {}
    for key, login, name, password_name in (
        ("pz", "demo-pz101", "Иван Сергеевич Гончаров", "DEMO_STUDENT_A_PASSWORD"),
        ("pm", "demo-pm201", "Амели Викторовна Волкова", "DEMO_STUDENT_B_PASSWORD"),
    ):
        user = User(
            login=login,
            password_hash=seed.PASSWORD_HASHER.hash(passwords[password_name]),
            full_name=name,
            role="student",
            is_active=True,
        )
        db_session.add(user)
        db_session.flush()
        student = Student(
            user_id=user.id,
            group_id=groups[key].id,
            academic_status="enrolled",
        )
        db_session.add(student)
        users[key] = user
        students[key] = student
    term = seed.AcademicTerm(
        name="Осенний семестр 2026/2027", starts_on=seed.TERM_START, ends_on=seed.TERM_END
    )
    teacher = seed.Teacher(full_name="Виктор Сергеевич Громов", department_id=sciences.id)
    chemistry_teacher = seed.Teacher(
        full_name="Валентина Семёновна Котова", department_id=sciences.id
    )
    intro_teacher = seed.Teacher(full_name="Елена Борисовна Рябинина", department_id=applied.id)
    db_session.add_all([term, teacher, chemistry_teacher, intro_teacher])
    db_session.flush()

    def add_legacy_offering(name, group_key):
        discipline = seed.Discipline(name=name, code=None)
        db_session.add(discipline)
        db_session.flush()
        offering = seed.CourseOffering(
            discipline_id=discipline.id, term_id=term.id, attestation_type="exam"
        )
        db_session.add(offering)
        db_session.flush()
        db_session.add(
            seed.CourseGroup(course_offering_id=offering.id, group_id=groups[group_key].id)
        )
        return offering

    math_offering = add_legacy_offering("Математический анализ", "pz")
    intro_offering = add_legacy_offering("Введение в зельеварение", "pz")
    chemistry_offering = add_legacy_offering("Общая и неорганическая химия", "pz")
    stale_offering = add_legacy_offering("Основы российской государственности", "pz")
    buildings = {
        "ГУК": seed.Building(
            name="Главный учебный корпус (ГУК)", address="Университетский проспект, 1"
        ),
        "УЛК": seed.Building(
            name="Учебно-лабораторный корпус (УЛК)", address="Университетский проспект, 3"
        ),
    }
    db_session.add_all(buildings.values())
    db_session.flush()
    rooms = {
        ("ГУК", "304"): seed.Room(building_id=buildings["ГУК"].id, name="304"),
        ("УЛК", "106"): seed.Room(building_id=buildings["УЛК"].id, name="106"),
        ("УЛК", "Лаборатория № 3"): seed.Room(
            building_id=buildings["УЛК"].id, name="Лаборатория № 3"
        ),
    }
    db_session.add_all(rooms.values())
    db_session.flush()

    ordinary = seed.Lesson(
        course_offering_id=math_offering.id,
        teacher_id=intro_teacher.id,
        starts_at=datetime(2026, 9, 1, 8, tzinfo=seed.MOSCOW),
        ends_at=datetime(2026, 9, 1, 9, 30, tzinfo=seed.MOSCOW),
        kind="lecture",
        status="scheduled",
        previous_lesson_id=None,
        is_additional=False,
        created_by_user_id=None,
    )
    stale = seed.Lesson(
        course_offering_id=stale_offering.id,
        teacher_id=intro_teacher.id,
        starts_at=datetime(2026, 9, 1, 10, tzinfo=seed.MOSCOW),
        ends_at=datetime(2026, 9, 1, 11, 30, tzinfo=seed.MOSCOW),
        kind="lecture",
        status="scheduled",
        previous_lesson_id=None,
        is_additional=False,
        created_by_user_id=None,
    )
    db_session.add_all([ordinary, stale])
    db_session.flush()
    db_session.add_all(
        [
            seed.LessonGroup(lesson_id=ordinary.id, group_id=groups["pz"].id),
            seed.LessonRoom(lesson_id=ordinary.id, room_id=rooms[("ГУК", "304")].id),
            seed.LessonGroup(lesson_id=stale.id, group_id=groups["pz"].id),
            seed.LessonRoom(lesson_id=stale.id, room_id=rooms[("ГУК", "304")].id),
        ]
    )
    root = seed.Lesson(
        course_offering_id=intro_offering.id,
        teacher_id=intro_teacher.id,
        starts_at=datetime(2026, 11, 19, 13, tzinfo=seed.MOSCOW),
        ends_at=datetime(2026, 11, 19, 14, 30, tzinfo=seed.MOSCOW),
        kind="lab",
        status="moved",
        previous_lesson_id=None,
        is_additional=False,
        created_by_user_id=None,
    )
    db_session.add(root)
    db_session.flush()
    middle = seed.Lesson(
        course_offering_id=intro_offering.id,
        teacher_id=intro_teacher.id,
        starts_at=datetime(2026, 11, 20, 15, tzinfo=seed.MOSCOW),
        ends_at=datetime(2026, 11, 20, 16, 30, tzinfo=seed.MOSCOW),
        kind="lab",
        status="moved",
        previous_lesson_id=root.id,
        is_additional=False,
        created_by_user_id=None,
    )
    db_session.add(middle)
    db_session.flush()
    final = seed.Lesson(
        course_offering_id=intro_offering.id,
        teacher_id=intro_teacher.id,
        starts_at=datetime(2026, 11, 23, 15, tzinfo=seed.MOSCOW),
        ends_at=datetime(2026, 11, 23, 16, 30, tzinfo=seed.MOSCOW),
        kind="lab",
        status="scheduled",
        previous_lesson_id=middle.id,
        is_additional=False,
        created_by_user_id=None,
    )
    chemistry_cancelled = seed.Lesson(
        course_offering_id=chemistry_offering.id,
        teacher_id=chemistry_teacher.id,
        starts_at=datetime(2026, 11, 19, 9, tzinfo=seed.MOSCOW),
        ends_at=datetime(2026, 11, 19, 10, 30, tzinfo=seed.MOSCOW),
        kind="lab",
        status="cancelled",
        previous_lesson_id=None,
        is_additional=False,
        created_by_user_id=None,
    )
    db_session.add_all([final, chemistry_cancelled])
    db_session.flush()
    for lesson, room_key in (
        (root, ("УЛК", "Лаборатория № 3")),
        (middle, ("ГУК", "304")),
        (final, ("ГУК", "304")),
        (chemistry_cancelled, ("УЛК", "106")),
    ):
        db_session.add_all(
            [
                seed.LessonGroup(lesson_id=lesson.id, group_id=groups["pz"].id),
                seed.LessonRoom(lesson_id=lesson.id, room_id=rooms[room_key].id),
            ]
        )
    db_session.flush()
    original_student_ids = {key: value.id for key, value in students.items()}
    original_user_ids = {key: value.id for key, value in users.items()}
    original_history_ids = {root.id, middle.id, final.id, chemistry_cancelled.id}
    ordinary_id = ordinary.id
    stale_id = stale.id
    stale_offering_id = stale_offering.id

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
    db_session.expire_all()
    assert db_session.get(seed.Lesson, ordinary_id) is None
    assert db_session.get(seed.Lesson, stale_id) is None
    assert db_session.get(seed.CourseGroup, (stale_offering_id, groups["pz"].id)) is None
    assert {
        key: db_session.get(Student, value).id for key, value in original_student_ids.items()
    } == original_student_ids
    assert {
        key: db_session.get(User, value).id for key, value in original_user_ids.items()
    } == original_user_ids
    assert original_history_ids == {
        db_session.get(seed.Lesson, value).id for value in original_history_ids
    }
    assert db_session.get(seed.Lesson, root.id).status == "moved"
    assert db_session.get(seed.Lesson, middle.id).previous_lesson_id == root.id
    assert db_session.get(seed.Lesson, final.id).previous_lesson_id == middle.id
    assert db_session.get(seed.Lesson, chemistry_cancelled.id).status == "cancelled"


def test_demo_seed_is_repeatable_and_preserves_user_application(db_session, monkeypatch, tmp_path):
    from app.admin.bootstrap import bootstrap_admin
    from app.applications import router as applications_router
    from app.auth import router as auth_routes
    from app.auth.rate_limit import LoginRateLimiter
    from app.core.config import get_settings
    from app.documents import issuer

    # This scenario authenticates all seeded roles plus an admin-created teacher.
    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter(limit=20))
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
    settings = get_settings().model_copy(update={"attachment_storage_path": str(tmp_path)})
    monkeypatch.setattr(applications_router, "get_settings", lambda: settings)
    monkeypatch.setattr(applications_router, "SessionLocal", SessionFactory())
    monkeypatch.setattr(issuer, "get_settings", lambda: settings)
    monkeypatch.setattr(issuer, "SessionLocal", SessionFactory())

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
    math_control = db_session.scalar(
        select(AssessmentResult.score)
        .join(seed.AssessmentGroup)
        .join(seed.Assessment)
        .where(seed.Assessment.course_offering_id == int(math.course_offering_id))
        .where(seed.Assessment.title == "Контрольная работа")
        .where(AssessmentResult.student_id == pz.id)
    )
    assert math_control == 0
    assert math.total_score >= 0 and math.max_score >= 20 and math.graded_assessment_count > 1
    assert math.final_result.has_debt is False
    assert (history.total_score, history.max_score, history.graded_assessment_count) == (0, 10, 0)
    pm_academics = get_student_academics(db_session, pm)
    assert len(pz_academics.items) == 9 and len(pm_academics.items) == 9
    assert all(item.total_score > 0 for item in pm_academics.items if item.assessment_count)
    first_subgroup = db_session.scalar(
        select(seed.Subgroup).where(
            seed.Subgroup.group_id == pm.group_id, seed.Subgroup.name == "1-я подгруппа"
        )
    )
    second_subgroup = db_session.scalar(
        select(seed.Subgroup).where(
            seed.Subgroup.group_id == pm.group_id, seed.Subgroup.name == "2-я подгруппа"
        )
    )
    assert pz.subgroup_id is None
    assert first_subgroup is not None and second_subgroup is not None
    assert pm.subgroup_id == second_subgroup.id
    teachers = db_session.scalars(select(seed.Teacher)).all()
    assert len(teachers) == 10
    for teacher in teachers:
        assert (
            db_session.scalar(
                select(Lesson.id).where(
                    Lesson.teacher_id == teacher.id,
                    Lesson.status == "scheduled",
                    Lesson.starts_at >= datetime(2026, 9, 1, tzinfo=seed.MOSCOW),
                    Lesson.starts_at < datetime(2027, 2, 1, tzinfo=seed.MOSCOW),
                )
            )
            is not None
        )
        assert (
            db_session.scalar(
                select(seed.TeachingAssignment.id).where(
                    seed.TeachingAssignment.teacher_id == teacher.id
                )
            )
            is not None
        )
    pz_week_lessons = db_session.scalars(
        select(Lesson)
        .join(LessonGroup)
        .where(
            LessonGroup.group_id == pz.group_id,
            Lesson.starts_at >= datetime(2026, 9, 7, tzinfo=seed.MOSCOW),
            Lesson.starts_at < datetime(2026, 9, 12, tzinfo=seed.MOSCOW),
            Lesson.status == "scheduled",
        )
    ).all()
    assert len(pz_week_lessons) == 19
    pz_group = db_session.get(seed.StudyGroup, pz.group_id)
    pm_group = db_session.get(seed.StudyGroup, pm.group_id)
    pz_program = db_session.get(seed.Program, pz_group.program_id)
    pm_program = db_session.get(seed.Program, pm_group.program_id)
    assert (pz_program.direction_code, pz_program.direction_name) == (
        "MAG-01",
        "Алхимия и технологии зельеварения",
    )
    assert (pm_program.direction_code, pm_program.direction_name) == (
        "MAG-02",
        "Мантика и вероятностная магия",
    )
    absences = db_session.scalars(
        select(seed.Attendance).where(seed.Attendance.status == "absent")
    ).all()
    assert sum(row.student_id == pz.id for row in absences) == 3
    assert sum(row.student_id == pm.id for row in absences) == 1
    assert all(row.membership_version == 0 for row in absences)
    assert all(
        row.origin_group_id == (pz.group_id if row.student_id == pz.id else pm.group_id)
        and row.origin_subgroup_id
        == (pz.subgroup_id if row.student_id == pz.id else pm.subgroup_id)
        for row in absences
    )
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
        and (
            lesson.starts_at.astimezone(seed.MOSCOW).date() != seed.date(2026, 11, 23)
            or lesson.starts_at.astimezone(seed.MOSCOW).hour == 15
        )
    }
    root = intro_chain["2026-11-19"]
    middle = intro_chain["2026-11-20"]
    final = intro_chain["2026-11-23"]
    assert (root.status, middle.status, final.status) == ("moved", "moved", "scheduled")
    assert middle.previous_lesson_id == root.id
    assert final.previous_lesson_id == middle.id
    schedule_news = db_session.scalar(select(News).where(News.title == seed.DEMO_NEWS[0][0]))
    assert schedule_news is not None
    assert "нестабильностью магического фона" in schedule_news.body
    assert "20 ноября" not in schedule_news.body
    assert "23 ноября" not in schedule_news.body

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
    scheduled_seminars = db_session.scalars(
        select(Lesson).where(Lesson.kind == "seminar", Lesson.status == "scheduled")
    ).all()
    for lesson in scheduled_seminars:
        lesson_date = lesson.starts_at.astimezone(seed.MOSCOW).date()
        work = db_session.scalar(
            select(seed.AssessmentGroup)
            .join(seed.Assessment)
            .where(seed.AssessmentGroup.lesson_id == lesson.id)
            .where(seed.Assessment.type == "seminar", seed.Assessment.max_score == 2)
        )
        assert work is not None and work.planned_date == lesson_date
        if lesson_date > seed.date(2026, 11, 20):
            assert (
                db_session.scalar(
                    select(AssessmentResult.id).where(
                        AssessmentResult.assessment_group_id == work.id
                    )
                )
                is None
            )
    assert (
        db_session.scalar(
            select(seed.AssessmentGroup.id)
            .join(Lesson, Lesson.id == seed.AssessmentGroup.lesson_id)
            .where(Lesson.status == "cancelled")
        )
        is None
    )
    demo_units = {
        unit.name: unit.id
        for unit in db_session.scalars(select(seed.OrgUnit)).all()
        if unit.name in {"Деканат естественных наук", "Бухгалтерия"}
    }
    responsible_services = {
        service.code: service.responsible_org_unit_id
        for service in db_session.scalars(select(seed.ServiceType)).all()
    }
    assert all(
        responsible_services[code] == demo_units["Деканат естественных наук"]
        for code in ("study_certificate", "academic_transcript", "academic_leave")
    )
    assert responsible_services["accounting_certificate"] == demo_units["Бухгалтерия"]

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
            _admin_id, admin_password = bootstrap_admin(
                db_session, login="demo-smoke-admin", full_name="Operator Test"
            )
            admin_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": "demo-smoke-admin", "password": admin_password},
            )
            assert admin_login.status_code == 200
            admin_headers = {"Authorization": f"Bearer {admin_login.json()['access_token']}"}
            teacher_lookup = client.get(
                "/api/v1/admin/lookups?kind=teachers&limit=100", headers=admin_headers
            )
            viktor = next(
                item
                for item in teacher_lookup.json()["items"]
                if item["name"] == "Виктор Сергеевич Громов"
            )
            created_teacher = client.post(
                "/api/v1/admin/users",
                headers={**origin, **admin_headers},
                json={
                    "login": "demo-smoke-history-teacher",
                    "full_name": viktor["name"],
                    "role": "teacher",
                    "teacher_id": viktor["id"],
                },
            )
            assert created_teacher.status_code == 201
            created_teacher_data = created_teacher.json()
            linked_teacher_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={
                    "login": "demo-smoke-history-teacher",
                    "password": created_teacher_data["initial_password"],
                },
            )
            assert linked_teacher_login.status_code == 200
            linked_teacher_headers = {
                "Authorization": f"Bearer {linked_teacher_login.json()['access_token']}"
            }
            linked_assignments = client.get(
                "/api/v1/teaching/assignments?limit=100", headers=linked_teacher_headers
            )
            linked_schedule = client.get(
                "/api/v1/teaching/schedule?date_from=2026-09-07&date_to=2026-09-11",
                headers=linked_teacher_headers,
            )
            assert linked_assignments.status_code == linked_schedule.status_code == 200
            assert linked_assignments.json()["items"] and linked_schedule.json()["items"]

            # Every other seeded teacher must gain usable journals through the admin API.
            linked_teacher_ids = {
                int(viktor["id"]),
                *db_session.scalars(
                    select(seed.Teacher.id).where(seed.Teacher.user_id.is_not(None))
                ).all(),
            }
            for teacher_record in teacher_lookup.json()["items"]:
                teacher_id = int(teacher_record["id"])
                if teacher_id in linked_teacher_ids:
                    continue
                created = client.post(
                    "/api/v1/admin/users",
                    headers={**origin, **admin_headers},
                    json={
                        "login": f"demo-smoke-teacher-{teacher_id}",
                        "full_name": teacher_record["name"],
                        "role": "teacher",
                        "teacher_id": str(teacher_id),
                    },
                )
                assert created.status_code == 201, (teacher_record, created.text)
                logged_in = client.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={
                        "login": f"demo-smoke-teacher-{teacher_id}",
                        "password": created.json()["initial_password"],
                    },
                )
                assert logged_in.status_code == 200, logged_in.text
                teacher_auth = {"Authorization": f"Bearer {logged_in.json()['access_token']}"}
                assignments = client.get(
                    "/api/v1/teaching/assignments?limit=100", headers=teacher_auth
                )
                schedule = client.get(
                    "/api/v1/teaching/schedule?date_from=2026-09-07&date_to=2026-09-11",
                    headers=teacher_auth,
                )
                assert assignments.status_code == schedule.status_code == 200
                assert assignments.json()["items"] and schedule.json()["items"]
                has_assessment_journal = False
                for assigned in assignments.json()["items"]:
                    journal = (
                        f"/api/v1/teaching/courses/{assigned['course_offering_id']}"
                        f"/groups/{assigned['group']['id']}"
                    )
                    roster = client.get(f"{journal}/students?limit=100", headers=teacher_auth)
                    assessments = client.get(
                        f"{journal}/assessments?limit=100", headers=teacher_auth
                    )
                    assert roster.status_code == assessments.status_code == 200
                    assert roster.json()["items"], teacher_record["name"]
                    has_assessment_journal |= bool(assessments.json()["items"])
                assert has_assessment_journal, teacher_record["name"]
                linked_teacher_ids.add(teacher_id)
            assert len(linked_teacher_ids) == 10
            attendance_lesson = db_session.scalar(
                select(Lesson)
                .join(seed.CourseOffering)
                .join(seed.Discipline)
                .where(seed.Discipline.name == "Математический анализ")
                .where(Lesson.starts_at == datetime(2026, 11, 16, 9, tzinfo=seed.MOSCOW))
            )
            attendance_key = (attendance_lesson.id, pz.id)
            assert db_session.get(seed.Attendance, attendance_key).status == "absent"
            attendance_write = client.put(
                f"/api/v1/attendance/lessons/{attendance_lesson.id}/students/{pz.id}",
                headers=linked_teacher_headers,
                json={"status": "attended"},
            )
            assert attendance_write.status_code == 200, attendance_write.text
            db_session.expire_all()
            assert db_session.get(seed.Attendance, attendance_key).status == "attended"
            assert db_session.get(seed.Attendance, attendance_key).marked_by_user_id is not None

            login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": "demo-pz101", "password": os.environ["DEMO_STUDENT_A_PASSWORD"]},
            )
            assert login.status_code == 200
            token = login.json()["access_token"]
            headers = {"Authorization": f"Bearer {token}"}
            teacher_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={
                    "login": "demo-severin-voron",
                    "password": os.environ["DEMO_TEACHER_PASSWORD"],
                },
            )
            assert teacher_login.status_code == 200
            teacher_headers = {"Authorization": f"Bearer {teacher_login.json()['access_token']}"}
            teacher_assignments = client.get(
                "/api/v1/teaching/assignments?limit=100", headers=teacher_headers
            )
            assert teacher_assignments.status_code == 200
            teacher_items = teacher_assignments.json()["items"]
            defense_assignment = next(
                item
                for item in teacher_items
                if item["discipline"]["name"] == "Защита от тёмных искусств"
            )
            assert {item["group"]["name"] for item in teacher_items} == {"ПЗ-101", "ПМ-201"}
            journal_path = (
                f"/api/v1/teaching/courses/{defense_assignment['course_offering_id']}"
                f"/groups/{defense_assignment['group']['id']}"
            )
            journal_assessments = client.get(
                f"{journal_path}/assessments?limit=100", headers=teacher_headers
            )
            assert journal_assessments.status_code == 200
            seminar_assessment = next(
                item
                for item in journal_assessments.json()["items"]
                if item["type"] == "seminar" and item["max_score"] == 2
            )
            for assignment_row in teacher_items:
                if assignment_row["discipline"]["name"] != "Защита от тёмных искусств":
                    continue
                path = (
                    f"/api/v1/teaching/courses/{assignment_row['course_offering_id']}"
                    f"/groups/{assignment_row['group']['id']}"
                )
                for suffix in ("students?limit=100", "assessments?limit=100", "lessons?limit=100"):
                    journal_response = client.get(f"{path}/{suffix}", headers=teacher_headers)
                    assert journal_response.status_code == 200
                    assert journal_response.json()["items"]
            student_id = db_session.scalar(
                select(Student.id).where(Student.group_id == int(defense_assignment["group"]["id"]))
            )
            score_path = (
                f"{journal_path}/assessments/{seminar_assessment['id']}/results/{student_id}"
            )
            zero_score = client.put(score_path, headers=teacher_headers, json={"score": 0})
            assert zero_score.status_code == 200
            removed_score = client.put(score_path, headers=teacher_headers, json={"score": None})
            assert removed_score.status_code == 200
            assert (
                db_session.scalar(
                    select(AssessmentResult.id).where(
                        AssessmentResult.assessment_group_id == int(seminar_assessment["id"]),
                        AssessmentResult.student_id == student_id,
                    )
                )
                is None
            )
            deleted_event_id = db_session.scalar(
                select(AuditEvent.id)
                .where(
                    AuditEvent.entity_type == "assessment_result",
                    AuditEvent.action == "delete",
                    AuditEvent.before_data["assessment_group_id"].as_integer()
                    == int(seminar_assessment["id"]),
                    AuditEvent.before_data["student_id"].as_integer() == student_id,
                )
                .order_by(AuditEvent.id.desc())
            )
            assert deleted_event_id is not None
            assert db_session.scalar(
                select(AuditEvent.actor_user_id).where(AuditEvent.id == deleted_event_id)
            ) == db_session.scalar(select(User.id).where(User.login == "demo-severin-voron"))
            seed.seed_demo_data()
            db_session.expire_all()
            assert (
                db_session.scalar(
                    select(AssessmentResult.id).where(
                        AssessmentResult.assessment_group_id == int(seminar_assessment["id"]),
                        AssessmentResult.student_id == student_id,
                    )
                )
                is None
            )
            dean_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": "demo-dean", "password": os.environ["DEMO_DEAN_STAFF_PASSWORD"]},
            )
            accounting_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={
                    "login": "demo-accounting",
                    "password": os.environ["DEMO_ACCOUNTING_STAFF_PASSWORD"],
                },
            )
            assert dean_login.status_code == accounting_login.status_code == 200
            dean_headers = {"Authorization": f"Bearer {dean_login.json()['access_token']}"}
            staff_history_path = score_path.replace("/api/v1/teaching/", "/api/v1/staff/journals/")
            repeated_history = client.get(f"{staff_history_path}/history", headers=dean_headers)
            assert repeated_history.status_code == 200
            assert str(deleted_event_id) in {
                event["event_id"] for event in repeated_history.json()["items"]
            }
            accounting_headers = {
                "Authorization": f"Bearer {accounting_login.json()['access_token']}"
            }
            staff_catalog = client.get(
                "/api/v1/staff/journals/catalog?limit=20", headers=dean_headers
            )
            assert staff_catalog.status_code == 200 and staff_catalog.json()["items"]
            accounting_catalog = client.get(
                "/api/v1/staff/journals/catalog?limit=20", headers=accounting_headers
            )
            assert accounting_catalog.status_code == 403
            news_page = client.get("/api/v1/news", headers=headers)
            assert news_page.status_code == 200
            visible_news = next(
                item for item in news_page.json()["items"] if item["id"] == str(schedule_news.id)
            )
            assert "нестабильностью магического фона" in visible_news["excerpt"]
            news_detail = client.get(f"/api/v1/news/{schedule_news.id}", headers=headers)
            assert news_detail.status_code == 200
            assert "23 ноября" not in news_detail.json()["body"]
            pm_login = client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": "demo-pm201", "password": os.environ["DEMO_STUDENT_B_PASSWORD"]},
            )
            assert pm_login.status_code == 200
            pm_token = pm_login.json()["access_token"]
            pm_week = client.get(
                "/api/v1/schedule?date_from=2026-09-07&date_to=2026-09-11",
                headers={"Authorization": f"Bearer {pm_token}"},
            )
            assert pm_week.status_code == 200 and len(pm_week.json()["items"]) == 18
            first_group_lessons = set(
                db_session.scalars(
                    select(seed.LessonGroup.lesson_id)
                    .where(seed.LessonGroup.subgroup_id == first_subgroup.id)
                    .join(seed.Lesson)
                    .where(
                        seed.Lesson.starts_at >= datetime(2026, 9, 7, tzinfo=seed.MOSCOW),
                        seed.Lesson.starts_at < datetime(2026, 9, 12, tzinfo=seed.MOSCOW),
                    )
                )
            )
            assert first_group_lessons.isdisjoint(
                {int(item["id"]) for item in pm_week.json()["items"]}
            )
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
            preserved_score = client.put(score_path, headers=teacher_headers, json={"score": 1})
            assert preserved_score.status_code == 200
            schedule_news.body = seed.PREVIOUS_INTRO_NEWS_BODY
            db_session.flush()
            pm_user.is_active = False
            severin_record = db_session.scalar(
                select(seed.Teacher).where(seed.Teacher.full_name == "Северин Аркадьевич Ворон")
            )
            revoked_assignment = db_session.scalar(
                select(seed.TeachingAssignment).where(
                    seed.TeachingAssignment.teacher_id == severin_record.id
                )
            )
            assert revoked_assignment is not None
            revoked_assignment_id = revoked_assignment.id
            db_session.delete(revoked_assignment)
            accounting_profile = db_session.scalar(
                select(seed.StaffProfile)
                .join(User, seed.StaffProfile.user_id == User.id)
                .where(User.login == "demo-accounting")
            )
            revoked_grant = db_session.scalar(
                select(seed.StaffPermission).where(
                    seed.StaffPermission.staff_profile_id == accounting_profile.id
                )
            )
            assert revoked_grant is not None
            revoked_grant_id = revoked_grant.id
            db_session.delete(revoked_grant)
            db_session.flush()
            seed.seed_demo_data()
            db_session.expire_all()
            refreshed_news = client.get(f"/api/v1/news/{schedule_news.id}", headers=headers)
            assert refreshed_news.status_code == 200
            assert "нестабильностью магического фона" in refreshed_news.json()["body"]
            assert "23 ноября" not in refreshed_news.json()["body"]
            assert pm_user.is_active is False
            assert db_session.get(seed.TeachingAssignment, revoked_assignment_id) is None
            assert db_session.get(seed.StaffPermission, revoked_grant_id) is None
            assert db_session.get(seed.Attendance, attendance_key).status == "attended"
            assert (
                db_session.scalar(
                    select(AssessmentResult.score).where(
                        AssessmentResult.assessment_group_id == int(seminar_assessment["id"]),
                        AssessmentResult.student_id == student_id,
                    )
                )
                == 1
            )
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
    assert "нестабильностью магического фона" in schedule_news.body
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
        "pz_notifications": db_session.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == pz.user_id)
        ),
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
        "pz_notifications": db_session.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == pz.user_id)
        ),
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
        == before["pz_notifications"]
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
    monkeypatch.setenv("DEMO_TEACHER_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_DEAN_STAFF_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_ACCOUNTING_STAFF_PASSWORD", token_urlsafe(24))

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
            seed.Discipline.name == "Защита от тёмных искусств",
            Lesson.starts_at == datetime(2026, 11, 18, 13, tzinfo=seed.MOSCOW),
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
            table: tuple(
                tuple(row)
                for row in db_session.execute(text(f'SELECT * FROM "{table}" ORDER BY 1, 2'))
            )
            for table in ("lessons", "lesson_groups", "lesson_rooms")
        }
        with pytest.raises(RuntimeError, match="unexpected lesson_"):
            seed.seed_demo_data()
        after = {
            table: tuple(
                tuple(row)
                for row in db_session.execute(text(f'SELECT * FROM "{table}" ORDER BY 1, 2'))
            )
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
            tuple(row) for row in db_session.execute(text('SELECT * FROM "lessons" ORDER BY 1, 2'))
        )
        with pytest.raises(RuntimeError, match="unexpected lesson_rooms"):
            seed.seed_demo_data()
        assert (
            tuple(
                tuple(row)
                for row in db_session.execute(text('SELECT * FROM "lessons" ORDER BY 1, 2'))
            )
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
    if target_field == "DEMO_SEED_ALLOWED_PORT":
        wrong_value = str((url.port or 5432) % 65535 + 1)
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
    monkeypatch.setenv("DEMO_TEACHER_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_DEAN_STAFF_PASSWORD", token_urlsafe(24))
    monkeypatch.setenv("DEMO_ACCOUNTING_STAFF_PASSWORD", token_urlsafe(24))
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
    password_c = token_urlsafe(24)
    password_d = token_urlsafe(24)
    password_e = token_urlsafe(24)
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
            "DEMO_TEACHER_PASSWORD": password_c,
            "DEMO_DEAN_STAFF_PASSWORD": password_d,
            "DEMO_ACCOUNTING_STAFF_PASSWORD": password_e,
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
                    seed.Discipline.name == "Математический анализ",
                    seed.Lesson.starts_at == datetime(2026, 11, 16, 9, 0, tzinfo=seed.MOSCOW),
                )
            )
            expected_room_id = db.scalar(
                select(seed.Room.id)
                .join(seed.Building)
                .where(
                    seed.Room.name == "201", seed.Building.name == "Главный учебный корпус (ГУК)"
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
