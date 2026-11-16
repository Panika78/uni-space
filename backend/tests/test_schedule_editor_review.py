"""Independent-review regressions, using real PostgreSQL."""

from datetime import date

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.exc import IntegrityError
from test_assessed_lesson_participants import add_assessment, link_assessment
from test_schedule_editor_integration import create, editor  # noqa: F401
from test_schedule_integration import schedule  # noqa: F401

from app.models import Lesson

pytestmark = pytest.mark.integration


def test_used_course_group_cannot_be_removed_without_assessments(schedule):  # noqa: F811
    s = schedule
    s.lesson()
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("DELETE FROM course_groups WHERE course_offering_id=:c AND group_id=:g"),
            {"c": s.offering.id, "g": s.groups[0].id},
        )


@pytest.mark.parametrize("table", ["lesson_groups", "lesson_rooms"])
def test_raw_child_change_invalidates_api_snapshot(editor, table):  # noqa: F811
    e = editor
    item = create(e)
    e.db.execute(text(f"DELETE FROM {table} WHERE lesson_id=:id"), {"id": int(item["id"])})
    e.db.commit()
    result = e.request_editor("PATCH", f"/lessons/{item['id']}", e.payload(version=item["version"]))
    assert result.status_code == 409, result.text
    assert e.db.get(Lesson, int(item["id"]), populate_existing=True).version == item["version"] + 1


@pytest.mark.parametrize("changes", [{}, {"room_ids": []}, {"teacher_id": None}])
def test_move_requires_changed_time_without_side_effects(editor, changes):  # noqa: F811
    e = editor
    item = create(e)
    lesson = e.db.get(Lesson, int(item["id"]))
    work = link_assessment(e.db, add_assessment(e.db, lesson).id, lesson.id, e.groups[0].id)
    work.planned_date = date(2026, 11, 10)
    e.db.commit()
    before = e.db.scalar(text("SELECT count(*) FROM audit_events"))
    result = e.request_editor(
        "POST", f"/lessons/{item['id']}/move", e.payload(version=1, **changes)
    )
    assert result.status_code == 409, result.text
    assert e.request_editor("GET", f"/lessons/{item['id']}").json() == item
    assert e.db.scalar(text("SELECT count(*) FROM audit_events")) == before
    e.db.refresh(work)
    assert work.lesson_id == lesson.id and work.date_needs_confirmation is False
    assert work.planned_date == date(2026, 11, 10)
    assert (
        e.db.scalar(select(Lesson.id).where(Lesson.previous_lesson_id == int(item["id"]))) is None
    )


def test_schedule_batches_queries_and_pages_chronologically(editor):  # noqa: F811
    e = editor
    items = [
        create(
            e, starts_at=f"2026-11-{day}T09:00:00+03:00", ends_at=f"2026-11-{day}T10:00:00+03:00"
        )
        for day in (13, 11, 12)
    ]
    params = {
        "resource": "group",
        "resource_id": str(e.groups[0].id),
        "date_from": "2026-11-10",
        "date_to": "2026-11-14",
    }
    queries = []

    def count(*args):
        queries.append(args[2])

    counts = []
    event.listen(e.db.bind, "before_cursor_execute", count)
    try:
        for limit in (1, 3):
            queries.clear()
            result = e.request_editor("GET", params=params | {"limit": limit})
            assert result.status_code == 200, result.text
            counts.append(len(queries))
    finally:
        event.remove(e.db.bind, "before_cursor_execute", count)
    assert counts[1] <= counts[0] + 1
    seen = []
    while True:
        result = e.request_editor("GET", params=params | {"limit": 1}).json()
        seen.extend(i["id"] for i in result["items"])
        if result["next_after_id"] is None:
            break
        params["after_id"] = result["next_after_id"]
    assert seen == [items[i]["id"] for i in (1, 2, 0)]


@pytest.mark.parametrize("operation", ["DELETE", "UPDATE"])
def test_course_group_key_changes_only_reject_used_membership(schedule, operation):  # noqa: F811
    s = schedule
    s.lesson()
    with pytest.raises(IntegrityError), s.db.begin_nested():
        sql = (
            "DELETE FROM course_groups WHERE course_offering_id=:c AND group_id=:g"
            if operation == "DELETE"
            else "UPDATE course_groups SET group_id=:other "
            "WHERE course_offering_id=:c AND group_id=:g"
        )
        s.db.execute(text(sql), {"c": s.offering.id, "g": s.groups[0].id, "other": s.groups[1].id})
    s.db.execute(
        text("UPDATE course_groups SET group_id=group_id WHERE group_id=:g"), {"g": s.groups[0].id}
    )
    s.db.execute(text("DELETE FROM course_groups WHERE group_id=:g"), {"g": s.groups[1].id})


@pytest.mark.parametrize("table", ["lesson_groups", "lesson_rooms"])
def test_direct_noop_and_rollback_do_not_change_public_version(editor, table):  # noqa: F811
    e = editor
    item = create(e)
    lesson_id = int(item["id"])
    e.db.execute(
        text(f"UPDATE {table} SET lesson_id=lesson_id WHERE lesson_id=:id"), {"id": lesson_id}
    )
    e.db.commit()
    assert e.request_editor("GET", f"/lessons/{lesson_id}").json() == item
    with e.db.begin_nested() as savepoint:
        e.db.execute(text(f"DELETE FROM {table} WHERE lesson_id=:id"), {"id": lesson_id})
        assert e.db.scalar(select(Lesson.version).where(Lesson.id == lesson_id)) == 2
        savepoint.rollback()
    assert e.request_editor("GET", f"/lessons/{lesson_id}").json() == item
    assert e.db.scalar(text("SELECT count(*) FROM audit_events")) == 1


