from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.exc import IntegrityError

from app.auth.security import create_access_token
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.dependencies.database import get_db_session
from app.models import (
    AcademicTerm,
    AuthSession,
    Building,
    CourseGroup,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    LessonRoom,
    OrgUnit,
    Program,
    Room,
    Student,
    StudyGroup,
    Teacher,
    TeachingAssignment,
    User,
)
from app.schedule.router import router
from app.schedule.schemas import ScheduleParams
from app.schedule.service import list_student_schedule
from app.schedule.teacher_router import router as teacher_schedule_router

pytestmark = pytest.mark.integration


def returned_lesson_ids(payload):
    ids = {item["id"] for item in payload["items"]}
    for item in payload["items"]:
        for key in ("previous_lesson", "latest_lesson"):
            if item[key] is not None:
                ids.add(item[key]["id"])
    return ids


def teacher_schedule_request(schedule, start="2026-11-10", end=None):
    return schedule.client.get(
        "/api/v1/teaching/schedule",
        params={"date_from": start, "date_to": end or start},
        headers={"Authorization": f"Bearer {schedule.tokens[2]}"},
    )


@pytest.fixture
def schedule(db_session):
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
        name="Вымышленная программа",
        direction_code="00.00",
        direction_name="Вымышленное направление",
        faculty_id=faculty.id,
    )
    groups = [
        add(StudyGroup, name=f"ТЕСТ-{i}", program_id=program.id, course_number=1) for i in (1, 2)
    ]
    users = [
        add(
            User,
            login=f"schedule-{uuid4().hex}",
            password_hash="unusable-fixture",
            full_name=f"Вымышленный студент {i}",
            role="student",
            is_active=True,
        )
        for i in (1, 2)
    ]
    students = [
        add(Student, user_id=user.id, group_id=group.id, academic_status="enrolled")
        for user, group in zip(users, groups, strict=True)
    ]
    teacher_user = add(
        User,
        login=f"teacher-{uuid4().hex}",
        password_hash="unusable-fixture",
        full_name="ФИО из аккаунта",
        role="teacher",
        is_active=True,
    )
    teacher = add(Teacher, full_name="Неактуальное справочное ФИО", user_id=teacher_user.id)
    standalone = add(Teacher, full_name="Вымышленный преподаватель без аккаунта")
    term = add(
        AcademicTerm, name="Осень 2026", starts_on=date(2026, 9, 1), ends_on=date(2027, 1, 31)
    )
    discipline = add(Discipline, name="Вымышленная дисциплина")
    offering = add(
        CourseOffering, discipline_id=discipline.id, term_id=term.id, attestation_type="exam"
    )
    for group in groups:
        add(CourseGroup, course_offering_id=offering.id, group_id=group.id)
    buildings = [add(Building, name=f"Корпус {i}") for i in (1, 2)]
    rooms = [add(Room, building_id=b.id, name=f"Аудитория {i}") for i, b in enumerate(buildings)]

    def lesson(start="2026-11-10T09:00:00+03:00", end=None, *, assigned=None, room_ids=(), **kw):
        starts = datetime.fromisoformat(start)
        obj = add(
            Lesson,
            course_offering_id=offering.id,
            starts_at=starts,
            ends_at=datetime.fromisoformat(end) if end else starts + timedelta(hours=1),
            kind=kw.pop("kind", "lecture"),
            **kw,
        )
        for group in groups[:1] if assigned is None else assigned:
            add(LessonGroup, lesson_id=obj.id, group_id=group.id)
        for room_id in room_ids:
            add(LessonRoom, lesson_id=obj.id, room_id=room_id)
        # A fixture lesson with its initial links is one aggregate creation,
        # matching insert_lesson(), not independent administrative statements.
        db.execute(text("UPDATE lessons SET version=1 WHERE id=:id"), {"id": obj.id})
        db.refresh(obj)
        return obj

    settings = Settings(
        _env_file=None,
        app_env="test",
        jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )
    sessions = [
        add(AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
        for user in [*users, teacher_user]
    ]
    tokens = [create_access_token(session, settings)["access_token"] for session in sessions]
    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)
    app.include_router(teacher_schedule_router)
    app.dependency_overrides[get_db_session] = lambda: db
    app.dependency_overrides[get_settings] = lambda: settings
    client = TestClient(app)

    def request(index=0, start="2026-11-10", end=None, **params):
        return client.get(
            "/api/v1/schedule",
            params={"date_from": start, "date_to": end or start, **params},
            headers={"Authorization": f"Bearer {tokens[index]}"},
        )

    return SimpleNamespace(**locals())


