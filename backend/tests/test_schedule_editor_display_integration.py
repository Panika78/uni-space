"""Display metadata in editor reads is batched and covers historical lessons."""

from datetime import date

import pytest
from sqlalchemy import event
from test_schedule_editor_integration import editor  # noqa: F401
from test_schedule_integration import schedule  # noqa: F401

from app.models import (
    AcademicTerm,
    Building,
    CourseGroup,
    CourseOffering,
    Discipline,
    Room,
    StudyGroup,
    Subgroup,
    Teacher,
    TeachingAssignment,
)

pytestmark = pytest.mark.integration


def make_query_listener(statements):
    def listener(_conn, _cursor, statement, _params, _ctx, _many):
        statements.append(statement)

    return listener


def test_editor_display_resolves_catalog_tail_and_survives_mutations(editor):  # noqa: F811
    e = editor
    # All selectable objects used below sort beyond a 100-row catalog page.
    groups = []
    teachers = []
    rooms = []
    offerings = []
    generated_subgroups = []
    for index in range(101):
        group = e.add(
            StudyGroup,
            name=f"Tail group {index}",
            program_id=e.groups[0].program_id,
            course_number=1,
        )
        groups.append(group)
        generated_subgroups.append(
            e.add(Subgroup, name=f"Tail subgroup {index}", group_id=group.id)
        )
        teachers.append(e.add(Teacher, full_name=f"Tail teacher {index}"))
        building = e.add(Building, name=f"Tail building {index}")
        rooms.append(e.add(Room, building_id=building.id, name=f"Tail room {index}"))
        term = e.add(
            AcademicTerm,
            name=f"Tail term {index}",
            starts_on=date(2026, 9, 1),
            ends_on=date(2027, 1, 31),
        )
        discipline = e.add(
            Discipline,
            name="Same discipline",
            code=f"TAIL-{index}",
        )
        offerings.append(
            e.add(
                CourseOffering,
                discipline_id=discipline.id,
                term_id=term.id,
                attestation_type="pass_fail",
            )
        )

    group_a, group_b = groups[-2:]
    subgroup_a = e.add(Subgroup, name="Tail subgroup A", group_id=group_a.id)
    subgroup_b = e.add(Subgroup, name="Tail subgroup B", group_id=group_a.id)
    teacher = teachers[-1]
    offering = offerings[-1]
    selected_rooms = rooms[-2:]
    for group in (group_a, group_b):
        e.add(CourseGroup, course_offering_id=offering.id, group_id=group.id)
        e.add(
            TeachingAssignment,
            teacher_id=teacher.id,
            course_offering_id=offering.id,
            group_id=group.id,
        )
    e.db.commit()

    payload = e.payload(
        course_offering_id=str(offering.id),
        teacher_id=str(teacher.id),
        participants=[
            {"group_id": str(group_a.id), "subgroup_id": str(subgroup_a.id)},
            {"group_id": str(group_a.id), "subgroup_id": str(subgroup_b.id)},
            {"group_id": str(group_b.id), "subgroup_id": None},
        ],
        room_ids=[str(room.id) for room in selected_rooms],
    )
    created = e.request_editor("POST", body=payload)
    assert created.status_code == 201, created.text
    item = created.json()
    expected = {
        "course_offering": {
            "id": str(offering.id),
            "discipline_id": str(e.db.get(CourseOffering, offering.id).discipline_id),
            "discipline_name": "Same discipline",
            "discipline_code": "TAIL-100",
            "term_id": str(offering.term_id),
            "term_name": "Tail term 100",
            "attestation_type": "pass_fail",
        },
        "teacher": {"id": str(teacher.id), "full_name": teacher.full_name},
        "participants": [
            {
                "group_id": str(group_a.id),
                "group_name": group_a.name,
                "subgroup_id": str(subgroup_a.id),
                "subgroup_name": subgroup_a.name,
            },
            {
                "group_id": str(group_a.id),
                "group_name": group_a.name,
                "subgroup_id": str(subgroup_b.id),
                "subgroup_name": subgroup_b.name,
            },
            {
                "group_id": str(group_b.id),
                "group_name": group_b.name,
                "subgroup_id": None,
                "subgroup_name": None,
            },
        ],
        "rooms": [
            {
                "id": str(room.id),
                "name": room.name,
                "building_id": str(room.building_id),
                "building_name": f"Tail building {index}",
            }
            for index, room in zip((99, 100), selected_rooms, strict=True)
        ],
    }
    assert item["display"] == expected
    assert item["course_offering_id"] == str(offering.id)
    assert item["teacher_id"] == str(teacher.id)
    assert item["room_ids"] == [str(room.id) for room in selected_rooms]
    assert e.request_editor("GET", f"/lessons/{item['id']}").json() == item
    listed = e.request_editor(
        "GET",
        params={
            "resource": "group",
            "resource_id": str(group_a.id),
            "date_from": "2026-11-10",
            "date_to": "2026-11-10",
        },
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["display"] == expected

    # Every write route returns the same read model.
    update_payload = payload | {"version": item["version"]}
    updated = e.request_editor("PATCH", f"/lessons/{item['id']}", update_payload)
    assert updated.status_code == 200, updated.text
    assert updated.json()["display"] == expected
    cancelled = e.request_editor("POST", f"/lessons/{item['id']}/cancel", {"version": 1})
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["display"] == expected
    restored = e.request_editor("POST", f"/lessons/{item['id']}/restore", {"version": 2})
    assert restored.status_code == 200, restored.text
    assert restored.json()["display"] == expected
    move_body = payload | {
        "starts_at": "2026-11-11T09:00:00+03:00",
        "ends_at": "2026-11-11T10:00:00+03:00",
        "version": 3,
    }
    moved = e.request_editor("POST", f"/lessons/{item['id']}/move", move_body)
    assert moved.status_code == 201, moved.text
    assert moved.json()["display"] == expected
    historical = e.request_editor(
        "GET",
        params={
            "resource": "group",
            "resource_id": str(group_a.id),
            "date_from": "2026-11-10",
            "date_to": "2026-11-11",
        },
    )
    assert historical.status_code == 200, historical.text
    assert [lesson["status"] for lesson in historical.json()["items"]] == ["moved", "scheduled"]
    assert all(lesson["display"] == expected for lesson in historical.json()["items"])

    # Retain historical names when current teaching assignments disappear.
    e.db.query(TeachingAssignment).delete()
    e.db.commit()
    assert e.request_editor("GET", f"/lessons/{item['id']}").json()["display"] == expected
    assert e.request_editor("GET", f"/lessons/{moved.json()['id']}").json()["display"] == expected
    unassigned_teacher = e.request_editor(
        "POST",
        body=payload
        | {
            "teacher_id": None,
            "starts_at": "2026-11-13T09:00:00+03:00",
            "ends_at": "2026-11-13T10:00:00+03:00",
        },
    )
    assert unassigned_teacher.status_code == 201, unassigned_teacher.text
    assert unassigned_teacher.json()["display"]["teacher"] is None


def test_editor_read_query_count_is_constant_for_one_and_two_hundred_lessons(editor):  # noqa: F811
    e = editor
    lessons = [e.lesson() for _ in range(200)]
    e.db.commit()
    params = {
        "resource": "group",
        "resource_id": str(e.groups[0].id),
        "date_from": "2026-11-10",
        "date_to": "2026-11-10",
        "limit": 200,
    }
    counts = []
    for count in (1, 200):
        e.db.connection()
        e.db.expunge_all()
        statements = []
        listener = make_query_listener(statements)
        event.listen(e.db.bind, "before_cursor_execute", listener)
        try:
            response = e.request_editor("GET", params=params | {"limit": count})
        finally:
            event.remove(e.db.bind, "before_cursor_execute", listener)
        assert response.status_code == 200, response.text
        assert len(response.json()["items"]) == count
        counts.append(len(statements))
    print(f"Editor lesson SQL counts for page sizes 1/200: {counts}")
    assert counts[0] == counts[1]
    assert len(lessons) == 200
