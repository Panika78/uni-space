"""Real independent transactions, #74 lock protocol and production ACL."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from threading import Event
from time import monotonic

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_teaching_integration import journal as journal_fixture

from app.audit import write_audit_event
from app.dependencies.database import get_db_session
from app.models import AssessmentGroup, AuditEvent, Lesson, LessonGroup, User
from app.teaching.dates import get_date_snapshot, update_assessment_dates
from app.teaching.schemas import AssessmentDatesRequest

pytestmark = pytest.mark.integration


def create_context(db):
    s = journal_fixture.__wrapped__(db)
    s.work = s.assignment(s.courses[0])
    s.result(s.work, 7)
    s.lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=datetime(2026, 9, 1, 22, tzinfo=UTC),
        ends_at=datetime(2026, 9, 1, 23, tzinfo=UTC),
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[0].id)
    s.work.lesson_id = s.lesson.id
    s.work.planned_date = date(2026, 9, 2)
    s.work.date_needs_confirmation = True
    db.commit()
    s.actor_id = s.teacher_users[0].id
    s.work_id, s.lesson_id = s.work.id, s.lesson.id
    s.path = f"/api/v1/teaching/courses/{s.courses[0].id}/assessments/{s.work.assessment_id}/dates"
    s.body = {
        "items": [
            {
                "assessment_group_id": str(s.work.id),
                "planned_date": "2026-09-02",
                "lesson_id": str(s.lesson.id),
            }
        ]
    }
    s.headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}
    return s


def cleanup_context(s):
    s.db.rollback()
    s.db.execute(
        delete(AuditEvent).where(AuditEvent.actor_user_id.in_([u.id for u in s.teacher_users]))
    )
    s.db.get(AssessmentGroup, s.work_id).lesson_id = None
    s.db.flush()
    for obj in reversed(s.created):
        s.db.delete(obj)
        s.db.flush()
    s.db.commit()


@pytest.fixture
def committed_dates(postgresql_engine):
    with Session(postgresql_engine, expire_on_commit=False) as db:
        s = create_context(db)

        def request_db():
            with Session(postgresql_engine) as session:
                yield session

        s.app.dependency_overrides[get_db_session] = request_db
        try:
            yield s
        finally:
            cleanup_context(s)


def mark_cancelled(db, s, status):
    # #74 owns this operation: lock lesson, retain link/date, flag and audit
    # linked works in the SAME transaction. No schedule CRUD is added by #71.
    lesson = db.scalar(select(Lesson).where(Lesson.id == s.lesson_id).with_for_update())
    lesson.status = status
    row = db.scalar(
        select(AssessmentGroup).where(AssessmentGroup.id == s.work_id).with_for_update()
    )
    before = get_date_snapshot(row)
    row.date_needs_confirmation = True
    if before != get_date_snapshot(row):
        write_audit_event(
            db,
            actor=db.get(User, s.actor_id),
            entity_type="assessment_group",
            entity_id=row.id,
            action="update",
            before_data=before,
            after_data=get_date_snapshot(row),
        )


@pytest.mark.parametrize("status", ["cancelled", "moved"])
def test_cancellation_first_conflicts_then_cannot_confirm(committed_dates, status):
    s = committed_dates
    with Session(s.db.bind) as cancellation:
        mark_cancelled(cancellation, s, status)
        response = s.client.patch(s.path, json=s.body, headers=s.headers)
        assert response.status_code == 409, response.text
        cancellation.commit()
    assert s.client.patch(s.path, json=s.body, headers=s.headers).status_code == 422
    s.db.expire_all()
    assert s.db.get(AssessmentGroup, s.work_id).date_needs_confirmation
    assert s.db.get(AssessmentGroup, s.work_id).lesson_id == s.lesson_id


@pytest.mark.parametrize("status", ["cancelled", "moved"])
def test_confirmation_first_holds_lesson_until_commit_and_cancellation_marks_again(
    committed_dates, status
):
    s = committed_dates
    started = Event()
    pids = []

    def cancel():
        with Session(s.db.bind) as cancellation:
            pids.append(cancellation.scalar(text("SELECT pg_backend_pid()")))
            started.set()
            mark_cancelled(cancellation, s, status)
            cancellation.commit()

    with Session(s.db.bind) as confirmation:
        update_assessment_dates(
            confirmation,
            confirmation.get(User, s.actor_id),
            s.courses[0].id,
            s.work.assessment_id,
            AssessmentDatesRequest.model_validate(s.body),
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(cancel)
            try:
                assert started.wait(5)
                deadline = monotonic() + 5
                with s.db.bind.connect() as observer:
                    while monotonic() < deadline:
                        if observer.scalar(
                            text("SELECT cardinality(pg_blocking_pids(:pid))"), {"pid": pids[0]}
                        ):
                            break
                    else:
                        pytest.fail("Cancellation was not blocked by confirmation's lesson lock")
                assert not future.done()
            finally:
                confirmation.commit()
            future.result(timeout=10)
    s.db.expire_all()
    row = s.db.get(AssessmentGroup, s.work_id)
    assert row.date_needs_confirmation and row.lesson_id == s.lesson_id
    audit = s.db.scalars(
        select(AuditEvent)
        .where(AuditEvent.entity_type == "assessment_group", AuditEvent.entity_id == row.id)
        .order_by(AuditEvent.id)
    ).all()
    assert [event.after_data["date_needs_confirmation"] for event in audit] == [False, True]


def test_runtime_role_can_confirm_with_audit_and_cannot_modify_structure(runtime_engine):  # noqa: F811
    admin, runtime = runtime_engine
    with Session(admin, expire_on_commit=False) as db:
        s = create_context(db)

        def runtime_session():
            with Session(runtime) as session:
                yield session

        s.app.dependency_overrides[get_db_session] = runtime_session
        try:
            response = s.client.patch(s.path, json=s.body, headers=s.headers)
            assert response.status_code == 200, response.text
            # No-op and explicit NULL work under the same production grants.
            assert s.client.patch(s.path, json=s.body, headers=s.headers).status_code == 200
            s.body["items"][0].update(planned_date=None, lesson_id=None)
            assert s.client.patch(s.path, json=s.body, headers=s.headers).status_code == 200
            for sql in (
                "UPDATE assessment_groups SET assessment_id=assessment_id",
                "UPDATE assessment_groups SET group_id=group_id",
                "INSERT INTO assessment_groups (assessment_id,group_id) VALUES (1,1)",
                "DELETE FROM assessment_groups",
                "DELETE FROM assessments",
                "TRUNCATE assessment_results",
                "UPDATE audit_events SET action=action",
                "DELETE FROM audit_events",
                "SELECT before_data FROM audit_events",
                "SELECT nextval('audit_events_id_seq')",
                "DELETE FROM lessons",
            ):
                with runtime.connect() as connection, pytest.raises(DBAPIError) as rejected:
                    connection.execute(text(sql))
                assert rejected.value.orig.sqlstate == "42501"
            assert (
                len(
                    db.scalars(
                        select(AuditEvent).where(
                            AuditEvent.entity_id == s.work_id,
                            AuditEvent.entity_type == "assessment_group",
                        )
                    ).all()
                )
                == 2
            )
        finally:
            cleanup_context(s)
