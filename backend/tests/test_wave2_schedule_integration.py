"""Exercise the integrated date, score, attendance and editor HTTP contracts."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from time import monotonic
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event as sql_event
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_assessment_dates_transactions import create_context
from test_teaching_integration import create_staff

from app.attendance.router import router as attendance_router
from app.dependencies.database import get_db_session
from app.models import (
    AssessmentGroup,
    AssessmentResult,
    Attendance,
    AuditEvent,
    Lesson,
    StaffPermission,
)
from app.schedule.editor_router import router as editor_router

pytestmark = pytest.mark.integration


@pytest.fixture
def integrated(runtime_engine):  # noqa: F811
    admin_engine, api_engine = runtime_engine
    with Session(admin_engine, expire_on_commit=False) as db:
        s = create_context(db)
        s.app.include_router(editor_router)
        s.app.include_router(attendance_router)
        staff, headers = create_staff(s, permission=False)
        from app.models import StaffProfile

        profile = db.scalar(select(StaffProfile).where(StaffProfile.user_id == staff.id))
        s.add(StaffPermission, staff_profile_id=profile.id, permission_code="schedule.edit")
        # The real membership boundary precedes this newly started lesson.
        s.lesson.starts_at = datetime.now(UTC)
        s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
        s.expected_date = s.lesson.starts_at.astimezone(ZoneInfo("Europe/Moscow")).date()
        s.work.planned_date = s.expected_date
        s.body["items"][0]["planned_date"] = s.expected_date.isoformat()
        db.commit()

        def runtime_session():
            with Session(api_engine) as session:
                yield session

        s.app.dependency_overrides[get_db_session] = runtime_session
        s.course_id, s.group_id, s.teacher_id = s.courses[0].id, s.groups[0].id, s.teachers[0].id
        s.api_engine = api_engine
        s.editor_headers = headers
        s.mark_path = f"/api/v1/attendance/lessons/{s.lesson_id}/students/{s.students[0].id}"
        s.score_path = (
            f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
            f"/assessments/{s.work_id}/results/{s.students[0].id}"
        )
        for path, body in [(s.score_path, {"score": 9}), (s.mark_path, {"status": "attended"})]:
            response = s.client.put(path, json=body, headers=s.headers)
            assert response.status_code == 200, (path, response.text)
        response = s.client.patch(s.path, json=s.body, headers=s.headers)
        assert response.status_code == 200, response.text
        db.expire_all()
        yield s


def change_lesson(s, action):
    with Session(s.api_engine) as reader:
        lesson = reader.get(Lesson, s.lesson_id)
        version, starts_at, ends_at = lesson.version, lesson.starts_at, lesson.ends_at
    body = {"version": version}
    if action == "move":
        body.update(
            course_offering_id=str(s.course_id),
            teacher_id=str(s.teacher_id),
            starts_at=(starts_at + timedelta(days=1)).isoformat(),
            ends_at=(ends_at + timedelta(days=1)).isoformat(),
            kind="lab",
            participants=[{"group_id": str(s.group_id), "subgroup_id": None}],
            room_ids=[],
        )
    return s.client.post(
        f"/api/v1/staff/schedule/lessons/{s.lesson_id}/{action}",
        json=body,
        headers=s.editor_headers,
    )


def snapshot(s):
    s.db.expire_all()
    return {
        table: s.db.scalar(text(f"SELECT jsonb_agg(to_jsonb(t)) FROM {table} t"))
        for table in (
            "lessons",
            "lesson_groups",
            "assessment_groups",
            "assessment_results",
            "attendance",
            "audit_events",
        )
    }


@pytest.mark.parametrize("action", ["cancel", "move"])
def test_editor_preserves_marks_and_scores_and_requires_teacher_date_confirmation(
    integrated, action
):
    s = integrated
    before = snapshot(s)
    response = change_lesson(s, action)
    assert response.status_code == (201 if action == "move" else 200), response.text
    after = snapshot(s)
    for table in ("assessment_results", "attendance"):
        assert after[table] == before[table]
    row = s.db.get(AssessmentGroup, s.work_id)
    assert (row.lesson_id, row.planned_date, row.date_needs_confirmation) == (
        s.lesson_id,
        s.expected_date,
        True,
    )
    assert s.db.get(Attendance, (s.lesson_id, s.students[0].id)).status == "attended"
    assert s.db.scalar(select(AssessmentResult.score)) == 9
    if action == "move":
        new_id = int(response.json()["id"])
        assert new_id != s.lesson_id
        assert s.db.get(Attendance, (new_id, s.students[0].id)) is None
    rejected = s.client.patch(s.path, json=s.body, headers=s.headers)
    assert rejected.status_code == 422, rejected.text
    assert snapshot(s) == after
    detached = {"items": [s.body["items"][0] | {"lesson_id": None}]}
    confirmed = s.client.patch(s.path, json=detached, headers=s.headers)
    assert confirmed.status_code == 200, confirmed.text
    s.db.expire_all()
    row = s.db.get(AssessmentGroup, s.work_id)
    assert row.lesson_id is None and row.date_needs_confirmation is False
    events = s.db.scalars(
        select(AuditEvent)
        .where(AuditEvent.entity_type == "assessment_group")
        .order_by(AuditEvent.id)
    ).all()
    assert [event.after_data["date_needs_confirmation"] for event in events] == [False, True, False]
    assert events[1].before_data == events[0].after_data
    assert events[2].before_data == events[1].after_data


@pytest.mark.parametrize("action", ["cancel", "move"])
@pytest.mark.parametrize("entity", ["lesson", "assessment_group"])
def test_editor_audit_failure_rolls_back_dates_marks_scores_and_lesson(
    integrated, monkeypatch, action, entity
):
    s = integrated
    before = snapshot(s)
    from app.schedule import editor_service

    writer = editor_service.write_audit_event

    def fail_after_flush(*args, **kwargs):
        event = writer(*args, **kwargs)
        if kwargs["entity_type"] == entity:
            raise ValueError("Fictional integrated audit failure")
        return event

    monkeypatch.setattr(editor_service, "write_audit_event", fail_after_flush)
    response = change_lesson(s, action)
    assert response.status_code == 500, response.text
    assert snapshot(s) == before


@pytest.mark.parametrize("action", ["cancel", "move"])
@pytest.mark.parametrize("first", ["teacher", "editor"])
def test_real_http_date_and_editor_race_never_confirms_cancelled_or_moved_lesson(
    integrated, monkeypatch, action, first
):
    from app.schedule import editor_service
    from app.teaching import dates

    s = integrated
    if first == "teacher":
        s.db.get(AssessmentGroup, s.work_id).date_needs_confirmation = True
        s.db.commit()
    held, release = Event(), Event()
    holder, waiter = [], []

    def observe_lock(connection, cursor, statement, parameters, context, executemany):
        pid = connection.connection.driver_connection.info.backend_pid
        if holder and pid != holder[0] and "FOR UPDATE" in statement:
            waiter.append(pid)

    sql_event.listen(s.api_engine, "before_cursor_execute", observe_lock)
    module = dates if first == "teacher" else editor_service
    writer = module.write_audit_event

    def hold_after_real_flush(*args, **kwargs):
        event = writer(*args, **kwargs)
        holder.append(args[0].scalar(text("SELECT pg_backend_pid()")))
        held.set()
        assert release.wait(30), "Test did not release the transaction holding real row locks"
        return event

    monkeypatch.setattr(module, "write_audit_event", hold_after_real_flush)

    def confirm():
        return s.client.patch(s.path, json=s.body, headers=s.headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(
            confirm if first == "teacher" else change_lesson,
            *(() if first == "teacher" else (s, action)),
        )
        second = None
        try:
            assert held.wait(10), "First HTTP operation never flushed its transactional audit"
            second = (
                pool.submit(change_lesson, s, action)
                if first == "teacher"
                else pool.submit(confirm)
            )
            if first == "teacher":
                deadline = monotonic() + 10
                while monotonic() < deadline:
                    blocked = waiter and s.db.scalar(
                        text("SELECT :holder = ANY(pg_blocking_pids(:waiter))"),
                        {"holder": holder[0], "waiter": waiter[-1]},
                    )
                    if blocked:
                        break
                else:
                    pytest.fail(
                        "Actual editor HTTP transaction never waited for teacher's row lock"
                    )
                assert not second.done()
            else:
                response = second.result(timeout=10)
                assert response.status_code == 409, response.text
            assert not pending.done()
        finally:
            release.set()
        response = pending.result(timeout=15)
        assert response.status_code == (201 if first == "editor" and action == "move" else 200), (
            response.text
        )
        if first == "teacher":
            response = second.result(timeout=15)
            assert response.status_code == (201 if action == "move" else 200), response.text
    if first == "editor":
        response = confirm()
        assert response.status_code == 422, response.text
    sql_event.remove(s.api_engine, "before_cursor_execute", observe_lock)
    s.db.expire_all()
    lesson = s.db.get(Lesson, s.lesson_id)
    row = s.db.get(AssessmentGroup, s.work_id)
    assert lesson.status == ("cancelled" if action == "cancel" else "moved")
    assert row.lesson_id == lesson.id and row.date_needs_confirmation is True
    assert s.db.scalar(select(AssessmentResult.score)) == 9
    assert s.db.get(Attendance, (s.lesson_id, s.students[0].id)).status == "attended"
