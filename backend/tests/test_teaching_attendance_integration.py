"""Protected teacher attendance reads over real PostgreSQL/API boundaries."""

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select
from test_teaching_integration import journal as journal_fixture

from app.attendance.router import router as attendance_router
from app.models import (
    Attendance,
    AuditEvent,
    AuthSession,
    Lesson,
    LessonGroup,
    Student,
    Subgroup,
    User,
)
from app.student_service import update_student_group
from app.teaching.ordering import NAME_KEY_SOURCE, NAME_KEY_TARGET, get_student_name_key

pytestmark = pytest.mark.integration


@pytest.fixture
def teaching_attendance(db_session):
    s = journal_fixture.__wrapped__(db_session)
    s.client = TestClient(s.app)
    s.app.include_router(attendance_router)
    extra_user = s.add(
        User,
        login="teacher-attendance-extra-student",
        password_hash="unused",
        full_name="Неотмеченный студент",
        role="student",
        is_active=True,
    )
    s.students.append(
        s.add(
            Student,
            user_id=extra_user.id,
            group_id=s.groups[0].id,
            academic_status="enrolled",
        )
    )
    s.lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        teacher_id=s.teachers[2].id,
        starts_at=datetime.now(UTC),
        ends_at=datetime.now(UTC) + timedelta(minutes=60),
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[0].id)

    def path(group=0, lesson=None):
        return (
            f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[group].id}"
            f"/lessons/{(lesson or s.lesson).id}/attendance"
        )

    def read(teacher=0, group=0, lesson=None, **params):
        return s.client.get(
            path(group, lesson),
            params=params,
            headers={"Authorization": f"Bearer {s.teacher_tokens[teacher]}"},
        )

    def write(status, student=0, lesson=None, method="put"):
        lesson_id = (lesson or s.lesson).id
        student_id = s.students[student].id
        suffix = f"/api/v1/attendance/lessons/{lesson_id}/students/{student_id}"
        return getattr(s.client, method)(
            suffix,
            headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"},
            **({"json": {"status": status}} if method == "put" else {}),
        )

    s.path, s.read, s.write = path, read, write
    return s


def test_teacher_reads_attended_absent_unmarked_and_delete(teaching_attendance):
    s = teaching_attendance
    assert s.write("attended").status_code == 200
    assert s.write("absent", student=2).status_code == 200
    response = s.read()
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    rows = {row["student_id"]: row for row in response.json()["items"]}
    assert rows[str(s.students[0].id)]["status"] == "attended"
    assert rows[str(s.students[2].id)]["status"] == "absent"
    assert rows[str(s.students[2].id)]["updated_at"] is not None
    assert rows[str(s.students[0].id)]["updated_at"] is not None
    assert rows[str(s.students[0].id)]["can_edit"] is True
    assert rows[str(s.students[3].id)]["status"] == "unmarked"
    assert rows[str(s.students[3].id)]["updated_at"] is None

    # Reads return persisted state without touching attendance or audit rows.
    before = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    before_state = (
        before.status,
        before.updated_at,
        before.origin_group_id,
        before.membership_version,
    )
    audits_before = s.db.scalar(select(func.count()).select_from(AuditEvent))
    assert s.read(student_id=str(s.students[0].id)).json()["items"][0]["student_id"] == str(
        s.students[0].id
    )
    s.db.expire_all()
    after = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert (
        after.status,
        after.updated_at,
        after.origin_group_id,
        after.membership_version,
    ) == before_state
    assert s.db.scalar(select(func.count()).select_from(AuditEvent)) == audits_before

    assert s.write(None, method="delete").status_code == 200
    reloaded = {row["student_id"]: row for row in s.read().json()["items"]}
    assert reloaded[str(s.students[0].id)]["status"] == "unmarked"
    assert reloaded[str(s.students[0].id)]["updated_at"] is None


