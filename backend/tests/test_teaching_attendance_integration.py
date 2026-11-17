"""Protected teacher attendance reads over real PostgreSQL/API boundaries."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from test_teaching_integration import journal as journal_fixture

from app.attendance.router import router as attendance_router
from app.models import Attendance, AuthSession, Lesson, LessonGroup, Student, Subgroup, User
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
    # as a current mark after leaving and returning to the same group/subgroup.
    assert s.write("attended").status_code == 200
    update_student_group(s.db, s.students[0].id, s.groups[1].id)
    assert str(s.students[0].id) not in {row["student_id"] for row in s.read().json()["items"]}
    update_student_group(s.db, s.students[0].id, s.groups[0].id, first.id)
    row = s.read().json()["items"][0]
    assert row["status"] == "unmarked"
    assert row["updated_at"] is None
    assert row["can_edit"] is False
    assert s.db.get(Attendance, (s.lesson.id, s.students[0].id)) is not None


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


@pytest.mark.parametrize("state", ["future", "cancelled", "moved"])
def test_can_edit_is_false_for_future_cancelled_and_moved_lessons(teaching_attendance, state):
    s = teaching_attendance
    if state == "future":
        s.lesson.starts_at = datetime.now(UTC) + timedelta(hours=1)
        s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    else:
        s.lesson.status = state
    s.db.flush()
    assert all(not row["can_edit"] for row in s.read().json()["items"])


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
    queries = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(statement)

    event.listen(s.db.bind, "before_cursor_execute", record)
    try:
        cursor = None
        all_ids = []
        while True:
            response = s.read(limit=25, **({"cursor": cursor} if cursor else {}))
            assert response.status_code == 200, response.text
            page = response.json()
            all_ids.extend(row["student_id"] for row in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        attendance_queries = [
            query
            for query in queries
            if "from students" in query.lower() and "attendance" in query.lower()
        ]
        page_count = (len(all_ids) + 24) // 25
        assert len(queries) <= page_count * 8 + 8
        assert len(attendance_queries) == page_count
        assert all("LIMIT" in query.upper() for query in attendance_queries)
        assert len(all_ids) == len(set(all_ids))
        expected = s.db.execute(
            select(Student.id, User.full_name)
            .join(User, User.id == Student.user_id)
            .where(Student.group_id == s.groups[0].id)
            .order_by(get_student_name_key(User.full_name), Student.id)
        ).all()
        expected_ids = [str(row.id) for row in expected]
        assert all_ids == expected_ids
        transliteration = str.maketrans(NAME_KEY_SOURCE, NAME_KEY_TARGET)
        assert [(row.full_name.translate(transliteration), row.id) for row in expected] == sorted(
            (row.full_name.translate(transliteration), row.id) for row in expected
        )
        ordered_names = [row.full_name for row in expected]
        assert ordered_names.index("Ежов") < ordered_names.index("Ёжов")
    finally:
        event.remove(s.db.bind, "before_cursor_execute", record)