def test_teacher_schedule_uses_teacher_and_actual_group_scope(schedule):
    s = schedule
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    shared = s.lesson(assigned=s.groups, teacher_id=s.teacher.id, room_ids=[r.id for r in s.rooms])
    outsider_group = s.lesson(assigned=s.groups[1:], teacher_id=s.teacher.id)
    wrong_teacher = s.lesson(teacher_id=s.standalone.id)
    unassigned = s.lesson(assigned=[], teacher_id=s.teacher.id)
    additional = s.lesson(teacher_id=s.teacher.id, is_additional=True)

    response = s.client.get(
        "/api/v1/teaching/schedule",
        params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
        headers={"Authorization": f"Bearer {s.tokens[2]}"},
    )
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [str(shared.id)]
    item = response.json()["items"][0]
    assert item["groups"] == [
        {"id": str(s.groups[0].id), "name": s.groups[0].name, "subgroup": None}
    ]
    assert len(item["rooms"]) == 2
    assert "attendance_status" not in item and "linked_assessments" not in item
    exposed_ids = returned_lesson_ids(response.json())
    assert all(
        str(value.id) not in exposed_ids
        for value in (outsider_group, wrong_teacher, unassigned, additional)
    )
    assert (
        s.client.get(
            "/api/v1/teaching/schedule",
            params={"date_from": "2026-11-10", "date_to": "2026-12-11"},
            headers={"Authorization": f"Bearer {s.tokens[2]}"},
        ).status_code
        == 422
    )


@pytest.mark.parametrize("status", ["cancelled", "moved"])
def test_teacher_schedule_inactive_overnight_positions_only_appear_on_start_date(schedule, status):
    s = schedule
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    lesson = s.lesson(
        "2026-11-10T23:30:00+03:00",
        "2026-11-11T00:30:00+03:00",
        teacher_id=s.teacher.id,
        status=status,
    )
    assert [item["id"] for item in teacher_schedule_request(s, "2026-11-10").json()["items"]] == [
        str(lesson.id)
    ]
    assert teacher_schedule_request(s, "2026-11-11").json()["items"] == []


def test_teacher_schedule_move_chain_hides_unassigned_positions(schedule):
    s = schedule
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.standalone.id,
    )
    root = s.lesson(status="moved", teacher_id=s.teacher.id)
    hidden = s.lesson(
        "2026-11-20T09:00:00+03:00",
        status="moved",
        previous_lesson_id=root.id,
        teacher_id=s.standalone.id,
    )
    terminal = s.lesson(
        "2026-12-20T09:00:00+03:00", previous_lesson_id=hidden.id, teacher_id=s.teacher.id
    )
    response = s.client.get(
        "/api/v1/teaching/schedule",
        params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
        headers={"Authorization": f"Bearer {s.tokens[2]}"},
    )
    item = response.json()["items"][0]
    assert item["latest_lesson"]["id"] == str(terminal.id)
    assert str(hidden.id) not in returned_lesson_ids(response.json())
    assert (
        s.client.get(
            "/api/v1/teaching/schedule",
            params={"date_from": "2026-11-20", "date_to": "2026-11-20"},
            headers={"Authorization": f"Bearer {s.tokens[2]}"},
        ).json()["items"]
        == []
    )


def test_teacher_schedule_move_chain_stops_at_first_non_moved_position(schedule):
    s = schedule
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    root = s.lesson(status="moved", teacher_id=s.teacher.id)
    terminal = s.lesson(
        "2026-11-20T09:00:00+03:00", previous_lesson_id=root.id, teacher_id=s.teacher.id
    )
    corrupt = s.lesson(
        "2026-12-20T09:00:00+03:00",
        status="cancelled",
        previous_lesson_id=terminal.id,
        teacher_id=s.teacher.id,
    )
    item = teacher_schedule_request(s).json()["items"][0]
    assert item["latest_lesson"]["id"] == str(terminal.id)
    assert item["latest_lesson"]["id"] != str(corrupt.id)


