"""Subgroup replacements preserve the assessed lesson/group link, including raw SQL."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_lesson_participants_integration import (  # noqa: F401
    committed_lesson,  # noqa: F811
    list_participants,
    require_blocked_writer,
)
from test_subgroups_integration import schedule_fixture, subgroups  # noqa: F401

from app.models import Assessment, AssessmentGroup, Lesson, LessonGroup
from app.schedule.participants import Participant, replace_lesson_participants

pytestmark = pytest.mark.integration


def add_assessment(db, lesson):
    work = Assessment(
        course_offering_id=lesson.course_offering_id,
        title="Общая контрольная",
        type="test",
        max_score=10,
    )
    db.add(work)
    db.flush()
    return work


def link_assessment(db, work_id, lesson_id, group_id):
    assignment = AssessmentGroup(assessment_id=work_id, lesson_id=lesson_id, group_id=group_id)
    db.add(assignment)
    db.flush()
    return assignment


@pytest.mark.parametrize("initial,target", [("both", "b"), ("a", "b"), ("whole", "a")])
def test_replace_assessed_subgroups_keeps_group_and_versions_once(subgroups, initial, target):  # noqa: F811
    s = subgroups
    lesson = s.lesson()
    group = s.groups[0].id
    before = {"both": [s.a.id, s.b.id], "a": [s.a.id], "whole": [None]}[initial]
    replace_lesson_participants(s.db, lesson.id, [Participant(group, i) for i in before])
    work = add_assessment(s.db, lesson)
    assignment = link_assessment(s.db, work.id, lesson.id, group)
    version = lesson.version
    desired = [Participant(group, s.a.id if target == "a" else s.b.id)]
    replace_lesson_participants(s.db, lesson.id, desired)
    assert list_participants(s.db, lesson.id) == {(group, desired[0].subgroup_id)}
    assert lesson.version == version + 1
    replace_lesson_participants(s.db, lesson.id, desired)
    assert lesson.version == version + 1
    assert assignment.lesson_id == lesson.id and assignment.group_id == group


def test_removing_last_assessed_group_rolls_back_insertions_and_version(subgroups):  # noqa: F811
    s = subgroups
    lesson = s.assign(s.lesson(assigned=[]), s.a.id)
    work = add_assessment(s.db, lesson)
    link_assessment(s.db, work.id, lesson.id, s.groups[0].id)
    version = lesson.version
    with pytest.raises(IntegrityError), s.db.begin_nested():
        replace_lesson_participants(s.db, lesson.id, [Participant(s.groups[1].id)])
    assert list_participants(s.db, lesson.id) == {(s.groups[0].id, s.a.id)}
    assert lesson.version == version


def mutation_sql(action):
    return {
        "delete": "DELETE FROM lesson_groups WHERE id=:id",
        "group": "UPDATE lesson_groups SET group_id=:other_group, subgroup_id=NULL WHERE id=:id",
        "lesson": "UPDATE lesson_groups SET lesson_id=:other_lesson WHERE id=:id",
    }[action]


@pytest.mark.parametrize("action", ["delete", "group", "lesson"])
def test_raw_sql_preserves_last_assessed_group_on_update_and_delete(subgroups, action):  # noqa: F811
    s = subgroups
    lesson = s.assign(s.lesson(assigned=[]), s.a.id, s.b.id)
    other = s.lesson(assigned=[])
    work = add_assessment(s.db, lesson)
    link_assessment(s.db, work.id, lesson.id, s.groups[0].id)
    rows = s.db.scalars(
        select(LessonGroup).where(LessonGroup.lesson_id == lesson.id).order_by(LessonGroup.id)
    ).all()
    values = {"other_group": s.groups[1].id, "other_lesson": other.id}
    s.db.execute(text(mutation_sql(action)), values | {"id": rows[0].id})
    assert len({p for p in list_participants(s.db, lesson.id) if p[0] == s.groups[0].id}) == 1
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(text(mutation_sql(action)), values | {"id": rows[1].id})
    assert len({p for p in list_participants(s.db, lesson.id) if p[0] == s.groups[0].id}) == 1


def test_bulk_delete_of_assessed_subgroups_rolls_back_entire_statement(subgroups):  # noqa: F811
    s = subgroups
    lesson = s.assign(s.lesson(assigned=[]), s.a.id, s.b.id)
    work = add_assessment(s.db, lesson)
    link_assessment(s.db, work.id, lesson.id, s.groups[0].id)
    with pytest.raises(IntegrityError), s.db.begin_nested():
        s.db.execute(text("DELETE FROM lesson_groups WHERE lesson_id=:id"), {"id": lesson.id})
    assert list_participants(s.db, lesson.id) == {
        (s.groups[0].id, s.a.id),
        (s.groups[0].id, s.b.id),
    }


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"])
@pytest.mark.parametrize("action", ["delete", "group"])
def test_concurrent_raw_removals_cannot_drop_last_assessed_group(
    committed_lesson,  # noqa: F811
    isolation,
    action,
):
    s = committed_lesson
    with Session(s.engine) as db:
        replace_lesson_participants(
            db, s.lesson_id, [Participant(s.group_id, s.a_id), Participant(s.group_id, s.b_id)]
        )
        lesson = db.get(Lesson, s.lesson_id)
        work = add_assessment(db, lesson)
        link_assessment(db, work.id, lesson.id, s.group_id)
        ids = list(
            db.scalars(
                select(LessonGroup.id)
                .where(LessonGroup.lesson_id == lesson.id)
                .order_by(LessonGroup.id)
            )
        )
        other_group = db.scalar(
            text("SELECT id FROM study_groups WHERE id<>:id LIMIT 1"), {"id": s.group_id}
        )
        db.commit()
    ready, proceed = Event(), Event()
    waiter_pid = []
    values = {"other_group": other_group}

    def second_removal():
        with Session(s.engine) as db:
            db.connection(execution_options={"isolation_level": isolation})
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            db.execute(select(LessonGroup).where(LessonGroup.lesson_id == s.lesson_id)).all()
            ready.set()
            assert proceed.wait(5)
            db.execute(text(mutation_sql(action)), values | {"id": ids[1]})
            db.commit()

    with ThreadPoolExecutor(max_workers=1) as pool, Session(s.engine) as first:
        pending = pool.submit(second_removal)
        try:
            assert ready.wait(5)
            pid = first.scalar(text("SELECT pg_backend_pid()"))
            first.execute(text(mutation_sql(action)), values | {"id": ids[0]})
            proceed.set()
            require_blocked_writer(s.engine, pid, waiter_pid[0])
            first.commit()
        finally:
            first.rollback()
            proceed.set()
        with pytest.raises(DBAPIError) as rejected:
            pending.result(timeout=5)
        assert rejected.value.orig.sqlstate == (
            "23514" if isolation == "READ COMMITTED" else "40001"
        )
    with Session(s.engine) as db:
        assert {p for p in list_participants(db, s.lesson_id) if p[0] == s.group_id} == {
            (s.group_id, s.b_id)
        }


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
@pytest.mark.parametrize("winner", ["assignment", "deletion"])
def test_assessment_creation_and_last_removal_share_parent_synchronization(
    committed_lesson,  # noqa: F811
    isolation,
    winner,
):
    s = committed_lesson
    with Session(s.engine) as db:
        work = add_assessment(db, db.get(Lesson, s.lesson_id))
        work_id = work.id
        row_id = db.scalar(select(LessonGroup.id).where(LessonGroup.lesson_id == s.lesson_id))
        db.commit()
    ready, proceed = Event(), Event()
    waiter_pid = []

    def action(db, name):
        if name == "assignment":
            link_assessment(db, work_id, s.lesson_id, s.group_id)
        else:
            db.execute(text("DELETE FROM lesson_groups WHERE id=:id"), {"id": row_id})

    def second_action():
        with Session(s.engine) as db:
            db.connection(execution_options={"isolation_level": isolation})
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            db.execute(select(Lesson).where(Lesson.id == s.lesson_id)).all()
            ready.set()
            assert proceed.wait(5)
            action(db, "deletion" if winner == "assignment" else "assignment")
            db.commit()

    with ThreadPoolExecutor(max_workers=1) as pool, Session(s.engine) as first:
        pending = pool.submit(second_action)
        try:
            assert ready.wait(5)
            pid = first.scalar(text("SELECT pg_backend_pid()"))
            action(first, winner)
            proceed.set()
            require_blocked_writer(s.engine, pid, waiter_pid[0])
            first.commit()
        finally:
            first.rollback()
            proceed.set()
        with pytest.raises(DBAPIError) as rejected:
            pending.result(timeout=5)
        assert rejected.value.orig.sqlstate == (
            "23514" if isolation == "READ COMMITTED" else "40001"
        )
    with Session(s.engine) as db:
        assert len(list_participants(db, s.lesson_id)) == (1 if winner == "assignment" else 0)
        assert len(list(db.scalars(select(AssessmentGroup)))) == (
            1 if winner == "assignment" else 0
        )
