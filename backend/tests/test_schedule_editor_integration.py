"""Real PostgreSQL and HTTP contract for the official staff editor."""

from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select, text
from test_assessed_lesson_participants import add_assessment, link_assessment
from test_schedule_integration import schedule  # noqa: F401

from app.models import (
    AssessmentGroup,
    AuditEvent,
    Lesson,
    OrgUnit,
    StaffPermission,
    StaffProfile,
    Subgroup,
    TeachingAssignment,
)
from app.schedule.editor_router import router

pytestmark = pytest.mark.integration
BASE = "/api/v1/staff/schedule"


@pytest.fixture
def editor(schedule):  # noqa: F811
    s = schedule
    s.app.include_router(router)
    # Use a real JWT issued before the role/grant changes: authorization must
    # consult current DB state rather than trusting role claims.
    user = s.users[0]
    s.db.delete(s.students[0])
    s.db.flush()
    user.role = "staff"
    unit = s.add(OrgUnit, name="Вымышленный деканат", type="dean_office")
    profile = s.add(StaffProfile, user_id=user.id, org_unit_id=unit.id)
    grant = s.add(StaffPermission, staff_profile_id=profile.id, permission_code="schedule.edit")
    for group in s.groups:
        s.add(
            TeachingAssignment,
            teacher_id=s.teacher.id,
            course_offering_id=s.offering.id,
            group_id=group.id,
        )
    a, b = [s.add(Subgroup, name=n, group_id=s.groups[0].id) for n in ("А", "Б")]
    s.db.commit()

    def request(method, path="/lessons", body=None, token=None, **kw):
        return s.client.request(
            method,
            BASE + path,
            json=body,
            headers={"Authorization": f"Bearer {token or s.tokens[0]}"},
            **kw,
        )

    def payload(**changes):
        return {
            "course_offering_id": str(s.offering.id),
            "teacher_id": str(s.teacher.id),
            "starts_at": "2026-11-10T09:00:00+03:00",
            "ends_at": "2026-11-10T10:00:00+03:00",
            "kind": "lecture",
            "participants": [{"group_id": str(s.groups[0].id), "subgroup_id": None}],
            "room_ids": [str(s.rooms[0].id)],
            **changes,
        }

    return SimpleNamespace(
        **vars(s),
        **{
            "request_editor": request,
            "payload": payload,
            "grant": grant,
            "actor": user,
            "a": a,
            "b": b,
        },
    )


def create(e, **changes):
    result = e.request_editor("POST", body=e.payload(**changes))
    assert result.status_code == 201, result.text
    return result.json()


def move_payload(e, **changes):
    return e.payload(
        starts_at="2026-11-11T09:00:00+03:00", ends_at="2026-11-11T10:00:00+03:00", **changes
    )


def events(e, entity="lesson"):
    return list(
        e.db.scalars(
            select(AuditEvent).where(AuditEvent.entity_type == entity).order_by(AuditEvent.id)
        )
    )


def test_editor_crud_versions_noop_and_subgroup_audit(editor):
    e = editor
    item = create(e)
    path = f"/lessons/{item['id']}"
    assert item["version"] == 1
    assert e.request_editor("GET", path).json() == item
    data = e.payload(version=1)
    assert e.request_editor("PATCH", path, data).json()["version"] == 1
    assert len(events(e)) == 1
    data["participants"][0]["subgroup_id"] = str(e.a.id)
    updated = e.request_editor("PATCH", path, data)
    assert updated.status_code == 200, updated.text
    assert updated.json()["version"] == 2
    assert e.request_editor("PATCH", path, data).status_code == 409
    audit = events(e)[-1]
    assert audit.actor_user_id == e.actor.id
    assert audit.before_data["group_ids"] == audit.after_data["group_ids"]
    assert audit.after_data["participants"] == [{"group_id": e.groups[0].id, "subgroup_id": e.a.id}]
    data["version"] = 2
    data["room_ids"] = [str(e.rooms[1].id)]
    assert e.request_editor("PATCH", path, data).json()["version"] == 3
    assert e.request_editor("DELETE", path).status_code == 405
    assert e.request_editor("PATCH", path, data | {"status": "moved"}).status_code == 422