def test_teacher_scope_shared_lesson_and_foreign_ids(teaching_attendance):
    s = teaching_attendance
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[1].id)
    assert s.read().status_code == 200
    assert {row["student_id"] for row in s.read().json()["items"]} == {
        str(student.id) for student in s.students if student.group_id == s.groups[0].id
    }
    assert s.read(group=1).status_code == 404
    assert s.read(teacher=2).status_code == 404
    assert s.read(teacher=1, group=1).status_code == 200
    wrong_course = s.client.get(
        f"/api/v1/teaching/courses/{s.courses[1].id}/groups/{s.groups[0].id}"
        f"/lessons/{s.lesson.id}/attendance",
        headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"},
    )
    assert wrong_course.status_code == 404
    response = s.client.get(
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        "/lessons/9223372036854775807/attendance",
        headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"},
    )
    assert response.status_code == 404
    assert s.read(student_id=str(s.students[1].id)).json()["items"] == []
    assert s.read(student_id="9223372036854775807").json()["items"] == []
    repeated = s.client.get(
        s.path(),
        params=[("limit", "1"), ("limit", "2")],
        headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"},
    )
    assert repeated.status_code == 422
    s.db.delete(s.grants[0])
    s.db.flush()
    assert s.read().status_code == 404


def test_legacy_attendance_without_membership_metadata_is_unmarked_and_immutable(
    teaching_attendance,
):
    s = teaching_attendance
    legacy = s.add(
        Attendance,
        lesson_id=s.lesson.id,
        student_id=s.students[0].id,
        status="attended",
        marked_by_user_id=s.teacher_users[0].id,
        origin_group_id=None,
        origin_subgroup_id=None,
        membership_version=None,
        updated_at=datetime.now(UTC) - timedelta(days=1),
    )
    s.db.flush()
    original = (
        legacy.status,
        legacy.updated_at,
        legacy.origin_group_id,
        legacy.origin_subgroup_id,
        legacy.membership_version,
    )
    audits_before = s.db.scalar(select(func.count()).select_from(AuditEvent))
    response = s.read()
    assert response.status_code == 200, response.text
    row = next(
        item for item in response.json()["items"] if item["student_id"] == str(s.students[0].id)
    )
    assert row["status"] == "unmarked"
    assert row["updated_at"] is None
    assert row["can_edit"] is False
    s.db.expire_all()
    preserved = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert (
        preserved.status,
        preserved.updated_at,
        preserved.origin_group_id,
        preserved.origin_subgroup_id,
        preserved.membership_version,
    ) == original
    assert s.db.scalar(select(func.count()).select_from(AuditEvent)) == audits_before


@pytest.mark.parametrize(
    "key",
    [
        ["ru-v1:\x00bad", 1],
        ["ru-v1:\ud800", 1],
        ["wrong-prefix", 1],
        [1, 1],
        ["ru-v1:а"],
        ["ru-v1:а", 1, 2],
        ["ru-v1:а", 2**63],
    ],
)
def test_invalid_attendance_cursors_return_422(teaching_attendance, key):
    s = teaching_attendance
    token = (
        base64.urlsafe_b64encode(
            json.dumps({"v": 2, "direction": "asc", "key": key}, separators=(",", ":")).encode()
        )
        .decode()
        .rstrip("=")
    )
    response = s.read(cursor=token)
    assert response.status_code == 422, response.text


def test_teacher_roster_respects_subgroups_and_current_membership(teaching_attendance):
    s = teaching_attendance
    first = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    second = s.add(Subgroup, group_id=s.groups[0].id, name="B")
    lesson_group = s.db.scalar(select(LessonGroup).where(LessonGroup.lesson_id == s.lesson.id))
    lesson_group.subgroup_id = first.id
    s.students[0].subgroup_id = first.id
    s.students[2].subgroup_id = second.id
    s.db.flush()
    s.lesson.starts_at = datetime.now(UTC)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    s.db.flush()
    data = s.read().json()["items"]
    assert [row["student_id"] for row in data] == [str(s.students[0].id)]

    # A mark from the prior membership period remains stored, but never resurfaces
    # after changing subgroups and then returning to the original subgroup.
    assert s.write("attended").status_code == 200
    stored = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    stored_state = (
        stored.status,
        stored.updated_at,
        stored.origin_group_id,
        stored.origin_subgroup_id,
    )
    update_student_group(s.db, s.students[0].id, s.groups[0].id, second.id)
    assert str(s.students[0].id) not in {row["student_id"] for row in s.read().json()["items"]}
    update_student_group(s.db, s.students[0].id, s.groups[0].id, first.id)
    row = s.read().json()["items"][0]
    assert row["status"] == "unmarked"
    assert row["updated_at"] is None
    assert row["can_edit"] is False
    stored = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert (
        stored.status,
        stored.updated_at,
        stored.origin_group_id,
        stored.origin_subgroup_id,
    ) == stored_state


