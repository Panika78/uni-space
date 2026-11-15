"""Cross-session PostgreSQL races with the #71 confirmation write contract."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_assessed_lesson_participants import add_assessment, link_assessment
from test_lesson_participants_integration import require_blocked_writer
from test_schedule_editor_integration import editor as editor_fixture
from test_schedule_integration import schedule as schedule_fixture

from app.models import AssessmentGroup, Lesson, User
from app.schedule.editor_router import save_operation
from app.schedule.editor_schemas import LessonWrite
from app.schedule.editor_service import mutate_lesson

pytestmark = pytest.mark.integration


@pytest.fixture
def committed_editor(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "head")
    with Session(engine) as db:
        e = editor_fixture.__wrapped__(schedule_fixture.__wrapped__(db))
        data = LessonWrite(**e.payload())
        item = save_operation(db, e.actor, "create", data=data)
        lesson = db.get(Lesson, int(item.id))
        assignment = link_assessment(db, add_assessment(db, lesson).id, lesson.id, e.groups[0].id)
        assignment.date_needs_confirmation = True
        db.commit()
        return SimpleNamespace(
            engine=engine,
            lesson_id=lesson.id,
            assignment_id=assignment.id,
            actor_id=e.actor.id,
            data=data,
        )


@pytest.mark.parametrize("action", ["cancel", "move"])
@pytest.mark.parametrize("winner", ["confirmation", "schedule"])
def test_confirmation_and_schedule_change_cannot_leave_false_flag(committed_editor, action, winner):
    s = committed_editor
    ready, proceed = Event(), Event()
    waiter_pid = []

    def execute(db, operation):
        if operation == "confirmation":
            # Exact shared DB contract for #71, not an alternative teacher API.
            db.execute(
                text("UPDATE assessment_groups SET date_needs_confirmation=false WHERE id=:id"),
                {"id": s.assignment_id},
            )
        else:
            mutate_lesson(
                db,
                db.get(User, s.actor_id),
                action,
                lesson_id=s.lesson_id,
                version=1,
                data=s.data if action == "move" else None,
            )

    def second():
        with Session(s.engine) as db:
            db.execute(text("SET LOCAL statement_timeout='5s'"))
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            ready.set()
            assert proceed.wait(5)
            execute(db, "schedule" if winner == "confirmation" else "confirmation")
            db.commit()

    with ThreadPoolExecutor(max_workers=1) as pool, Session(s.engine) as first:
        first.execute(text("SET LOCAL statement_timeout='5s'"))
        pid = first.scalar(text("SELECT pg_backend_pid()"))
        execute(first, winner)
        pending = pool.submit(second)
        try:
            assert ready.wait(5)
            proceed.set()
            require_blocked_writer(s.engine, pid, waiter_pid[0])
            first.commit()
        finally:
            first.rollback()
            proceed.set()
        if winner == "schedule":
            with pytest.raises(DBAPIError) as error:
                pending.result(timeout=5)
            assert error.value.orig.sqlstate == "23514"
        else:
            pending.result(timeout=5)
    with Session(s.engine) as db:
        assert db.get(AssessmentGroup, s.assignment_id).date_needs_confirmation is True
        assert db.get(Lesson, s.lesson_id).status == ("moved" if action == "move" else "cancelled")


def test_inverse_child_parent_lock_returns_409_and_rolls_back(committed_editor):
    s = committed_editor
    ready, proceed = Event(), Event()
    waiter_pid = []

    def confirm():
        with Session(s.engine) as db:
            db.execute(text("SET LOCAL statement_timeout='5s'"))
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            ready.set()
            assert proceed.wait(5)
            db.execute(
                text("UPDATE assessment_groups SET date_needs_confirmation=false WHERE id=:id"),
                {"id": s.assignment_id},
            )
            db.commit()

    with ThreadPoolExecutor(max_workers=1) as pool, Session(s.engine) as first:
        pid = first.scalar(text("SELECT pg_backend_pid()"))
        first.execute(select(Lesson).where(Lesson.id == s.lesson_id).with_for_update())
        pending = pool.submit(confirm)
        try:
            assert ready.wait(5)
            proceed.set()
            require_blocked_writer(s.engine, pid, waiter_pid[0])
            with pytest.raises(HTTPException) as error:
                save_operation(
                    first, first.get(User, s.actor_id), "cancel", lesson_id=s.lesson_id, version=1
                )
            assert error.value.status_code == 409 and error.value.detail == "concurrent_change"
        finally:
            first.rollback()
            proceed.set()
        pending.result(timeout=5)
    with Session(s.engine) as db:
        assert db.get(Lesson, s.lesson_id).status == "scheduled"
        assert db.get(Lesson, s.lesson_id).version == 1
        assert db.get(AssessmentGroup, s.assignment_id).date_needs_confirmation is False


def test_stale_repeatable_read_maps_serialization_failure_to_409(committed_editor):
    s = committed_editor
    with Session(s.engine) as stale:
        stale.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        stale.get(Lesson, s.lesson_id)
        with Session(s.engine) as first:
            save_operation(
                first, first.get(User, s.actor_id), "cancel", lesson_id=s.lesson_id, version=1
            )
        with pytest.raises(HTTPException) as error:
            save_operation(
                stale, stale.get(User, s.actor_id), "cancel", lesson_id=s.lesson_id, version=1
            )
        assert error.value.status_code == 409 and error.value.detail == "concurrent_change"
    with Session(s.engine) as db:
        assert db.get(Lesson, s.lesson_id).version == 2


def test_two_staff_writers_cannot_overwrite_same_version(committed_editor):
    s = committed_editor
    ready, proceed = Event(), Event()
    waiter_pid = []

    def second():
        with Session(s.engine) as db:
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            ready.set()
            assert proceed.wait(5)
            return save_operation(
                db, db.get(User, s.actor_id), "cancel", lesson_id=s.lesson_id, version=1
            )

    with ThreadPoolExecutor(max_workers=1) as pool, Session(s.engine) as first:
        pid = first.scalar(text("SELECT pg_backend_pid()"))
        mutate_lesson(
            first,
            first.get(User, s.actor_id),
            "update",
            lesson_id=s.lesson_id,
            version=1,
            data=s.data.model_copy(update={"room_ids": []}),
        )
        pending = pool.submit(second)
        try:
            assert ready.wait(5)
            proceed.set()
            require_blocked_writer(s.engine, pid, waiter_pid[0])
            first.commit()
        finally:
            first.rollback()
            proceed.set()
        with pytest.raises(HTTPException) as error:
            pending.result(timeout=5)
        assert error.value.detail == "version_conflict"
    with Session(s.engine) as db:
        assert db.get(Lesson, s.lesson_id).version == 2
        assert db.get(Lesson, s.lesson_id).status == "scheduled"