def test_move_chain_cancel_restore_and_student_schedule(editor):
    e = editor
    item = create(e)
    ids = [item["id"]]
    for day in (11, 12):
        result = e.request_editor(
            "POST",
            f"/lessons/{ids[-1]}/move",
            e.payload(
                version=1,
                starts_at=f"2026-11-{day}T09:00:00+03:00",
                ends_at=f"2026-11-{day}T10:00:00+03:00",
            ),
        )
        assert result.status_code == 201, result.text
        item = result.json()
        assert item["previous_lesson_id"] == ids[-1] and item["version"] == 1
        ids.append(item["id"])
    for old_id in ids[:-1]:
        assert e.request_editor("GET", f"/lessons/{old_id}").json()["status"] == "moved"
        for action in ("move", "cancel", "restore"):
            body = e.payload(version=2) if action == "move" else {"version": 2}
            assert e.request_editor("POST", f"/lessons/{old_id}/{action}", body).status_code == 409
        assert (
            e.request_editor("PATCH", f"/lessons/{old_id}", e.payload(version=2)).status_code == 409
        )
    path = f"/lessons/{ids[-1]}"
    assert e.request_editor("POST", path + "/cancel", {"version": 1}).json()["version"] == 2
    assert e.request_editor("POST", path + "/move", e.payload(version=2)).status_code == 409
    assert e.request_editor("POST", path + "/restore", {"version": 2}).json()["version"] == 3
    assert events(e)[-1].action == "restore"
    # A student in the same group sees preserved old positions and current status.
    student = e.students[1]
    student.group_id = e.groups[0].id
    e.db.commit()
    response = e.client.get(
        "/api/v1/schedule",
        params={"date_from": "2026-11-10", "date_to": "2026-11-12"},
        headers={"Authorization": f"Bearer {e.tokens[1]}"},
    )
    assert response.status_code == 200
    assert [i["status"] for i in response.json()["items"]] == ["moved", "moved", "scheduled"]


@pytest.mark.parametrize("resource", ["teacher", "room", "participants"])
def test_official_conflicts_block_saves_and_adjacent_intervals_work(editor, resource):
    e = editor
    create(e)
    changes = {
        "teacher_id": None,
        "room_ids": [],
        "participants": [{"group_id": str(e.groups[1].id)}],
    }
    if resource == "teacher":
        changes["teacher_id"] = str(e.teacher.id)
    elif resource == "room":
        changes["room_ids"] = [str(e.rooms[0].id)]
    else:
        changes["participants"] = [{"group_id": str(e.groups[0].id), "subgroup_id": str(e.a.id)}]
    result = e.request_editor("POST", body=e.payload(**changes))
    assert result.status_code == 409
    assert result.json()["error"]["details"][0]["code"] == resource + "_conflict"
    assert len(events(e)) == 1
    create(e, starts_at="2026-11-10T10:00:00+03:00", ends_at="2026-11-10T11:00:00+03:00")


def test_different_subgroups_can_overlap_and_restore_rechecks_conflicts(editor):
    e = editor
    first = create(
        e,
        teacher_id=None,
        room_ids=[],
        participants=[{"group_id": str(e.groups[0].id), "subgroup_id": str(e.a.id)}],
    )
    create(
        e,
        teacher_id=None,
        room_ids=[],
        participants=[{"group_id": str(e.groups[0].id), "subgroup_id": str(e.b.id)}],
    )
    path = f"/lessons/{first['id']}"
    assert e.request_editor("POST", path + "/cancel", {"version": 1}).status_code == 200
    create(
        e,
        teacher_id=None,
        room_ids=[],
        participants=[{"group_id": str(e.groups[0].id), "subgroup_id": str(e.a.id)}],
    )
    assert e.request_editor("POST", path + "/restore", {"version": 2}).status_code == 409
    assert e.request_editor("GET", path).json()["status"] == "cancelled"


@pytest.mark.parametrize("action", ["cancel", "move"])
def test_assessment_flags_and_audit_are_atomic_without_changing_date_or_link(editor, action):
    e = editor
    item = create(e)
    lesson = e.db.get(Lesson, int(item["id"]))
    work = add_assessment(e.db, lesson)
    assignment = link_assessment(e.db, work.id, lesson.id, e.groups[0].id)
    assignment.planned_date = date(2026, 11, 10)
    e.db.commit()
    body = move_payload(e, version=1) if action == "move" else {"version": 1}
    response = e.request_editor("POST", f"/lessons/{item['id']}/{action}", body)
    assert response.status_code in (200, 201), response.text
    e.db.refresh(assignment)
    assert assignment.lesson_id == lesson.id and assignment.planned_date == date(2026, 11, 10)
    assert assignment.date_needs_confirmation is True
    audit = events(e, "assessment_group")[-1]
    assert audit.before_data == {
        "planned_date": "2026-11-10",
        "lesson_id": lesson.id,
        "date_needs_confirmation": False,
    }
    assert audit.after_data == audit.before_data | {"date_needs_confirmation": True}