def test_schedule_large_page_has_constant_queries_and_stable_ties(editor):  # noqa: F811
    e = editor
    lessons = [e.lesson() for _ in range(200)]
    e.db.commit()
    params = {
        "resource": "group",
        "resource_id": str(e.groups[0].id),
        "date_from": "2026-11-10",
        "date_to": "2026-11-10",
    }
    queries = []

    def count(*args):
        queries.append(args[2])

    counts = []
    event.listen(e.db.bind, "before_cursor_execute", count)
    try:
        for limit in (1, 200):
            queries.clear()
            result = e.request_editor("GET", params=params | {"limit": limit})
            assert result.status_code == 200, result.text
            counts.append(len(queries))
    finally:
        event.remove(e.db.bind, "before_cursor_execute", count)
    assert counts[0] == counts[1]
    first = e.request_editor("GET", params=params | {"limit": 1}).json()
    second = e.request_editor(
        "GET", params=params | {"limit": 1, "after_id": first["next_after_id"]}
    ).json()
    expected = [str(lesson.id) for lesson in lessons[:2]]
    assert [first["items"][0]["id"], second["items"][0]["id"]] == expected
    assert (
        e.request_editor("GET", params=params | {"after_id": "9223372036854775807"}).status_code
        == 422
    )


def test_parent_offering_change_validates_final_participants(schedule):  # noqa: F811
    from app.models import CourseGroup, CourseOffering

    s = schedule
    lesson = s.lesson()
    offering = s.add(
        CourseOffering, discipline_id=s.discipline.id, term_id=s.term.id, attestation_type="exam"
    )
    s.add(CourseGroup, course_offering_id=offering.id, group_id=s.groups[1].id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(
            text("UPDATE lessons SET course_offering_id=:c WHERE id=:l"),
            {"c": offering.id, "l": lesson.id},
        )
        s.db.execute(text("SET CONSTRAINTS validate_lesson_course_memberships IMMEDIATE"))
    with s.db.begin_nested():
        s.db.execute(
            text("UPDATE lessons SET course_offering_id=:c WHERE id=:l"),
            {"c": offering.id, "l": lesson.id},
        )
        s.db.execute(
            text("UPDATE lesson_groups SET group_id=:g WHERE lesson_id=:l"),
            {"g": s.groups[1].id, "l": lesson.id},
        )
        s.db.execute(text("SET CONSTRAINTS validate_lesson_course_memberships IMMEDIATE"))


@pytest.mark.parametrize("table", ["lesson_groups", "lesson_rooms"])
@pytest.mark.parametrize("operation", ["insert", "delete"])
def test_raw_multirow_statement_versions_each_parent_once(editor, table, operation):  # noqa: F811
    e = editor
    first, second = [e.lesson(assigned=[], room_ids=[]) for _ in range(2)]
    e.db.commit()
    column = "group_id" if table == "lesson_groups" else "room_id"
    references = e.groups if table == "lesson_groups" else e.rooms
    values = {"a": first.id, "b": second.id, "x": references[0].id, "y": references[1].id}
    sql = f"INSERT INTO {table}(lesson_id,{column}) VALUES (:a,:x),(:a,:y),(:b,:x),(:b,:y)"
    e.db.execute(text(sql), values)
    e.db.commit()
    if operation == "delete":
        e.db.execute(text(f"DELETE FROM {table} WHERE lesson_id IN (:a,:b)"), values)
        e.db.commit()
    assert (
        list(
            e.db.scalars(
                select(Lesson.version)
                .where(Lesson.id.in_([first.id, second.id]))
                .order_by(Lesson.id)
            )
        )
        == [2 if operation == "insert" else 3] * 2
    )


@pytest.mark.parametrize("table", ["lesson_groups", "lesson_rooms"])
def test_moving_raw_link_versions_both_parents(editor, table):  # noqa: F811
    e = editor
    first, second = [e.lesson(assigned=[], room_ids=[]) for _ in range(2)]
    column = "group_id" if table == "lesson_groups" else "room_id"
    reference = e.groups[0].id if table == "lesson_groups" else e.rooms[0].id
    e.db.execute(
        text(f"INSERT INTO {table}(lesson_id,{column}) VALUES (:l,:r)"),
        {"l": first.id, "r": reference},
    )
    versions = dict(
        e.db.execute(
            select(Lesson.id, Lesson.version).where(Lesson.id.in_([first.id, second.id]))
        ).all()
    )
    e.db.execute(
        text(f"UPDATE {table} SET lesson_id=:b WHERE lesson_id=:a"), {"a": first.id, "b": second.id}
    )
    after = dict(
        e.db.execute(
            select(Lesson.id, Lesson.version).where(Lesson.id.in_([first.id, second.id]))
        ).all()
    )
    assert after == {lesson_id: version + 1 for lesson_id, version in versions.items()}
