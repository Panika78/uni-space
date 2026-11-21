"""Real production credentials, concurrent requests and durable audit rollback."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_final_results_integration import results as results_fixture
from test_final_results_integration import verify_transfer_and_staff_scope

from app.dependencies.database import get_db_session
from app.models import AuditEvent, FinalResult, StaffProfile, Teacher, User

pytestmark = pytest.mark.integration


@pytest.fixture
def committed_results(runtime_engine):  # noqa: F811
    admin_engine, api_engine = runtime_engine
    with Session(admin_engine, expire_on_commit=False) as admin:
        s = results_fixture.__wrapped__(admin)
        # No external transaction/savepoint: deferred role/profile FKs run here.
        admin.commit()
        assert not admin.in_transaction()

        def runtime_session():
            with Session(api_engine) as db:
                yield db

        s.app.dependency_overrides[get_db_session] = runtime_session
        yield s, admin_engine, api_engine


def test_runtime_acl_and_atomic_failure(committed_results, monkeypatch):
    s, admin_engine, api_engine = committed_results
    course_id, student_id = s.courses[0].id, s.students[0].id
    path = f"/api/v1/final-results/courses/{course_id}/students/{student_id}"
    headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}

    def request(method, body=None):
        return s.client.request(method, path, json=body, headers=headers)

    assert request("GET").status_code == 200
    assert request("POST", {"retake_location": "A-101"}).status_code == 409
    assert request("POST", {"grade_value": 2, "retake_location": "A-101"}).status_code == 200
    assert request("PATCH", {"retake_location": "B-202"}).status_code == 200
    assert request("PATCH", {"passed": False}).status_code == 422
    assert request("DELETE").status_code == 200
    other = path.replace(f"students/{student_id}", f"students/{s.students[1].id}")
    assert s.client.get(other, headers=headers).status_code == 404
    assert s.client.patch(other, json={"grade_value": 2}, headers=headers).status_code == 404
    with Session(admin_engine) as observer:
        rows = observer.scalars(
            select(FinalResult).where(FinalResult.course_offering_id == course_id)
        ).all()
        assert rows == []
        events = observer.scalars(
            select(AuditEvent)
            .where(AuditEvent.entity_type == "final_result")
            .order_by(AuditEvent.id)
        ).all()
        state = None
        for event in events:
            assert event.before_data == state
            state = event.after_data
        assert state is None
    assert request("POST", {"grade_value": 2, "retake_location": "A-101"}).status_code == 200
    # Fail after the real writer flushes both mutation and event, before commit.
    from app.final_results import write_audit_event

    def fail(*args, **kwargs):
        write_audit_event(*args, **kwargs)
        raise ValueError("simulated failure after audit flush")

    with monkeypatch.context() as patch:
        patch.setattr("app.final_results.write_audit_event", fail)
        for method, body in [("PATCH", {"grade_value": 5}), ("DELETE", None)]:
            assert request(method, body).status_code == 500
    assert request("GET").json()["grade_value"] == 2
    assert request("GET").json()["retake_location"] == "A-101"
    with api_engine.connect() as db:
        for privilege in ["UPDATE", "DELETE"]:
            assert not db.scalar(
                text("SELECT has_table_privilege(current_user,'audit_events',:p)"),
                {"p": privilege},
            )
            with pytest.raises(DBAPIError):
                db.execute(
                    text(
                        f"{privilege} "
                        + (
                            "FROM audit_events"
                            if privilege == "DELETE"
                            else "audit_events SET action='delete'"
                        )
                    )
                )
            db.rollback()
        assert not db.scalar(text("SELECT has_table_privilege(current_user,'users','UPDATE')"))
        for statement in (
            "UPDATE final_results SET student_id=student_id",
            "UPDATE final_results SET course_offering_id=course_offering_id",
            "UPDATE course_offerings SET attestation_type='exam'",
            "SELECT * FROM audit_events",
        ):
            with pytest.raises(DBAPIError):
                db.execute(text(statement))
            db.rollback()


def test_staff_scope_and_revocation_with_real_commits(committed_results):
    s, admin_engine, _ = committed_results
    verify_transfer_and_staff_scope(s)
    # Every s.save() committed fixture changes on an engine-bound session, then
    # the actual HTTP request ran using a different uni_space_api connection.
    assert not s.db.in_transaction()
    with Session(admin_engine) as observer:
        staff_ids = list(observer.scalars(select(StaffProfile.user_id)))
        assert len(staff_ids) == 3
        assert set(observer.scalars(select(User.role).where(User.id.in_(staff_ids)))) == {"staff"}
        assert observer.scalar(select(Teacher.id).where(Teacher.user_id.in_(staff_ids))) is None


@pytest.mark.parametrize(
    "operations,expected_grade",
    [
        ([("POST", {"grade_value": 2}), ("POST", {"grade_value": 3})], 3),
        ([("PATCH", {"grade_value": 4}), ("DELETE", None)], None),
    ],
)
def test_pair_lock_blocks_conflicting_transaction(committed_results, operations, expected_grade):
    s, admin_engine, api_engine = committed_results
    course_id, student_id = s.courses[0].id, s.students[0].id
    path = f"/api/v1/final-results/courses/{course_id}/students/{student_id}"
    headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}
    if operations[0][0] == "PATCH":
        assert s.save("POST", {"grade_value": 2}).status_code == 200
    first_locked, second_attempted, release_first = Event(), Event(), Event()
    pids = []

    def before_lock(connection, cursor, statement, parameters, context, executemany):
        if "pg_advisory_xact_lock" in statement:
            pids.append(connection.connection.driver_connection.info.backend_pid)
            if len(pids) == 2:
                second_attempted.set()

    def after_lock(connection, cursor, statement, parameters, context, executemany):
        if (
            "pg_advisory_xact_lock" in statement
            and connection.connection.driver_connection.info.backend_pid == pids[0]
        ):
            first_locked.set()
            assert release_first.wait(timeout=45), "Test did not release the first transaction"

    def request(operation):
        method, body = operation
        return s.client.request(method, path, json=body, headers=headers)

    event.listen(api_engine, "before_cursor_execute", before_lock)
    event.listen(api_engine, "after_cursor_execute", after_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(request, operations[0])
            try:
                assert first_locked.wait(timeout=10), "First request did not acquire the pair lock"
                second = pool.submit(request, operations[1])
                assert second_attempted.wait(timeout=10), "Second request never attempted the lock"
                assert pids[0] != pids[1]
                # Observe a real server-side lock wait, not merely overlapping HTTP sends.
                # Poll the lock manager (no sleep/random delay); the first lock is
                # released only after PostgreSQL identifies it as the blocker.
                with admin_engine.connect() as observer:
                    deadline = monotonic() + 10
                    while monotonic() < deadline:
                        blocked = observer.scalar(
                            text("SELECT :first = ANY(pg_blocking_pids(:second))"),
                            {"first": pids[0], "second": pids[1]},
                        )
                        if blocked:
                            break
                    assert blocked, "PostgreSQL did not observe the conflicting lock wait"
                    assert observer.scalar(
                        text(
                            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=:pid "
                            "AND locktype='advisory' AND NOT granted)"
                        ),
                        {"pid": pids[1]},
                    )
                    assert not first.done() and not second.done()
                    # The first request is held before its mutation; no uncommitted
                    # creation/update or audit may be visible to this connection.
                    row = observer.execute(
                        select(FinalResult.grade_value).where(
                            FinalResult.course_offering_id == course_id,
                            FinalResult.student_id == student_id,
                        )
                    ).first()
                    assert row == ((2,) if operations[0][0] == "PATCH" else None)
            finally:
                release_first.set()
            assert first.result(timeout=10).status_code == 200
            assert second.result(timeout=10).status_code == 200
    finally:
        release_first.set()
        event.remove(api_engine, "before_cursor_execute", before_lock)
        event.remove(api_engine, "after_cursor_execute", after_lock)

    with Session(admin_engine) as observer:
        rows = observer.scalars(
            select(FinalResult).where(
                FinalResult.course_offering_id == course_id, FinalResult.student_id == student_id
            )
        ).all()
        if expected_grade is None:
            assert rows == []
        else:
            assert len(rows) == 1 and rows[0].grade_value == expected_grade
        events = observer.scalars(
            select(AuditEvent)
            .where(AuditEvent.entity_type == "final_result")
            .order_by(AuditEvent.id)
        ).all()
        expected_actions = (
            ["create", "update"] if expected_grade is not None else ["create", "update", "delete"]
        )
        assert [entry.action for entry in events] == expected_actions
        state = None
        for entry in events:
            assert entry.before_data == state
            state = entry.after_data
        if expected_grade is None:
            assert events[-2].before_data["grade_value"] == 2
            assert events[-2].after_data["grade_value"] == 4
            assert events[-1].before_data["grade_value"] == 4
            assert state is None
        else:
            assert events[0].after_data["grade_value"] == 2
            assert events[1].before_data["grade_value"] == 2
            assert state["grade_value"] == 3