def test_teacher_schedule_query_count_does_not_grow_per_lesson(schedule):
    from sqlalchemy import event

    s = schedule
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    s.lesson(teacher_id=s.teacher.id)
    counts = []

    def count_selects(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            counts.append(statement)

    event.listen(s.db.bind, "before_cursor_execute", count_selects)
    try:
        first = s.client.get(
            "/api/v1/teaching/schedule",
            params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
            headers={"Authorization": f"Bearer {s.tokens[2]}"},
        )
        assert first.status_code == 200
        small_count = len(counts)
        counts.clear()
        for _ in range(9):
            s.lesson(teacher_id=s.teacher.id)
        counts.clear()
        large = s.client.get(
            "/api/v1/teaching/schedule",
            params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
            headers={"Authorization": f"Bearer {s.tokens[2]}"},
        )
        assert large.status_code == 200
        assert len(large.json()["items"]) == 10
        assert len(counts) == small_count
    finally:
        event.remove(s.db.bind, "before_cursor_execute", count_selects)


def test_teacher_schedule_empty_scope_revocation_and_role_errors(schedule):
    from sqlalchemy import delete

    s = schedule
    url = "/api/v1/teaching/schedule"
    params = {"date_from": "2026-11-10", "date_to": "2026-11-10"}
    assert s.client.get(url, params=params).status_code == 401
    assert (
        s.client.get(
            url, params=params, headers={"Authorization": f"Bearer {s.tokens[0]}"}
        ).status_code
        == 403
    )
    empty = s.client.get(url, params=params, headers={"Authorization": f"Bearer {s.tokens[2]}"})
    assert empty.status_code == 200 and empty.json()["items"] == []

    assignment = s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    null_teacher = s.lesson(teacher_id=None)
    own = s.lesson(teacher_id=s.teacher.id)
    assert own.id != null_teacher.id
    before_revoke = s.client.get(
        url, params=params, headers={"Authorization": f"Bearer {s.tokens[2]}"}
    )
    assert [item["id"] for item in before_revoke.json()["items"]] == [str(own.id)]
    s.db.execute(delete(TeachingAssignment).where(TeachingAssignment.id == assignment.id))
    after_revoke = s.client.get(
        url, params=params, headers={"Authorization": f"Bearer {s.tokens[2]}"}
    )
    assert after_revoke.status_code == 200 and after_revoke.json()["items"] == []


def test_teacher_schedule_midnight_and_date_range_boundaries(schedule):
    s = schedule
    s.add(
        TeachingAssignment,
        course_offering_id=s.offering.id,
        group_id=s.groups[0].id,
        teacher_id=s.teacher.id,
    )
    overnight = s.lesson(
        "2026-11-10T23:30:00+03:00",
        "2026-11-11T00:30:00+03:00",
        teacher_id=s.teacher.id,
    )
    url = "/api/v1/teaching/schedule"
    headers = {"Authorization": f"Bearer {s.tokens[2]}"}
    first_day = s.client.get(
        url, params={"date_from": "2026-11-10", "date_to": "2026-11-10"}, headers=headers
    )
    second_day = s.client.get(
        url, params={"date_from": "2026-11-11", "date_to": "2026-11-11"}, headers=headers
    )
    assert [item["id"] for item in first_day.json()["items"]] == [str(overnight.id)]
    assert [item["id"] for item in second_day.json()["items"]] == [str(overnight.id)]
    thirty_one_days = s.client.get(
        url, params={"date_from": "2026-11-01", "date_to": "2026-12-01"}, headers=headers
    )
    assert thirty_one_days.status_code == 200
    thirty_two_days = s.client.get(
        url, params={"date_from": "2026-11-01", "date_to": "2026-12-02"}, headers=headers
    )
    assert thirty_two_days.status_code == 422


def test_schedule_isolates_actual_assignments_and_returns_shared_lesson_once(schedule):
    s = schedule
    shared = s.lesson(assigned=s.groups, room_ids=[r.id for r in s.rooms], teacher_id=s.teacher.id)
    own = s.lesson(teacher_id=s.standalone.id)
    other = s.lesson(assigned=s.groups[1:])  # course_groups includes both; lesson does not.
    unassigned = s.lesson(assigned=[])
    result = s.request()
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["timezone"] == "Europe/Moscow"
    items = result.json()["items"]
    assert [i["id"] for i in items] == [str(shared.id), str(own.id)]
    assert len(items[0]["groups"]) == len(items[0]["rooms"]) == 2
    assert items[0]["teacher"]["name"] == "ФИО из аккаунта"
    assert items[1]["teacher"]["name"] == s.standalone.full_name
    assert [i["id"] for i in s.request(1).json()["items"]] == [str(shared.id), str(other.id)]
    assert str(unassigned.id) not in [i["id"] for i in items]
    assert s.request(student_id=s.students[1].id).status_code == 422
    assert s.request(group_id=s.groups[1].id).status_code == 422
    assert (
        s.request().json()["items"] == items
    )  # switching back never reuses another student's result


def test_schedule_uses_moscow_half_open_intersection_and_nullable_details(schedule):
    s = schedule
    s.lesson("2026-11-09T23:00:00+03:00", "2026-11-10T00:00:00+03:00")
    crossing = s.lesson("2026-11-09T23:30:00+03:00", "2026-11-10T00:30:00+03:00")
    evening = s.lesson("2026-11-10T23:30:00+03:00", "2026-11-11T00:30:00+03:00")
    s.lesson("2026-11-11T00:00:00+03:00")
    items = s.request().json()["items"]
    assert [i["id"] for i in items] == [str(crossing.id), str(evening.id)]
    assert items[0]["starts_at"] == "2026-11-09T20:30:00Z"
    assert items[0]["teacher"] is None and items[0]["rooms"] == []
    assert str(crossing.id) in [i["id"] for i in s.request(start="2026-11-09").json()["items"]]
    assert str(evening.id) in [i["id"] for i in s.request(start="2026-11-11").json()["items"]]
    assert s.request(start="2026-11-12").json()["items"] == []
    assert s.request(start="2026-01-01", end="2026-01-31").status_code == 200
    assert s.request(start="2026-01-01", end="2026-02-01").status_code == 422
    assert s.request(start="9999-12-31").status_code == 200


@pytest.mark.parametrize("terminal_status", ["scheduled", "cancelled"])
def test_schedule_resolves_repeated_moves_outside_range_and_cancelled_terminal(
    schedule, terminal_status
):
    s = schedule
    a = s.lesson(status="moved")
    b = s.lesson("2026-11-20T09:00:00+03:00", previous_lesson_id=a.id, status="moved")
    c = s.lesson("2026-12-20T09:00:00+03:00", previous_lesson_id=b.id, status=terminal_status)
    old = s.request().json()["items"][0]
    middle = s.request(start="2026-11-20").json()["items"][0]
    last = s.request(start="2026-12-20").json()["items"][0]
    assert old["latest_lesson"]["id"] == middle["latest_lesson"]["id"] == str(c.id)
    assert old["latest_lesson"]["status"] == terminal_status
    assert old["previous_lesson"] is None
    assert middle["previous_lesson"]["id"] == str(a.id)
    assert last["previous_lesson"]["id"] == str(b.id)
    assert last["latest_lesson"] is None


def test_schedule_never_exposes_related_positions_assigned_only_to_another_group(schedule):
    s = schedule
    a = s.lesson(status="moved")
    b = s.lesson("2026-12-20T09:00:00+03:00", previous_lesson_id=a.id, assigned=s.groups[1:])
    assert s.request().json()["items"][0]["latest_lesson"] is None
    assert s.request(1, start="2026-12-20").json()["items"][0]["previous_lesson"] is None
    assert str(b.id) not in [i["id"] for i in s.request().json()["items"]]


def test_schedule_query_count_does_not_grow_with_lessons_rooms_groups_or_move_depth(
    schedule, monkeypatch
):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromisoformat("2026-11-18T12:00:00+03:00").astimezone(tz)

    monkeypatch.setattr("app.schedule.service.datetime", Clock)
    s = schedule
    a = s.lesson(status="moved")
    s.lesson("2026-11-20T09:00:00+03:00", previous_lesson_id=a.id)
    s.lesson()  # Exercise the two batched personal reads at both sizes.

    def count_queries():
        statements = []

        def record(conn, cursor, statement, params, context, many):
            statements.append(statement)

        event.listen(s.db.bind, "before_cursor_execute", record)
        try:
            response = s.request()
            assert response.status_code == 200, response.text
        finally:
            event.remove(s.db.bind, "before_cursor_execute", record)
        return len(statements)

    small = count_queries()
    for _ in range(20):
        root = s.lesson(status="moved", assigned=s.groups, room_ids=[r.id for r in s.rooms])
        mid = s.lesson(previous_lesson_id=root.id, status="moved")
        s.lesson(previous_lesson_id=mid.id)
    assert count_queries() == small + 1  # one batched predecessors query now needed
    assert small == 9  # 2 auth, list, groups, rooms, chain, marks, works, membership


def test_schedule_authentication_and_role_are_checked_on_every_request(schedule):
    s = schedule
    assert (
        s.client.get("/api/v1/schedule?date_from=2026-11-10&date_to=2026-11-10").status_code == 401
    )
    assert s.request(2).status_code == 403
    s.users[0].is_active = False
    s.db.flush()
    assert s.request().status_code == 401
    s.users[0].is_active = True
    s.db.delete(s.students[0])
    s.db.flush()
    assert s.request().status_code == 403


@pytest.mark.parametrize(
    "values",
    [
        {"kind": "exam"},
        {"status": "unknown"},
        {"version": 0},
        {"end": "2026-11-10T00:00:00+00:00"},
    ],
)
def test_schedule_database_rejects_invalid_lesson_values(schedule, values):
    s = schedule
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.lesson(**values)


def test_schedule_database_rejects_fork_self_reference_and_duplicate_assignments(schedule):
    s = schedule
    a = s.lesson(status="moved")
    s.lesson(previous_lesson_id=a.id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.lesson(previous_lesson_id=a.id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        a.previous_lesson_id = a.id
        s.db.flush()
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(LessonGroup, lesson_id=a.id, group_id=s.groups[0].id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(
            CourseOffering,
            discipline_id=s.discipline.id,
            term_id=s.term.id,
            attestation_type="other",
        )
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(Room, building_id=s.buildings[0].id, name=s.rooms[0].name)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(
            AcademicTerm,
            name="Неверный период",
            starts_on=date(2026, 2, 1),
            ends_on=date(2026, 1, 1),
        )


def test_schedule_damaged_cyclic_import_terminates_without_leaking_positions(schedule):
    s = schedule
    a = s.lesson(status="moved")
    b = s.lesson(previous_lesson_id=a.id, status="moved")
    a.previous_lesson_id = b.id
    s.db.flush()
    s.db.execute(text("SET LOCAL statement_timeout = '2s'"))
    result = list_student_schedule(
        s.db, s.groups[0].id, ScheduleParams(date_from="2026-11-10", date_to="2026-11-10")
    )
    assert len(result.items) == 2
    assert all(item.latest_lesson is None for item in result.items)


def test_schedule_resolves_deep_moves_with_one_recursive_query(schedule):
    s = schedule
    root = s.lesson(status="moved")
    previous = root
    for _ in range(25):
        previous = s.lesson(
            "2026-12-20T09:00:00+03:00", status="moved", previous_lesson_id=previous.id
        )
    terminal = s.lesson("2027-01-20T09:00:00+03:00", previous_lesson_id=previous.id)
    result = s.request().json()["items"]
    assert len(result) == 1
    assert result[0]["latest_lesson"]["id"] == str(terminal.id)
    assert s.request(start="2027-01-20").json()["items"][0]["previous_lesson"]["id"] == str(
        previous.id
    )


def test_schedule_resolves_authorized_terminal_after_intermediate_group_reassignment(schedule):
    s = schedule
    root = s.lesson(status="moved")
    middle = s.lesson(
        "2026-11-20T09:00:00+03:00",
        previous_lesson_id=root.id,
        status="moved",
        assigned=s.groups[1:],
    )
    terminal = s.lesson("2026-12-20T09:00:00+03:00", previous_lesson_id=middle.id)
    assert s.request().json()["items"][0]["latest_lesson"]["id"] == str(terminal.id)
    assert s.request(start="2026-11-20").json()["items"] == []
    assert s.request(1, start="2026-11-20").json()["items"][0]["latest_lesson"] is None
    assert s.request(start="2026-12-20").json()["items"][0]["previous_lesson"] is None


def test_schedule_single_move_retains_immediate_predecessor_outside_week(schedule):
    s = schedule
    a = s.lesson(status="moved")
    b = s.lesson("2027-01-03T00:30:00+03:00", previous_lesson_id=a.id)
    old = s.request().json()["items"][0]
    current = s.request(start="2027-01-03").json()["items"][0]
    assert old["latest_lesson"] == {
        "id": str(b.id),
        "starts_at": "2027-01-02T21:30:00Z",
        "ends_at": "2027-01-02T22:30:00Z",
        "status": "scheduled",
    }
    assert current["previous_lesson"]["id"] == str(a.id)
    assert current["latest_lesson"] is None
    assert current["status"] == "scheduled"
    assert s.request(1, start="2027-01-03").json()["items"] == []
