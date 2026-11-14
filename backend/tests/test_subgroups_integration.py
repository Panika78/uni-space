import pytest
from sqlalchemy import event, select, text
from sqlalchemy.exc import IntegrityError
from test_schedule_integration import schedule as schedule_fixture  # noqa: F401

from app.models import LessonGroup, Student, Subgroup
from app.schedule.participants import Participant, replace_lesson_participants
from app.student_service import update_student_group

pytestmark = pytest.mark.integration


@pytest.fixture
def subgroups(schedule_fixture):  # noqa: F811
    s = schedule_fixture
    s.a, s.b = [s.add(Subgroup, group_id=s.groups[0].id, name=name) for name in ("А", "Б")]
    s.foreign = s.add(Subgroup, group_id=s.groups[1].id, name="А")
    update_student_group(s.db, s.students[0].id, s.groups[0].id, s.a.id)
    update_student_group(s.db, s.students[1].id, s.groups[0].id, s.b.id)

    def assign(lesson, *subgroup_ids):
        replace_lesson_participants(
            s.db, lesson.id, [Participant(s.groups[0].id, value) for value in subgroup_ids]
        )
        return lesson

    s.assign = assign
    return s


def test_subgroups_filter_authenticated_api_and_deduplicate_groups(subgroups):
    s = subgroups
    common = s.lesson()
    own = s.assign(s.lesson(assigned=[]), s.a.id)
    other = s.assign(s.lesson(assigned=[]), s.b.id)
    both = s.assign(s.lesson(assigned=[]), s.a.id, s.b.id)
    for index, expected in [(0, [common, own, both]), (1, [common, other, both])]:
        response = s.request(index)
        assert response.status_code == 200
        assert [i["id"] for i in response.json()["items"]] == [str(i.id) for i in expected]
        assert all(len(i["groups"]) == 1 for i in response.json()["items"])
    assert s.request(subgroup_id=s.b.id).status_code == 422
    assert s.request(student_id=s.students[1].id).status_code == 422
    assert s.request(group_id=s.groups[1].id).status_code == 422
    update_student_group(s.db, s.students[0].id, s.groups[0].id)
    assert [i["id"] for i in s.request().json()["items"]] == [str(common.id)]


@pytest.mark.parametrize("terminal_status", ["scheduled", "cancelled"])
def test_subgroup_moves_authorize_every_exposed_position(subgroups, terminal_status):
    s = subgroups
    root = s.assign(s.lesson(status="moved", assigned=[]), s.a.id)
    middle = s.assign(
        s.lesson(
            "2026-11-20T09:00:00+03:00", previous_lesson_id=root.id, status="moved", assigned=[]
        ),
        s.b.id,
    )
    terminal = s.assign(
        s.lesson(
            "2026-12-20T09:00:00+03:00",
            previous_lesson_id=middle.id,
            status=terminal_status,
            assigned=[],
        ),
        s.a.id,
    )
    assert s.request().json()["items"][0]["latest_lesson"]["id"] == str(terminal.id)
    assert s.request(1).json()["items"] == []
    assert s.request(start="2026-11-20").json()["items"] == []
    foreign_middle = s.request(1, start="2026-11-20").json()["items"][0]
    assert foreign_middle["previous_lesson"] is None
    assert foreign_middle["latest_lesson"] is None
    assert s.request(start="2026-12-20").json()["items"][0]["previous_lesson"] is None
    # Reassigning the terminal cannot leak its ID or times from the old root.
    s.assign(terminal, s.b.id)
    assert s.request().json()["items"][0]["latest_lesson"] is None
    update_student_group(s.db, s.students[0].id, s.groups[0].id)
    assert s.request().json()["items"] == []


@pytest.mark.parametrize("table", ["students", "lesson_groups"])
def test_composite_fk_rejects_invalid_subgroup_on_insert_and_update(subgroups, table):
    s = subgroups
    lesson = s.assign(s.lesson(assigned=[]), s.a.id)
    row = (
        s.students[0]
        if table == "students"
        else s.db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == lesson.id)).one()
    )
    for column, value in [
        ("subgroup_id", s.foreign.id),
        ("group_id", s.groups[1].id),
        ("subgroup_id", 9223372036854775807),
    ]:
        with pytest.raises(IntegrityError), s.db.begin_nested():
            s.db.execute(
                text(f"UPDATE {table} SET {column}=:value WHERE id=:id"),
                {"value": value, "id": row.id},
            )
    with pytest.raises(IntegrityError), s.db.begin_nested():
        if table == "students":
            # Use a third user with no student profile.
            s.add(
                Student,
                user_id=s.teacher_user.id,
                group_id=s.groups[0].id,
                subgroup_id=s.foreign.id,
                academic_status="enrolled",
            )
        else:
            s.add(
                LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id, subgroup_id=s.foreign.id
            )
    # Parent reassignment/deletion cannot invalidate dependants either.
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("UPDATE subgroups SET group_id=:group WHERE id=:id"),
            {"group": s.groups[1].id, "id": s.a.id},
        )
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(text("DELETE FROM subgroups WHERE id=:id"), {"id": s.a.id})


def test_database_uniqueness_allows_two_subgroups_but_rejects_exact_duplicates(subgroups):
    s = subgroups
    lesson = s.assign(s.lesson(assigned=[]), s.a.id, s.b.id)
    for subgroup_id in (s.a.id, s.b.id):
        with pytest.raises(IntegrityError), s.db.begin_nested():
            s.add(
                LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id, subgroup_id=subgroup_id
            )
    common = s.lesson()
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.add(LessonGroup, lesson_id=common.id, group_id=s.groups[0].id)