def test_teacher_attendance_hides_historical_mark_after_group_transfer_and_return(
    teaching_attendance,
):
    s = teaching_attendance
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[1].id)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    s.db.flush()

    student = s.students[0]
    assert student.group_id == s.groups[0].id
    membership_version_before = student.membership_version
    assert s.write("attended", student=0).status_code == 200
    attendance = s.db.get(Attendance, (s.lesson.id, student.id))
    original_mark = (
        attendance.status,
        attendance.updated_at,
        attendance.origin_group_id,
        attendance.origin_subgroup_id,
        attendance.membership_version,
    )

    update_student_group(s.db, student.id, s.groups[1].id)
    s.db.refresh(student)
    assert student.group_id == s.groups[1].id
    assert student.membership_version > membership_version_before
    teacher_a_rows = s.read(teacher=0, group=0).json()["items"]
    assert str(student.id) not in {row["student_id"] for row in teacher_a_rows}

    teacher_b_response = s.read(teacher=1, group=1)
    assert teacher_b_response.status_code == 200, teacher_b_response.text
    teacher_b_rows = {row["student_id"]: row for row in teacher_b_response.json()["items"]}
    transferred = teacher_b_rows[str(student.id)]
    assert transferred["status"] == "unmarked"
    assert transferred["updated_at"] is None
    assert transferred["can_edit"] is False

    filtered = s.read(teacher=1, group=1, student_id=str(student.id))
    assert filtered.status_code == 200, filtered.text
    assert len(filtered.json()["items"]) == 1
    assert filtered.json()["items"][0]["student_id"] == str(student.id)
    assert filtered.json()["items"][0]["status"] == "unmarked"
    assert filtered.json()["items"][0]["updated_at"] is None
    assert filtered.json()["items"][0]["can_edit"] is False

    update_student_group(s.db, student.id, s.groups[0].id)
    s.db.refresh(student)
    assert student.group_id == s.groups[0].id
    assert student.membership_version > membership_version_before
    returned_rows = {row["student_id"]: row for row in s.read(teacher=0, group=0).json()["items"]}
    returned = returned_rows[str(student.id)]
    assert returned["status"] == "unmarked"
    assert returned["updated_at"] is None
    assert returned["can_edit"] is False

    s.db.expire_all()
    preserved = s.db.get(Attendance, (s.lesson.id, student.id))
    assert (
        preserved.status,
        preserved.updated_at,
        preserved.origin_group_id,
        preserved.origin_subgroup_id,
        preserved.membership_version,
    ) == original_mark


def test_current_role_and_session_are_checked_with_old_jwt(teaching_attendance):
    s = teaching_attendance
    with s.db.begin_nested():
        s.teacher_users[0].role = "staff"
        s.db.flush()
        assert s.read().status_code == 403

    teacher_session = s.db.scalar(
        select(AuthSession).where(AuthSession.user_id == s.teacher_users[0].id)
    )
    teacher_session.revoked_at = datetime.now(UTC)
    s.db.flush()
    assert s.read().status_code == 401


