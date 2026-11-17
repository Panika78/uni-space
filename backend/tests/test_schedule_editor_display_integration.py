"""Display metadata in editor reads is batched and covers historical lessons."""

from datetime import date, datetime, timedelta

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
    Lesson,
    LessonGroup,
    LessonRoom,
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
            "term_starts_on": "2026-09-01",
            "term_ends_on": "2027-01-31",
            "attestation_type": "pass_fail",
            "groups": [{"id": str(group.id), "name": group.name} for group in (group_a, group_b)],
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


def test_editor_teacher_name_uses_account_and_matches_other_schedule_reads(editor):  # noqa: F811
    e = editor
    participant = [{"group_id": str(e.groups[1].id), "subgroup_id": None}]
    payload = e.payload(
        teacher_id=str(e.teacher.id),
        participants=participant,
        room_ids=[],
    )
    created = e.request_editor("POST", body=payload)
    assert created.status_code == 201, created.text
    lesson_id = created.json()["id"]
    initial_name = e.teacher_user.full_name
    assert created.json()["display"]["teacher"]["full_name"] == initial_name

    e.teacher_user.full_name = "Updated account teacher name"
    e.db.commit()
    staff_lesson = e.request_editor("GET", f"/lessons/{lesson_id}").json()
    assert staff_lesson["display"]["teacher"]["full_name"] == e.teacher_user.full_name

    teacher_catalog = e.request_editor("GET", "/catalog/teachers", params={"limit": 100})
    assert teacher_catalog.status_code == 200, teacher_catalog.text
    teacher_item = next(
        row for row in teacher_catalog.json()["items"] if row["id"] == str(e.teacher.id)
    )
    assert teacher_item["name"] == e.teacher_user.full_name

    student_schedule = e.request(index=1).json()
    student_lesson = next(row for row in student_schedule["items"] if row["id"] == lesson_id)
    assert student_lesson["teacher"]["name"] == e.teacher_user.full_name

    e.add(
        TeachingAssignment,
        teacher_id=e.standalone.id,
        course_offering_id=e.offering.id,
        group_id=e.groups[1].id,
    )
    e.db.commit()
    unlinked = e.request_editor(
        "POST",
        body=payload
        | {
            "teacher_id": str(e.standalone.id),
            "starts_at": "2026-11-10T11:00:00+03:00",
            "ends_at": "2026-11-10T12:00:00+03:00",
        },
    )
    assert unlinked.status_code == 201, unlinked.text
    assert unlinked.json()["display"]["teacher"] == {
        "id": str(e.standalone.id),
        "full_name": e.standalone.full_name,
    }


def test_course_offering_display_distinguishes_duplicate_business_values(editor):  # noqa: F811
    e = editor
    same_title_other_dates = e.add(
        AcademicTerm,
        name=e.term.name,
        starts_on=date(2027, 2, 1),
        ends_on=date(2027, 6, 30),
    )
    offerings = [
        e.add(
            CourseOffering,
            discipline_id=e.discipline.id,
            term_id=term_id,
            attestation_type="pass_fail",
        )
        for term_id in (e.term.id, e.term.id, e.term.id, same_title_other_dates.id)
    ]
    group_sets = ((e.groups[0],), (e.groups[1],), (e.groups[0],), (e.groups[0],))
    for offering, groups in zip(offerings, group_sets, strict=True):
        for group in groups:
            e.add(CourseGroup, course_offering_id=offering.id, group_id=group.id)
    e.db.commit()

    displays = []
    for index, (offering, groups) in enumerate(zip(offerings, group_sets, strict=True)):
        starts_at = f"2026-11-10T{9 + index * 2:02}:00:00+03:00"
        created = e.request_editor(
            "POST",
            body=e.payload(
                course_offering_id=str(offering.id),
                teacher_id=None,
                participants=[{"group_id": str(group.id), "subgroup_id": None} for group in groups],
                room_ids=[],
                starts_at=starts_at,
                ends_at=f"2026-11-10T{10 + index * 2:02}:00:00+03:00",
            ),
        )
        assert created.status_code == 201, created.text
        displays.append(created.json()["display"]["course_offering"])

    assert [item["groups"] for item in displays[:2]] == [
        [{"id": str(e.groups[0].id), "name": e.groups[0].name}],
        [{"id": str(e.groups[1].id), "name": e.groups[1].name}],
    ]
    assert displays[0]["groups"] == displays[2]["groups"]
    assert displays[0]["id"] != displays[2]["id"]
    assert {key: value for key, value in displays[0].items() if key != "id"} == {
        key: value for key, value in displays[2].items() if key != "id"
    }
    assert displays[0]["term_name"] == displays[3]["term_name"]
    assert displays[0]["term_id"] != displays[3]["term_id"]
    assert displays[0]["term_starts_on"] == "2026-09-01"
    assert displays[0]["term_ends_on"] == "2027-01-31"
    assert displays[3]["term_starts_on"] == "2027-02-01"
    assert displays[3]["term_ends_on"] == "2027-06-30"


