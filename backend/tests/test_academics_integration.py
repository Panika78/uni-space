from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.exc import IntegrityError

from app.academics.router import router
from app.academics.service import get_student_academics
from app.auth.security import create_access_token
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.dependencies.database import get_db_session
from app.models import (
    AcademicTerm,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    AuthSession,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    OrgUnit,
    Program,
    Student,
    StudyGroup,
    User,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def academics(db_session):
    db = db_session

    def add(model, **values):
        obj = model(**values)
        db.add(obj)
        db.flush()
        return obj

    faculty = add(OrgUnit, name="Вымышленный факультет", type="faculty")
    program = add(
        Program,
        code="fixture",
        name="Программа",
        direction_code="00",
        direction_name="Направление",
        faculty_id=faculty.id,
    )
    groups = [
        add(StudyGroup, name=f"ТЕСТ-{i}", program_id=program.id, course_number=1) for i in range(2)
    ]
    users = [
        add(
            User,
            login=f"academics-{uuid4().hex}",
            password_hash="unusable",
            full_name="Вымышленный студент",
            role="student",
            is_active=True,
        )
        for _ in range(3)
    ]
    students = [
        add(Student, user_id=u.id, group_id=groups[i % 2].id, academic_status="enrolled")
        for i, u in enumerate(users)
    ]
    term = add(
        AcademicTerm, name="Тестовый семестр", starts_on=date(2026, 9, 1), ends_on=date(2027, 1, 31)
    )

    def offering(kind="exam", assigned=None):
        discipline = add(Discipline, name=f"Предмет {uuid4().hex}")
        obj = add(
            CourseOffering, discipline_id=discipline.id, term_id=term.id, attestation_type=kind
        )
        for group in groups if assigned is None else assigned:
            add(CourseGroup, course_offering_id=obj.id, group_id=group.id)
        return obj

    def assignment(course, group=0, maximum=10, assessment=None):
        work = assessment or add(
            Assessment,
            course_offering_id=course.id,
            title="Вымышленная работа",
            type="test",
            max_score=maximum,
        )
        return add(AssessmentGroup, assessment_id=work.id, group_id=groups[group].id)

    def result(assignment, score, student=0):
        return add(
            AssessmentResult,
            assessment_group_id=assignment.id,
            student_id=students[student].id,
            score=score,
            graded_at=datetime.now(UTC),
        )

    settings = Settings(
        _env_file=None,
        app_env="test",
        jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )
    sessions = [
        add(AuthSession, user_id=u.id, expires_at=datetime.now(UTC) + timedelta(days=1))
        for u in users
    ]
    tokens = [create_access_token(s, settings)["access_token"] for s in sessions]
    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_db_session] = lambda: db
    client = TestClient(app, raise_server_exceptions=False)

    def request(index=0, **params):
        return client.get(
            "/api/v1/academics", params=params, headers={"Authorization": f"Bearer {tokens[index]}"}
        )

    return SimpleNamespace(**locals())