@pytest.mark.parametrize(
    "action,fail_entity",
    [
        ("cancel", "lesson"),
        ("move", "lesson"),
        ("cancel", "assessment_group"),
        ("move", "assessment_group"),
        ("update", "lesson"),
    ],
)
def test_audit_failure_rolls_back_schedule_links_flags_and_version(
    editor, monkeypatch, action, fail_entity
):
    from app.schedule import editor_service

    e = editor
    item = create(e)
    lesson = e.db.get(Lesson, int(item["id"]))
    assignment = link_assessment(e.db, add_assessment(e.db, lesson).id, lesson.id, e.groups[0].id)
    e.db.commit()
    original = editor_service.write_audit_event

    def fail(db, **kw):
        original(db, **kw)
        if kw["entity_type"] == fail_entity:
            raise ValueError("forced audit failure")

    monkeypatch.setattr(editor_service, "write_audit_event", fail)
    body = e.payload(version=1, room_ids=[]) if action in ("move", "update") else {"version": 1}
    if action == "move":
        body = move_payload(e, version=1, room_ids=[])
    path = f"/lessons/{item['id']}" + ("" if action == "update" else f"/{action}")
    response = e.request_editor("PATCH" if action == "update" else "POST", path, body)
    assert response.status_code == 500
    assert e.request_editor("GET", f"/lessons/{item['id']}").json() == item
    e.db.refresh(assignment)
    assert assignment.date_needs_confirmation is False
    assert len(events(e)) == 1 and events(e, "assessment_group") == []


def test_assessed_subgroup_replacement_and_last_group_removal(editor):
    e = editor
    item = create(e)
    lesson = e.db.get(Lesson, int(item["id"]))
    assignment = link_assessment(e.db, add_assessment(e.db, lesson).id, lesson.id, e.groups[0].id)
    e.db.commit()
    path = f"/lessons/{item['id']}"
    for version, subgroup in enumerate((e.a, e.b), start=1):
        result = e.request_editor(
            "PATCH",
            path,
            e.payload(
                version=version,
                participants=[{"group_id": str(e.groups[0].id), "subgroup_id": str(subgroup.id)}],
            ),
        )
        assert result.status_code == 200, result.text
        assert result.json()["version"] == version + 1
    result = e.request_editor(
        "PATCH", path, e.payload(version=3, participants=[{"group_id": str(e.groups[1].id)}])
    )
    assert result.status_code == 409
    assert result.json()["error"]["code"] == "assessment_group_in_use"
    assert e.request_editor("GET", path).json()["version"] == 3
    e.db.refresh(assignment)
    assert assignment.lesson_id == lesson.id


def test_staff_catalogs_schedules_historical_read_and_permissions_are_live(editor):
    e = editor
    item = create(e)
    for kind in (
        "groups",
        "subgroups",
        "teachers",
        "rooms",
        "course-offerings",
        "teaching-assignments",
    ):
        result = e.request_editor("GET", "/catalog/" + kind, params={"limit": 1})
        assert result.status_code == 200, result.text
        assert len(result.json()["items"]) == 1
        if result.json()["next_after_id"]:
            assert (
                e.request_editor(
                    "GET", "/catalog/" + kind, params={"after_id": result.json()["next_after_id"]}
                ).status_code
                == 200
            )
    for resource, resource_id in (
        ("group", e.groups[0].id),
        ("teacher", e.teacher.id),
        ("room", e.rooms[0].id),
    ):
        result = e.request_editor(
            "GET",
            params={
                "resource": resource,
                "resource_id": str(resource_id),
                "date_from": "2026-11-10",
                "date_to": "2026-11-10",
            },
        )
        assert result.status_code == 200, result.text
        assert result.json()["items"] == [item]
    # Historical read survives deletion of current teaching assignment.
    e.db.execute(text("DELETE FROM teaching_assignments"))
    e.db.commit()
    assert e.request_editor("GET", f"/lessons/{item['id']}").status_code == 200
    # A staff caller never needs their own teacher profile/assignment.
    assert e.actor.role == "staff"
    e.db.delete(e.grant)
    e.db.commit()
    for method, path, body in (
        ("GET", "/catalog/subgroups", None),
        ("GET", f"/lessons/{item['id']}", None),
        ("POST", "/lessons", e.payload()),
    ):
        assert e.request_editor(method, path, body).status_code == 403
    assert e.request_editor("GET", "/catalog/groups", token=e.tokens[1]).status_code == 403
    assert e.request_editor("GET", "/catalog/groups", token=e.tokens[2]).status_code == 403


def test_invalid_assignment_input_and_direct_ids(editor):
    e = editor
    result = e.request_editor("POST", body=e.payload(teacher_id=str(e.standalone.id)))
    assert result.status_code == 422
    assert e.request_editor("GET", "/lessons/9223372036854775807").status_code == 404
    assert e.request_editor("GET", "/lessons/9223372036854775808").status_code == 422
    assert e.request_editor("POST", body=e.payload(previous_lesson_id="1")).status_code == 422
    assert e.request_editor("POST", body=e.payload(participants=[])).status_code == 422
    assert e.db.scalar(select(func.count()).select_from(AuditEvent)) == 0