@pytest.mark.parametrize("values", ["duplicate", "overlap", "foreign", "unknown", "course"])
def test_service_rejects_invalid_assignment_set_before_mutation(subgroups, values):
    s = subgroups
    lesson = s.lesson()
    group = s.groups[0].id
    invalid = {
        "duplicate": [Participant(group, s.a.id)] * 2,
        "overlap": [Participant(group), Participant(group, s.a.id)],
        "foreign": [Participant(group, s.foreign.id)],
        "unknown": [Participant(group, 9223372036854775807)],
        "course": [Participant(9223372036854775807)],
    }[values]
    with pytest.raises(ValueError):
        replace_lesson_participants(s.db, lesson.id, invalid)
    rows = s.db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == lesson.id)).all()
    assert [(r.group_id, r.subgroup_id) for r in rows] == [(group, None)]


def test_student_group_change_is_one_update_and_rolls_back_both_fields(subgroups):
    s = subgroups
    student = s.students[0]
    statements = []

    def record(conn, cursor, statement, params, context, many):
        if statement.startswith("UPDATE students"):
            statements.append(statement)

    event.listen(s.db.bind, "before_cursor_execute", record)
    try:
        with s.db.begin_nested() as savepoint:
            update_student_group(s.db, student.id, s.groups[1].id, s.foreign.id)
            assert (student.group_id, student.subgroup_id) == (s.groups[1].id, s.foreign.id)
            savepoint.rollback()
        assert (student.group_id, student.subgroup_id) == (s.groups[0].id, s.a.id)
        assert len(statements) == 1
        assert "group_id=" in statements[0] and "subgroup_id=" in statements[0]
    finally:
        event.remove(s.db.bind, "before_cursor_execute", record)
    with pytest.raises(ValueError):
        update_student_group(s.db, student.id, s.groups[1].id, s.a.id)
    assert (student.group_id, student.subgroup_id) == (s.groups[0].id, s.a.id)
    update_student_group(s.db, student.id, s.groups[1].id)
    assert (student.group_id, student.subgroup_id) == (s.groups[1].id, None)
    assert s.request().json()["items"] == []


def test_subgroup_schedule_query_count_is_constant(subgroups):
    s = subgroups

    def count():
        statements = []

        def record(conn, cursor, statement, params, context, many):
            statements.append(statement)

        event.listen(s.db.bind, "before_cursor_execute", record)
        try:
            assert s.request().status_code == 200
        finally:
            event.remove(s.db.bind, "before_cursor_execute", record)
        return len(statements)

    def chain():
        root = s.assign(s.lesson(assigned=[], status="moved"), s.a.id, s.b.id)
        middle = s.assign(s.lesson(assigned=[], status="moved", previous_lesson_id=root.id), s.b.id)
        s.assign(s.lesson(assigned=[], previous_lesson_id=middle.id), s.a.id, s.b.id)

    chain()
    small = count()
    for _ in range(20):
        chain()
    assert count() == small == 7


def test_unknown_distribution_authorizes_common_move_positions_only(subgroups):
    s = subgroups
    root = s.lesson(status="moved")
    middle = s.assign(
        s.lesson(
            "2026-11-20T09:00:00+03:00", previous_lesson_id=root.id, status="moved", assigned=[]
        ),
        s.a.id,
    )
    terminal = s.lesson("2026-12-20T09:00:00+03:00", previous_lesson_id=middle.id)
    update_student_group(s.db, s.students[0].id, s.groups[0].id)
    assert s.request().json()["items"][0]["latest_lesson"]["id"] == str(terminal.id)
    assert s.request(start="2026-11-20").json()["items"] == []
    assert s.request(start="2026-12-20").json()["items"][0]["previous_lesson"] is None
    s.assign(terminal, s.a.id)
    assert s.request().json()["items"][0]["latest_lesson"] is None


def test_student_group_change_refreshes_stale_membership_under_lock(subgroups):
    s = subgroups
    student = s.students[0]
    update_student_group(s.db, student.id, s.groups[0].id)
    # Simulate a stale identity-map value left by a different writer. The locked
    # SELECT must refresh it so ORM dirty tracking includes clearing subgroup_id.
    s.db.execute(
        text("UPDATE students SET subgroup_id=:subgroup WHERE id=:student"),
        {"subgroup": s.a.id, "student": student.id},
    )
    assert student.subgroup_id is None
    update_student_group(s.db, student.id, s.groups[1].id)
    row = s.db.execute(
        text("SELECT group_id, subgroup_id FROM students WHERE id=:id"), {"id": student.id}
    ).one()
    assert tuple(row) == (s.groups[1].id, None)


def test_student_group_change_preserves_other_pending_student_changes(subgroups):
    s = subgroups
    student = s.students[0]
    student.academic_status = "academic_leave"
    update_student_group(s.db, student.id, s.groups[1].id)
    s.db.expire(student)
    assert (student.group_id, student.subgroup_id) == (s.groups[1].id, None)
    assert student.academic_status == "academic_leave"


def test_shared_lesson_combines_subgroup_and_other_whole_group(subgroups):
    s = subgroups
    lesson = s.lesson(assigned=[])
    replace_lesson_participants(
        s.db, lesson.id, [Participant(s.groups[0].id, s.a.id), Participant(s.groups[1].id)]
    )
    assert s.request(1).json()["items"] == []  # B is excluded despite shared course_groups.
    update_student_group(s.db, s.students[1].id, s.groups[1].id, s.foreign.id)
    for index in (0, 1):
        items = s.request(index).json()["items"]
        assert [item["id"] for item in items] == [str(lesson.id)]
        assert len(items[0]["groups"]) == 2
