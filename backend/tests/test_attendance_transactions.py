"""Durability, database lock waits and actual production runtime privileges."""

import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_attendance_integration import attendance as attendance_fixture

from app.attendance.service import update_attendance
from app.dependencies.database import get_db_session
from app.models import Attendance, AuditEvent, Lesson, User
from app.student_service import update_student_group

pytestmark = pytest.mark.integration


@pytest.fixture
def committed_attendance(migration_database):  # noqa: F811
    run_migration(migration_database, "upgrade", "head")
    with Session(migration_database, expire_on_commit=False, autoflush=False) as db:
        s = attendance_fixture.__wrapped__(db)
        db.commit()
        yield s


def wait_for_block(engine, pid, future):
    with engine.connect() as monitor:
        deadline = time.monotonic() + 5
        while not monitor.scalar(text("SELECT cardinality(pg_blocking_pids(:pid))"), {"pid": pid}):
            assert not future.done(), "Expected a real PostgreSQL lock wait"
            assert time.monotonic() < deadline, "PostgreSQL lock wait was not observed"
            time.sleep(0.01)


@pytest.mark.parametrize(
    "initial,first_status,second_status,actions",
    [
        (None, "attended", "absent", ["create", "update"]),
        (None, "attended", "attended", ["create"]),
        ("absent", "attended", None, ["create", "update", "delete"]),
        ("absent", None, "attended", ["create", "delete", "create"]),
        ("absent", None, None, ["create", "delete"]),
    ],
)
def test_concurrent_writes_are_serialized_with_complete_audit(
    committed_attendance,
    initial,
    first_status,
    second_status,
    actions,
):
    s = committed_attendance
    engine = s.db.bind
    actor_id, student_id, lesson_id = s.teacher_users[0].id, s.students[0].id, s.lesson.id
    if initial:
        update_attendance(s.db, s.db.get(User, actor_id), lesson_id, student_id, initial)
    with Session(engine, autoflush=False) as first, Session(engine, autoflush=False) as second:
        first.scalar(select(Lesson).where(Lesson.id == lesson_id).with_for_update())
        pid = second.scalar(text("SELECT pg_backend_pid()"))

        def write_second():
            return update_attendance(
                second, second.get(User, actor_id), lesson_id, student_id, second_status
            )

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(write_second)
            wait_for_block(engine, pid, future)
            update_attendance(first, first.get(User, actor_id), lesson_id, student_id, first_status)
            assert future.result(timeout=10).status == (second_status or "unmarked")
    s.db.expire_all()
    mark = s.db.get(Attendance, (lesson_id, student_id))
    assert (mark.status if mark else None) == second_status
    rows = s.db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()
    assert [row.action for row in rows] == actions
    previous = None
    for row in rows:
        assert row.before_data == previous
        previous = row.after_data
    assert previous == (
        {"student_id": student_id, "status": second_status} if second_status else None
    )


def test_transfer_committed_while_write_waits_revokes_old_teacher(committed_attendance):
    s = committed_attendance
    engine = s.db.bind
    lesson_id, student_id, actor_id = s.lesson.id, s.students[0].id, s.teacher_users[0].id
    assert s.write().status_code == 200
    with Session(engine) as transfer, Session(engine) as writer:
        update_student_group(transfer, student_id, s.groups[1].id)
        pid = writer.scalar(text("SELECT pg_backend_pid()"))

        def write():
            from fastapi import HTTPException

            try:
                update_attendance(
                    writer, writer.get(User, actor_id), lesson_id, student_id, "absent"
                )
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(write)
            wait_for_block(engine, pid, future)
            transfer.commit()
            assert future.result(timeout=10) == 404
    s.db.expire_all()
    assert s.db.get(Attendance, (lesson_id, student_id)).status == "attended"


@pytest.mark.parametrize("operation", ["create", "update", "delete"])
def test_postgresql_audit_failure_rolls_back_api_change(committed_attendance, operation):
    s = committed_attendance
    engine = s.db.bind

    def session():
        with Session(engine, autoflush=False) as db:
            yield db

    s.app.dependency_overrides[get_db_session] = session
    if operation != "create":
        assert s.write().status_code == 200
    with engine.begin() as db:
        db.execute(
            text(
                "CREATE FUNCTION fail_attendance_audit() RETURNS trigger LANGUAGE plpgsql "
                "AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END $$"
            )
        )
        db.execute(
            text(
                "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events "
                "FOR EACH ROW EXECUTE FUNCTION fail_attendance_audit()"
            )
        )
    response = s.write("absent", method="delete" if operation == "delete" else "put")
    assert response.status_code == 500
    with engine.connect() as db:
        expected = int(operation != "create")
        assert db.scalar(text("SELECT count(*) FROM attendance")) == expected
        assert db.scalar(text("SELECT count(*) FROM audit_events")) == expected
        if expected:
            assert db.scalar(text("SELECT status FROM attendance")) == "attended"


def test_real_production_acl_supports_attendance_and_append_only_audit(runtime_engine):  # noqa: F811
    engine, runtime = runtime_engine
    with Session(engine, expire_on_commit=False, autoflush=False) as admin:
        s = attendance_fixture.__wrapped__(admin)
        admin.commit()

        def session():
            with Session(runtime, autoflush=False) as db:
                yield db

        s.app.dependency_overrides[get_db_session] = session
        assert s.write().status_code == 200
        assert s.write("absent").status_code == 200
        assert s.read(lesson=s.lesson.id).json()["status"] == "absent"
        assert s.write(method="delete").status_code == 200
        with runtime.connect() as db:
            assert db.scalar(text("SELECT count(*) FROM attendance")) == 0
        for statement in [
            "UPDATE audit_events SET action='delete'",
            "DELETE FROM audit_events",
            "SELECT before_data FROM audit_events",
            "UPDATE lessons SET status='cancelled'",
            "UPDATE students SET group_id=group_id",
            "UPDATE students SET membership_version=0",
            "UPDATE students SET membership_changed_at=clock_timestamp()",
            "DELETE FROM teaching_assignments",
        ]:
            with runtime.begin() as db, pytest.raises(DBAPIError) as error:
                db.execute(text(statement))
            assert error.value.orig.sqlstate == "42501"
        with engine.connect() as db:
            assert db.scalar(text("SELECT count(*) FROM audit_events")) == 3


@pytest.mark.parametrize("change", ["cancelled", "moved", "revoke"])
def test_scope_and_lesson_state_are_rechecked_after_lock_wait(committed_attendance, change):
    from fastapi import HTTPException
    from sqlalchemy import delete

    from app.models import TeachingAssignment

    s = committed_attendance
    engine = s.db.bind
    lesson_id, student_id, actor_id = s.lesson.id, s.students[0].id, s.teacher_users[0].id
    with Session(engine) as edit, Session(engine) as writer:
        lesson = edit.scalar(select(Lesson).where(Lesson.id == lesson_id).with_for_update())
        if change == "revoke":
            edit.execute(delete(TeachingAssignment).where(TeachingAssignment.id == s.grants[0].id))
        else:
            lesson.status = change
        edit.flush()
        pid = writer.scalar(text("SELECT pg_backend_pid()"))

        def write():
            try:
                update_attendance(
                    writer, writer.get(User, actor_id), lesson_id, student_id, "attended"
                )
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(write)
            wait_for_block(engine, pid, future)
            edit.commit()
            assert future.result(timeout=10) == (404 if change == "revoke" else 409)
    with engine.connect() as db:
        assert db.scalar(text("SELECT count(*) FROM attendance")) == 0
        assert db.scalar(text("SELECT count(*) FROM audit_events")) == 0