def test_all_editor_routes_deny_admin_and_revoked_staff_before_resolving_ids(editor):
    e = editor
    routes = [
        ("GET", "/catalog/subgroups", None),
        ("GET", "/lessons/999999", None),
        ("POST", "/lessons", e.payload()),
        ("PATCH", "/lessons/999999", e.payload(version=1)),
        ("POST", "/lessons/999999/move", e.payload(version=1)),
        ("POST", "/lessons/999999/cancel", {"version": 1}),
        ("POST", "/lessons/999999/restore", {"version": 1}),
    ]
    e.db.delete(e.grant)
    e.db.delete(e.db.scalar(select(StaffProfile).where(StaffProfile.user_id == e.actor.id)))
    e.actor.role = "admin"
    e.db.commit()
    for method, path, body in routes:
        response = e.request_editor(method, path, body)
        assert response.status_code == 403, response.text
    assert e.client.get(BASE + "/catalog/groups").status_code == 401


@pytest.mark.parametrize(
    "invalid",
    [
        {"room_ids": ["9223372036854775807"]},
        {"course_offering_id": "9223372036854775807"},
        {"starts_at": "2026-11-10T09:00:00"},
        {"ends_at": "2026-11-10T08:00:00+03:00"},
        {"is_additional": True},
        {"created_by_user_id": "1"},
    ],
)
def test_invalid_editor_proposals_never_write_or_audit(editor, invalid):
    response = editor.request_editor("POST", body=editor.payload(**invalid))
    assert response.status_code == 422, response.text
    assert events(editor) == []


def test_failure_of_new_move_target_audit_rolls_back_source_and_continuation(editor, monkeypatch):
    from app.schedule import editor_service

    e = editor
    item = create(e)
    original = editor_service.write_audit_event

    def fail_new_target(db, **kw):
        original(db, **kw)
        if kw["entity_type"] == "lesson" and kw["action"] == "create":
            raise ValueError("forced continuation audit failure")

    monkeypatch.setattr(editor_service, "write_audit_event", fail_new_target)
    response = e.request_editor("POST", f"/lessons/{item['id']}/move", move_payload(e, version=1))
    assert response.status_code == 500
    assert e.request_editor("GET", f"/lessons/{item['id']}").json() == item
    assert e.db.scalar(select(func.count()).select_from(Lesson)) == 1
    assert len(events(e)) == 1


def test_schedule_changes_preserve_works_scores_assignments_and_unlinked_flags(editor):
    from datetime import UTC, datetime

    from app.models import AssessmentResult

    e = editor
    item = create(e)
    lesson = e.db.get(Lesson, int(item["id"]))
    work = add_assessment(e.db, lesson)
    linked = link_assessment(e.db, work.id, lesson.id, e.groups[0].id)
    unrelated = e.add(
        AssessmentGroup,
        assessment_id=work.id,
        group_id=e.groups[1].id,
        planned_date=date(2026, 11, 10),
        date_needs_confirmation=False,
    )
    e.students[1].group_id = e.groups[0].id
    e.db.flush()
    e.add(
        AssessmentResult,
        assessment_group_id=linked.id,
        student_id=e.students[1].id,
        score=8,
        graded_at=datetime.now(UTC),
    )
    e.db.commit()
    tables = (
        "students",
        "teaching_assignments",
        "assessments",
        "assessment_results",
        "final_results",
    )

    def snapshot_tables():
        return [
            e.db.scalar(text(f"SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM {table} t"))
            for table in tables
        ]

    before = snapshot_tables()
    result = e.request_editor("POST", f"/lessons/{item['id']}/move", move_payload(e, version=1))
    assert result.status_code == 201, result.text
    assert snapshot_tables() == before
    e.db.refresh(unrelated)
    assert unrelated.date_needs_confirmation is False and unrelated.lesson_id is None


def test_legacy_unassigned_lesson_is_readable_and_can_be_repaired(editor):
    e = editor
    lesson = e.lesson(assigned=[], status="cancelled")
    lesson_id = lesson.id
    e.db.commit()
    path = f"/lessons/{lesson_id}"
    assert e.request_editor("GET", path).json()["participants"] == []
    result = e.request_editor("POST", path + "/restore", {"version": 1})
    assert result.status_code == 409, result.text
    assert result.json()["error"]["details"][0]["code"] == "invalid_participants"
    # A historical scheduled row without participants can be repaired through
    # a complete valid proposal rather than failing response/request validation.
    e.db.execute(text("UPDATE lessons SET status='scheduled' WHERE id=:id"), {"id": lesson_id})
    e.db.commit()
    result = e.request_editor("PATCH", path, e.payload(version=1))
    assert result.status_code == 200, result.text
    assert result.json()["version"] == 2
