"""Real PostgreSQL/API boundaries, transfers, audit and independent marks."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from test_teaching_integration import journal as journal_fixture

from app.attendance.router import router
from app.auth.security import create_access_token
from app.models import (
    Attendance,
    AuditEvent,
    AuthSession,
    Lesson,
    LessonGroup,
    OrgUnit,
    StaffPermission,
    StaffProfile,
    Subgroup,
    User,
)
from app.student_service import update_student_group

pytestmark = pytest.mark.integration


@pytest.fixture
def attendance(db_session):
    s = journal_fixture.__wrapped__(db_session)
    s.app.include_router(router)
    s.lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        teacher_id=s.teachers[2].id,
        starts_at=datetime.now(UTC),
        ends_at=datetime.now(UTC) + timedelta(hours=1),
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[0].id)

    def write(status="attended", student=0, teacher=0, lesson=None, token=None, method="put"):
        s.db.commit()
        return getattr(s.client, method)(
            f"/api/v1/attendance/lessons/{lesson or s.lesson.id}/students/{s.students[student].id}",
            headers={"Authorization": f"Bearer {token or s.teacher_tokens[teacher]}"},
            **({"json": {"status": status}} if method == "put" else {}),
        )

    def read(student=0, lesson=None, **params):
        path = "/api/v1/attendance" + (f"/lessons/{lesson}" if lesson else "")
        return s.client.get(
            path, params=params, headers={"Authorization": f"Bearer {s.tokens[student]}"}
        )

    def staff(permission="attendance.edit", unit_type="dean_office", role="staff"):
        user = s.add(
            User,
            login=uuid4().hex,
            password_hash="unused",
            full_name="Staff",
            role=role,
            is_active=True,
        )
        grant = None
        if role == "staff":
            unit = s.add(OrgUnit, name="Вымышленный отдел", type=unit_type)
            profile = s.add(StaffProfile, user_id=user.id, org_unit_id=unit.id)
            grant = s.add(StaffPermission, staff_profile_id=profile.id, permission_code=permission)
        session = s.add(
            AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
        )
        return create_access_token(session, s.settings)["access_token"], grant

    s.write, s.read, s.staff = write, read, staff
    return s


def events(s):
    return s.db.scalars(
        select(AuditEvent)
        .where(
            AuditEvent.entity_type == "attendance",
            AuditEvent.entity_id == s.lesson.id,
        )
        .order_by(AuditEvent.id)
    ).all()


def test_create_update_delete_noop_and_sql_null(attendance):
    s = attendance
    work = s.assignment(s.courses[0])
    result = s.result(work, 8)
    assert s.read(lesson=s.lesson.id).json()["status"] == "unmarked"
    assert s.write().status_code == 200
    mark = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    original = mark.updated_at, mark.marked_by_user_id
    assert s.write().status_code == 200
    s.db.refresh(mark)
    assert (mark.updated_at, mark.marked_by_user_id) == original
    assert len(events(s)) == 1
    assert s.write("absent").status_code == 200
    assert s.write(student=2).status_code == 200
    assert s.read().json()["items"][0]["status"] == "absent"
    assert s.read(2).json()["items"][0]["status"] == "attended"
    assert s.write(method="delete").json()["status"] == "unmarked"
    assert s.write(method="delete").status_code == 200
    rows = events(s)
    assert [e.action for e in rows] == ["create", "update", "create", "delete"]
    student_id = s.students[0].id
    assert rows[0].before_data is None
    assert rows[0].after_data == {"student_id": student_id, "status": "attended"}
    assert rows[1].before_data == rows[0].after_data
    assert rows[1].after_data == {"student_id": student_id, "status": "absent"}
    assert rows[-1].before_data == rows[1].after_data and rows[-1].after_data is None
    assert s.db.execute(
        text("SELECT before_data IS NULL, after_data IS NULL FROM audit_events WHERE id=:id"),
        {"id": rows[0].id},
    ).one() == (True, False)
    assert all(e.actor_user_id == s.teacher_users[0].id for e in rows)
    s.db.refresh(result)
    assert result.score == 8


def test_teacher_scope_subgroups_and_revoked_assignment(attendance):
    s = attendance
    assert s.write(teacher=1).status_code == 404
    assert s.write(teacher=2).status_code == 404  # lessons.teacher_id is insufficient
    assert s.write(student=1).status_code == 404
    subgroup = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    other = s.add(Subgroup, group_id=s.groups[0].id, name="B")
    group = s.db.scalar(select(LessonGroup).where(LessonGroup.lesson_id == s.lesson.id))
    group.subgroup_id = subgroup.id
    s.students[0].subgroup_id = subgroup.id
    s.students[2].subgroup_id = other.id
    s.db.flush()
    # Initial subgroup setup precedes this lesson, unlike a later transfer.
    s.lesson.starts_at = datetime.now(UTC)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    s.db.flush()
    assert s.write().status_code == 200
    assert s.write(student=2).status_code == 404
    assert s.read(2, lesson=s.lesson.id).status_code == 404
    assert s.read(1, lesson=s.lesson.id).status_code == 404
    s.db.delete(s.grants[0])
    s.db.flush()
    assert s.write("absent").status_code == 404
    assert s.write(method="delete").status_code == 404


@pytest.mark.parametrize("transfer", ["group", "subgroup"])
def test_history_after_transfer_only_staff_can_correct_existing(attendance, transfer):
    s = attendance
    subgroup = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    other = s.add(Subgroup, group_id=s.groups[0].id, name="B")
    group = s.db.scalar(select(LessonGroup).where(LessonGroup.lesson_id == s.lesson.id))
    group.subgroup_id = subgroup.id
    s.students[0].subgroup_id = subgroup.id
    s.db.flush()
    # Initial subgroup setup precedes this lesson, unlike a later transfer.
    s.lesson.starts_at = datetime.now(UTC)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    s.db.flush()
    assert s.write().status_code == 200
    empty = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=s.lesson.starts_at,
        ends_at=s.lesson.ends_at,
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=empty.id, group_id=s.groups[0].id, subgroup_id=subgroup.id)
    update_student_group(
        s.db,
        s.students[0].id,
        s.groups[1 if transfer == "group" else 0].id,
        other.id if transfer == "subgroup" else None,
    )
    assert s.write("absent").status_code == 404
    assert s.write(method="delete").status_code == 404
    assert s.write("absent", teacher=1).status_code == 404
    assert s.read(lesson=s.lesson.id).json()["status"] == "attended"
    assert s.read(lesson=empty.id).status_code == 404
    assert s.read(lesson_id=str(empty.id)).json()["items"] == []
    assert [r["lesson_id"] for r in s.read().json()["items"]] == [str(s.lesson.id)]
    token, grant = s.staff()
    assert s.write("absent", token=token).status_code == 200
    assert s.write(lesson=empty.id, token=token).status_code == 404
    assert s.write(method="delete", token=token).status_code == 200
    assert s.write(token=token).status_code == 404
    assert s.read(lesson=s.lesson.id).status_code == 404
    assert s.read().json()["items"] == []
    assert len(events(s)) == 3


@pytest.mark.parametrize("status", ["cancelled", "moved"])
def test_lesson_state_time_and_independent_replacement(attendance, status):
    s = attendance
    assert s.write().status_code == 200
    s.lesson.status = status
    s.db.flush()
    assert s.write("absent").status_code == 409
    assert s.write(method="delete").status_code == 409
    assert s.write(student=2).status_code == 409
    token, _ = s.staff()
    assert s.write(student=2, token=token).status_code == 409
    assert s.read(lesson=s.lesson.id).json()["status"] == "attended"
    assert s.write("absent", token=token).status_code == 200
    replacement = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        previous_lesson_id=s.lesson.id,
        starts_at=datetime.now(UTC),
        ends_at=datetime.now(UTC) + timedelta(hours=1),
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=replacement.id, group_id=s.groups[0].id)
    assert s.read(lesson=replacement.id).json()["status"] == "unmarked"
    assert s.write(lesson=replacement.id).status_code == 200
    assert s.read(lesson=s.lesson.id).json()["status"] == "absent"
    assert s.write(method="delete", token=token).status_code == 200
    assert s.read(lesson=replacement.id).json()["status"] == "attended"


def test_teacher_cannot_change_future_attendance_and_staff_cannot_create_future_mark(attendance):
    s = attendance
    assert s.write("attended").status_code == 200
    s.lesson.starts_at = datetime.now(UTC) + timedelta(hours=2)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    s.db.flush()

    assert s.write("absent").status_code == 409
    assert s.read(lesson=s.lesson.id).json()["status"] == "attended"
    assert s.write(method="delete").status_code == 409
    assert s.write("attended", student=2).status_code == 409

    token, _ = s.staff()
    assert s.write("absent", student=0, token=token).status_code == 409


def test_effective_staff_permissions_and_unsafe_requests(attendance):
    s = attendance
    for kwargs in [
        dict(permission="grades.edit"),
        dict(unit_type="department"),
        dict(role="admin"),
    ]:
        token, _ = s.staff(**kwargs)
        assert s.write(token=token).status_code == 403
    token, grant = s.staff()
    assert s.write(token=token).status_code == 200
    s.db.delete(grant)
    s.db.flush()
    assert s.write("absent", token=token).status_code == 403
    assert s.write(token=s.tokens[0]).status_code == 403
    assert s.client.get("/api/v1/attendance").status_code == 401
    assert s.read(student_id=str(s.students[1].id)).status_code == 422
    assert s.read(group_id=str(s.groups[1].id)).status_code == 422
    assert s.read(lesson="9223372036854775808").status_code == 422
    path = f"/api/v1/attendance/lessons/{s.lesson.id}/students/{s.students[0].id}"
    for payload in [{"status": "unmarked"}, {"status": "absent", "actor_user_id": "1"}]:
        assert (
            s.client.put(
                path, json=payload, headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"}
            ).status_code
            == 422
        )


def test_audit_failure_rolls_back_mark_through_api(attendance, monkeypatch):
    s = attendance
    # Persist fixture within outer test transaction before testing service rollback.
    s.db.commit()

    def fail(*args, **kwargs):
        args[0].flush()
        raise ValueError("forced audit validation failure")

    monkeypatch.setattr("app.attendance.service.write_audit_event", fail)
    assert s.write().status_code == 500
    assert s.db.get(Attendance, (s.lesson.id, s.students[0].id)) is None
    assert events(s) == []


def test_attendance_pk_fk_and_status(attendance):
    s = attendance
    values = dict(
        lesson_id=s.lesson.id,
        student_id=s.students[0].id,
        status="attended",
        marked_by_user_id=s.teacher_users[0].id,
    )
    s.add(Attendance, **values)
    for change in [
        {},
        {"status": "unmarked", "student_id": s.students[2].id},
        {"lesson_id": 9223372036854775807},
        {"student_id": 9223372036854775807},
        {"student_id": s.students[2].id, "marked_by_user_id": 9223372036854775807},
    ]:
        with pytest.raises(IntegrityError), s.db.begin_nested():
            s.add(Attendance, **(values | change))


@pytest.mark.parametrize(
    "snapshot",
    [
        {"status": "attended"},
        {"student_id": 1},
        {"student_id": 0, "status": "attended"},
        {"student_id": True, "status": "attended"},
        {"student_id": "1", "status": "attended"},
        {"student_id": None, "status": "attended"},
        {"student_id": 1, "status": "unmarked"},
        {"student_id": 1, "status": "attended", "secret": "never store"},
    ],
)
def test_audit_attendance_rejects_invalid_snapshots(attendance, snapshot):
    from app.audit import write_audit_event

    s = attendance
    with pytest.raises(ValueError):
        write_audit_event(
            s.db,
            actor=s.teacher_users[0],
            entity_type="attendance",
            entity_id=s.lesson.id,
            action="create",
            before_data=None,
            after_data=snapshot,
        )
    assert events(s) == []


def test_student_pagination_never_reveals_other_group(attendance):
    s = attendance
    for _ in range(3):
        lesson = s.add(
            Lesson,
            course_offering_id=s.courses[0].id,
            starts_at=s.lesson.starts_at,
            ends_at=s.lesson.ends_at,
            kind="lab",
        )
        s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id)
    cursor, ids = None, []
    while True:
        response = s.read(limit=1, **({"cursor": cursor} if cursor else {}))
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        page = response.json()
        ids += [item["lesson_id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(ids) == len(set(ids)) == 4
    assert s.read(1).json()["items"] == []


@pytest.mark.parametrize(
    "before,after",
    [
        ({"student_id": 1, "status": "attended"}, {"student_id": 2, "status": "absent"}),
        ({"student_id": 1, "status": "attended"}, {"student_id": 1, "status": "attended"}),
    ],
)
def test_attendance_audit_rejects_mismatched_identity_or_noop(attendance, before, after):
    from app.audit import write_audit_event

    s = attendance
    with pytest.raises(ValueError):
        write_audit_event(
            s.db,
            actor=s.teacher_users[0],
            entity_type="attendance",
            entity_id=s.lesson.id,
            action="update",
            before_data=before,
            after_data=after,
        )
    assert events(s) == []
