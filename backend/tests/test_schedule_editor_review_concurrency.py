"""Database invariants across independent READ COMMITTED / REPEATABLE READ sessions."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_lesson_participants_integration import (  # noqa: F401
    committed_lesson,
    require_blocked_writer,
)
from test_schedule_editor_concurrency import committed_editor  # noqa: F401

from app.models import CourseGroup, Lesson, Room, Subgroup, User
from app.schedule.editor_router import save_operation
from app.schedule.editor_service import get_editor_lesson

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
@pytest.mark.parametrize("winner", ["insert", "delete"])
def test_course_group_delete_races_child_insert_without_write_skew(
    committed_lesson,  # noqa: F811
    isolation,
    winner,
):
    s = committed_lesson
    with s.engine.begin() as c:
        c.execute(text("DELETE FROM lesson_groups WHERE lesson_id=:l"), {"l": s.lesson_id})
    ready, proceed = Event(), Event()
    pids = []

    def act(db, operation):
        if operation == "insert":
            db.execute(
                text("INSERT INTO lesson_groups(lesson_id,group_id) VALUES (:l,:g)"),
                {"l": s.lesson_id, "g": s.group_id},
            )
        else:
            db.execute(text("DELETE FROM course_groups WHERE group_id=:g"), {"g": s.group_id})

    def second():
        with Session(s.engine) as db:
            db.connection(execution_options={"isolation_level": isolation})
            db.execute(text("SET LOCAL statement_timeout='5s'"))
            pids.append(db.scalar(text("SELECT pg_backend_pid()")))
            db.execute(text("SELECT * FROM course_groups")).all()
            ready.set()
            assert proceed.wait(5)
            act(db, "delete" if winner == "insert" else "insert")
            db.commit()

    with ThreadPoolExecutor(max_workers=1) as pool, Session(s.engine) as first:
        pid = first.scalar(text("SELECT pg_backend_pid()"))
        pending = pool.submit(second)
        try:
            assert ready.wait(5)
            act(first, winner)
            proceed.set()
            if winner == "insert":
                require_blocked_writer(s.engine, pid, pids[0])
                first.commit()
            else:
                with pytest.raises(DBAPIError) as error:
                    pending.result(timeout=5)
                assert error.value.orig.sqlstate == "55P03"
                first.commit()
        finally:
            first.rollback()
            proceed.set()
        if winner == "insert":
            with pytest.raises(DBAPIError) as error:
                pending.result(timeout=5)
            assert error.value.orig.sqlstate == (
                "23514" if isolation == "READ COMMITTED" else "40001"
            )
    with s.engine.connect() as c:
        assert (
            c.scalar(
                text(
                    "SELECT count(*) FROM lesson_groups g JOIN lessons l ON l.id=g.lesson_id "
                    "LEFT JOIN course_groups cg ON cg.group_id=g.group_id "
                    "AND cg.course_offering_id=l.course_offering_id "
                    "WHERE cg.group_id IS NULL"
                )
            )
            == 0
        )
        assert c.scalar(
            text("SELECT count(*) FROM lesson_groups WHERE lesson_id=:l"), {"l": s.lesson_id}
        ) == (1 if winner == "insert" else 0)


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
@pytest.mark.parametrize(
    "table,operation",
    [
        ("lesson_groups", "insert"),
        ("lesson_groups", "update"),
        ("lesson_rooms", "insert"),
        ("lesson_rooms", "update"),
        ("lesson_rooms", "delete"),
    ],
)
def test_stale_snapshot_cannot_overwrite_committed_raw_links(
    committed_editor,  # noqa: F811
    isolation,
    table,
    operation,
):
    s = committed_editor
    with Session(s.engine) as stale:
        stale.connection(execution_options={"isolation_level": isolation})
        old = get_editor_lesson(stale, s.lesson_id)
        with Session(s.engine) as raw:
            if table == "lesson_groups" and operation == "update":
                subgroup = raw.scalar(
                    select(Subgroup.id)
                    .where(Subgroup.group_id == int(s.data.participants[0].group_id))
                    .limit(1)
                )
                raw.execute(
                    text("UPDATE lesson_groups SET subgroup_id=:s WHERE lesson_id=:l"),
                    {"s": subgroup, "l": s.lesson_id},
                )
            elif table == "lesson_groups":
                group_id = raw.scalar(
                    select(CourseGroup.group_id).where(
                        CourseGroup.course_offering_id == int(s.data.course_offering_id),
                        CourseGroup.group_id != int(s.data.participants[0].group_id),
                    )
                )
                raw.execute(
                    text("INSERT INTO lesson_groups(lesson_id,group_id) VALUES (:l,:g)"),
                    {"l": s.lesson_id, "g": group_id},
                )
            elif operation == "delete":
                raw.execute(text("DELETE FROM lesson_rooms WHERE lesson_id=:l"), {"l": s.lesson_id})
            else:
                room_id = raw.scalar(select(Room.id).where(Room.id != int(s.data.room_ids[0])))
                sql = (
                    "INSERT INTO lesson_rooms(lesson_id,room_id) VALUES (:l,:r)"
                    if operation == "insert"
                    else "UPDATE lesson_rooms SET room_id=:r WHERE lesson_id=:l"
                )
                raw.execute(text(sql), {"l": s.lesson_id, "r": room_id})
            raw_state = get_editor_lesson(raw, s.lesson_id)
            raw.commit()
        with pytest.raises(HTTPException) as error:
            save_operation(
                stale,
                stale.get(User, s.actor_id),
                "update",
                lesson_id=s.lesson_id,
                version=old.version,
                data=s.data,
            )
        assert error.value.status_code == 409
        assert error.value.detail == (
            "version_conflict" if isolation == "READ COMMITTED" else "concurrent_change"
        )
    with Session(s.engine) as db:
        current = get_editor_lesson(db, s.lesson_id)
        assert current.version == old.version + 1
        assert current == raw_state
        assert db.scalar(text("SELECT count(*) FROM audit_events WHERE entity_type='lesson'")) == 1


def test_group_lock_held_by_teacher_cannot_deadlock_child_writer(committed_lesson):  # noqa: F811
    s = committed_lesson
    with Session(s.engine) as teacher, Session(s.engine) as editor:
        teacher.execute(
            text("SELECT * FROM course_groups WHERE group_id=:g FOR SHARE"), {"g": s.group_id}
        )
        editor.execute(select(Lesson).where(Lesson.id == s.lesson_id).with_for_update())
        with pytest.raises(DBAPIError) as error:
            editor.execute(
                text("UPDATE lesson_groups SET subgroup_id=:s WHERE lesson_id=:l"),
                {"s": s.a_id, "l": s.lesson_id},
            )
        assert error.value.orig.sqlstate == "55P03"
        editor.rollback()
        teacher.execute(select(Lesson).where(Lesson.id == s.lesson_id).with_for_update())