@pytest.fixture(autouse=True)
def moscow_clock(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            # UTC is still the previous day; Moscow is exactly the term start.
            return datetime(2026, 8, 31, 21, tzinfo=UTC).astimezone(tz)

    monkeypatch.setattr("app.academics.service.datetime", Clock)


def test_aggregates_zero_and_missing_without_join_multiplication(academics):
    s = academics
    course = s.offering()
    works = [s.assignment(course) for _ in range(3)]
    s.result(works[0], 6)
    s.result(works[1], 0)
    s.result(works[0], 10, student=2)  # Another student in the same group.
    shared = s.db.get(Assessment, works[0].assessment_id)
    other = s.assignment(course, group=1, assessment=shared)
    s.result(other, 9, student=1)
    response = s.request()
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"]
    item = response.json()["items"][0]
    assert [
        item[k] for k in ("total_score", "max_score", "graded_assessment_count", "assessment_count")
    ] == [6, 30, 2, 3]
    assert item["final_result"] == dict(
        grade_value=None, passed=None, has_debt=False, retake_date=None, retake_location=None
    )
    assert s.request(1).json()["items"][0]["total_score"] == 9
    assert s.request(2).json()["items"][0]["total_score"] == 10
    assert s.request().json() == response.json()
    own = s.offering(assigned=s.groups[:1])
    assert str(own.id) not in [i["course_offering_id"] for i in s.request(1).json()["items"]]
    for params in (
        {"student_id": s.students[1].id},
        {"group_id": s.groups[1].id},
        {"term_id": s.term.id},
    ):
        assert s.request(**params).status_code == 422
    assert s.client.get("/api/v1/academics").status_code == 401
    s.users[0].role = "staff"
    s.db.flush()
    assert s.request().status_code == 403


def test_ungraded_empty_and_constant_query_count(academics):
    s = academics
    empty = s.offering()
    ungraded = s.offering()
    for _ in range(3):
        s.assignment(ungraded)
    calls = []

    def record(*args):
        calls.append(args[2])

    event.listen(s.db.bind, "before_cursor_execute", record)
    try:
        first = get_student_academics(s.db, s.students[0])
        assert len(calls) == 2
        calls.clear()
        for _ in range(10):
            s.offering()
        calls.clear()
        get_student_academics(s.db, s.students[0])
        assert len(calls) == 2
    finally:
        event.remove(s.db.bind, "before_cursor_execute", record)
    by_id = {i.course_offering_id: i for i in first.items}
    assert by_id[str(empty.id)].max_score == by_id[str(empty.id)].total_score == 0
    item = by_id[str(ungraded.id)]
    assert (
        item.total_score,
        item.max_score,
        item.graded_assessment_count,
        item.assessment_count,
    ) == (0, 30, 0, 3)


def test_term_boundaries_absence_and_safe_overlap_error(academics, monkeypatch):
    s = academics
    assert s.request().json()["term"]["id"] == str(s.term.id)
    s.term.ends_on = s.term.starts_on
    s.db.flush()
    assert s.request().json()["term"] is not None
    s.term.starts_on = s.term.ends_on = date(2026, 8, 31)
    s.db.flush()
    assert s.request().json() == {"term": None, "items": []}
    s.term.ends_on = date(2026, 9, 2)
    s.db.flush()
    s.add(
        AcademicTerm,
        name="Overlapping private configuration",
        starts_on=date(2026, 9, 1),
        ends_on=date(2026, 9, 2),
    )
    response = s.request()
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert "Overlapping" not in response.text


@pytest.mark.parametrize(
    ("kind", "values", "debt"),
    [
        ("exam", {"grade_value": 2}, True),
        ("exam", {"grade_value": 3}, False),
        ("exam", {"grade_value": 4}, False),
        ("exam", {"grade_value": 5}, False),
        ("graded_pass", {"grade_value": 5}, False),
        ("graded_pass", {"grade_value": 2}, True),
        ("pass_fail", {"passed": True}, False),
        ("pass_fail", {"passed": False}, True),
        ("exam", {"retake_date": date(2026, 12, 1)}, False),
        ("pass_fail", {"retake_location": "Тестовая аудитория"}, False),
    ],
)
def test_all_attestations_debt_and_partial_retake(academics, kind, values, debt):
    s = academics
    course = s.offering(kind)
    s.add(FinalResult, course_offering_id=course.id, student_id=s.students[0].id, **values)
    result = s.request().json()["items"][0]["final_result"]
    assert result["has_debt"] is debt
    for key in ("grade_value", "passed", "retake_date", "retake_location"):
        expected = values.get(key)
        assert result[key] == (expected.isoformat() if isinstance(expected, date) else expected)
    assert s.request(1).json()["items"][0]["final_result"]["has_debt"] is False


@pytest.mark.parametrize(
    ("kind", "values"),
    [
        ("exam", {"passed": True}),
        ("graded_pass", {"passed": False}),
        ("pass_fail", {"grade_value": 5}),
        ("exam", {"grade_value": 1}),
        ("exam", {"grade_value": 6}),
        ("exam", {"grade_value": 5, "passed": True}),
        ("exam", {}),
    ],
)
def test_postgres_rejects_invalid_final_results(academics, kind, values):
    s = academics
    course = s.offering(kind)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(FinalResult, course_offering_id=course.id, student_id=s.students[0].id, **values)


def test_postgres_prevents_duplicate_and_inconsistent_assignments(academics):
    s = academics
    course = s.offering(assigned=s.groups[:1])
    assignment = s.assignment(course)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(AssessmentGroup, assessment_id=assignment.assessment_id, group_id=s.groups[0].id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(AssessmentGroup, assessment_id=assignment.assessment_id, group_id=s.groups[1].id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("DELETE FROM course_groups WHERE course_offering_id=:id"), {"id": course.id}
        )
    other = s.offering(assigned=s.groups[1:])
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("UPDATE assessments SET course_offering_id=:other WHERE id=:id"),
            {"other": other.id, "id": assignment.assessment_id},
        )
    s.result(assignment, 0)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.result(assignment, 5)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.result(assignment, -1, student=2)
    final = s.add(
        FinalResult, course_offering_id=course.id, student_id=s.students[0].id, grade_value=4
    )
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("UPDATE course_offerings SET attestation_type='pass_fail' WHERE id=:id"),
            {"id": course.id},
        )
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(FinalResult, course_offering_id=course.id, student_id=s.students[0].id, grade_value=3)
    assert s.db.get(FinalResult, final.id).grade_value == 4