@pytest.mark.parametrize("state", ["cancelled", "moved"])
def test_cancelled_and_moved_lessons_are_not_editable(teaching_attendance, state):
    s = teaching_attendance
    assert s.write("attended").status_code == 200
    original = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    original_state = (original.status, original.updated_at)
    s.lesson.status = state
    s.db.flush()
    rows = {row["student_id"]: row for row in s.read().json()["items"]}
    assert all(not row["can_edit"] for row in rows.values())
    assert rows[str(s.students[0].id)]["status"] == "attended"
    assert (
        datetime.fromisoformat(rows[str(s.students[0].id)]["updated_at"].replace("Z", "+00:00"))
        == original_state[1]
    )
    current = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert (current.status, current.updated_at) == original_state


@pytest.mark.parametrize("when", ["past", "today", "future"])
def test_teacher_can_mark_scheduled_lessons_regardless_of_date(teaching_attendance, when):
    s = teaching_attendance
    assert s.write("attended").status_code == 200
    now = datetime.now(UTC)
    starts_at = {
        "past": now - timedelta(days=1),
        "today": now + timedelta(minutes=5),
        "future": now + timedelta(days=1),
    }[when]
    s.lesson.starts_at = starts_at
    s.lesson.ends_at = starts_at + timedelta(minutes=60)
    s.db.flush()

    initial = {row["student_id"]: row for row in s.read().json()["items"]}
    assert initial[str(s.students[0].id)]["can_edit"] is True
    assert s.write("absent").status_code == 200
    assert s.read(student_id=str(s.students[0].id)).json()["items"][0]["status"] == "absent"
    if when != "past":
        assert s.write("attended", student=3).status_code == 200
        assert s.read(student_id=str(s.students[3].id)).json()["items"][0]["status"] == "attended"
    assert s.write(None, method="delete").status_code == 200
    assert s.read(student_id=str(s.students[0].id)).json()["items"][0]["status"] == "unmarked"


def test_attendance_journal_uses_constant_sql_count_and_russian_keyset(teaching_attendance):
    s = teaching_attendance
    names = ["Ёжов", "Ежов", "Андреев", "Ежов"] + [f"Студент {index:03}" for index in range(150)]
    for name in names:
        user = s.add(
            User,
            login=f"student-{len(s.students)}-{name}",
            password_hash="unused",
            full_name=name,
            role="student",
            is_active=True,
        )
        s.students.append(
            s.add(
                Student,
                user_id=user.id,
                group_id=s.groups[0].id,
                academic_status="enrolled",
            )
        )
    expected = s.db.execute(
        select(Student.id, User.full_name)
        .join(User, User.id == Student.user_id)
        .where(Student.group_id == s.groups[0].id)
        .order_by(get_student_name_key(User.full_name), Student.id)
    ).all()
    expected_ids = [str(row.id) for row in expected]
    queries = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(statement)

    event.listen(s.db.bind, "before_cursor_execute", record)
    try:
        all_ids = []
        for limit in (1, 20):
            cursor = None
            page_ids = []
            while True:
                response = s.read(limit=limit, **({"cursor": cursor} if cursor else {}))
                assert response.status_code == 200, response.text
                page = response.json()
                page_ids.extend(row["student_id"] for row in page["items"])
                cursor = page["next_cursor"]
                if cursor is None:
                    break
            assert len(page_ids) == len(set(page_ids))
            assert page_ids == expected_ids
            all_ids = page_ids
        attendance_queries = [
            query
            for query in queries
            if "from students" in query.lower() and "attendance" in query.lower()
        ]
        assert len(queries) <= len(attendance_queries) * 8 + 8
        expected_page_count = sum((len(all_ids) + limit - 1) // limit for limit in (1, 20))
        assert len(attendance_queries) == expected_page_count
        assert all("LIMIT" in query.upper() for query in attendance_queries)
        assert len(all_ids) == len(set(all_ids))
        transliteration = str.maketrans(NAME_KEY_SOURCE, NAME_KEY_TARGET)
        assert [(row.full_name.translate(transliteration), row.id) for row in expected] == sorted(
            (row.full_name.translate(transliteration), row.id) for row in expected
        )
        ordered_names = [row.full_name for row in expected]
        assert ordered_names.index("Ежов") < ordered_names.index("Ёжов")
    finally:
        event.remove(s.db.bind, "before_cursor_execute", record)