def test_editor_read_query_count_is_bounded_for_repeated_and_diverse_links(editor):  # noqa: F811
    e = editor
    for _ in range(200):
        e.lesson(teacher_id=e.teacher.id, room_ids=[e.rooms[0].id])
    diverse_ids = []
    diverse_group_id = e.groups[1].id
    diverse_group_name = e.groups[1].name
    for index in range(200):
        group = e.add(
            StudyGroup,
            name=f"Load group {index}",
            program_id=e.groups[0].program_id,
            course_number=1,
        )
        subgroup = e.add(Subgroup, name=f"Load subgroup {index}", group_id=group.id)
        teacher = e.add(Teacher, full_name=f"Load teacher {index}")
        room = e.add(
            Room,
            name=f"Load room {index}",
            building_id=e.buildings[index % len(e.buildings)].id,
        )
        offering = e.add(
            CourseOffering,
            discipline_id=e.discipline.id,
            term_id=e.term.id,
            attestation_type="pass_fail",
        )
        e.add(CourseGroup, course_offering_id=offering.id, group_id=group.id)
        e.add(CourseGroup, course_offering_id=offering.id, group_id=diverse_group_id)
        starts_at = datetime.fromisoformat("2026-11-10T09:00:00+03:00") + timedelta(minutes=index)
        lesson = e.add(
            Lesson,
            course_offering_id=offering.id,
            teacher_id=teacher.id,
            starts_at=starts_at,
            ends_at=starts_at + timedelta(minutes=45),
            kind="seminar",
        )
        e.add(LessonGroup, lesson_id=lesson.id, group_id=diverse_group_id)
        e.add(
            LessonGroup,
            lesson_id=lesson.id,
            group_id=group.id,
            subgroup_id=subgroup.id,
        )
        e.add(LessonRoom, lesson_id=lesson.id, room_id=room.id)
        diverse_ids.append(str(lesson.id))
    e.db.commit()

    def read_and_count(params, limit, after_id=None):
        e.db.connection()
        e.db.expunge_all()
        statements = []
        listener = make_query_listener(statements)
        event.listen(e.db.bind, "before_cursor_execute", listener)
        try:
            request_params = params | {"limit": limit}
            if after_id is not None:
                request_params["after_id"] = after_id
            response = e.request_editor(
                "GET",
                params=request_params,
            )
        finally:
            event.remove(e.db.bind, "before_cursor_execute", listener)
        assert response.status_code == 200, response.text
        return response.json(), len(statements)

    repeated_params = {
        "resource": "group",
        "resource_id": str(e.groups[0].id),
        "date_from": "2026-11-10",
        "date_to": "2026-11-10",
    }
    repeated_one, repeated_count_one = read_and_count(repeated_params, 1)
    repeated_page, repeated_count_200 = read_and_count(repeated_params, 200)
    assert len(repeated_one["items"]) == 1
    assert len(repeated_page["items"]) == 200
    assert len({item["id"] for item in repeated_page["items"]}) == 200
    assert repeated_count_one == repeated_count_200
    assert all(
        len(item["display"]["participants"]) == 1
        and len(item["display"]["rooms"]) == 1
        and len(item["display"]["course_offering"]["groups"]) == 2
        for item in repeated_page["items"]
    )

    diverse_params = repeated_params | {"resource_id": str(diverse_group_id)}
    diverse_one, diverse_count_one = read_and_count(diverse_params, 1)
    diverse_page, diverse_count_200 = read_and_count(diverse_params, 200)
    assert len(diverse_one["items"]) == 1
    assert [item["id"] for item in diverse_page["items"]] == diverse_ids
    assert len({item["id"] for item in diverse_page["items"]}) == 200
    assert diverse_count_one == diverse_count_200
    assert abs(diverse_count_200 - repeated_count_200) <= 2
    for index, item in enumerate(diverse_page["items"]):
        display = item["display"]
        assert len(display["participants"]) == 2
        assert len({participant["group_id"] for participant in display["participants"]}) == 2
        assert len(display["rooms"]) == len({room["id"] for room in display["rooms"]}) == 1
        offering_groups = display["course_offering"]["groups"]
        offering_group_ids = [group["id"] for group in offering_groups]
        assert len(offering_group_ids) == len(set(offering_group_ids)) == 2
        assert [group["name"] for group in offering_groups] == [
            diverse_group_name,
            f"Load group {index}",
        ]
        assert display["teacher"]["full_name"] == f"Load teacher {index}"

    first_page, _ = read_and_count(diverse_params, 100)
    second_page, _ = read_and_count(diverse_params, 100, after_id=first_page["next_after_id"])
    paged_ids = [item["id"] for item in first_page["items"] + second_page["items"]]
    assert len(first_page["items"]) == len(second_page["items"]) == 100
    assert paged_ids == diverse_ids
    assert len(set(paged_ids)) == 200
    print(
        "Editor SQL counts for 1/200 repeated and 1/200 diverse lessons: "
        f"{repeated_count_one}/{repeated_count_200}, {diverse_count_one}/{diverse_count_200}"
    )