def test_transfer_preserves_historical_results_but_reads_only_current_assignments(academics):
    s = academics
    course = s.offering()
    old = s.assignment(course)
    s.result(old, 6)
    current = s.assignment(course, group=1)
    # A result cannot be attached to another group's assignment, even for the same course.
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.result(current, 7)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.result(old, 11, student=2)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(Assessment, course_offering_id=course.id, title="Invalid", type="test", max_score=-1)
    s.students[0].group_id = s.groups[1].id
    s.db.flush()
    item = s.request().json()["items"][0]
    assert (item["total_score"], item["max_score"], item["graded_assessment_count"]) == (0, 10, 0)
    assert s.db.query(AssessmentResult).filter_by(assessment_group_id=old.id).count() == 1
    s.result(current, 4)
    assert s.request().json()["items"][0]["total_score"] == 4


def test_no_curriculum_and_other_terms_are_excluded(academics):
    s = academics
    assert s.request().json()["term"] is not None
    assert s.request().json()["items"] == []
    course = s.offering()
    earlier = s.add(
        AcademicTerm, name="Предыдущий", starts_on=date(2025, 9, 1), ends_on=date(2026, 1, 1)
    )
    course.term_id = earlier.id
    s.db.flush()
    assert s.request().json()["items"] == []


def test_assignment_lesson_matches_course_and_group(academics):
    from app.models import Lesson, LessonGroup

    s = academics
    course = s.offering()
    other = s.offering()
    work = s.add(
        Assessment, course_offering_id=course.id, title="Работа", type="test", max_score=10
    )
    lesson = s.add(
        Lesson,
        course_offering_id=other.id,
        starts_at=datetime(2026, 9, 1, tzinfo=UTC),
        ends_at=datetime(2026, 9, 1, 1, tzinfo=UTC),
        kind="lecture",
    )
    link = s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(AssessmentGroup, assessment_id=work.id, group_id=s.groups[0].id, lesson_id=lesson.id)
    lesson.course_offering_id = course.id
    s.db.flush()
    s.add(AssessmentGroup, assessment_id=work.id, group_id=s.groups[0].id, lesson_id=lesson.id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(text("DELETE FROM lesson_groups WHERE id=:id"), {"id": link.id})
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("UPDATE lessons SET course_offering_id=:other WHERE id=:id"),
            {"other": other.id, "id": lesson.id},
        )
