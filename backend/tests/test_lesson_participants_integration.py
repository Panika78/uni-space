"""Participant changes refresh ORM state and version the locked lesson."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event
from time import monotonic
from types import SimpleNamespace

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_schedule_integration import schedule as create_schedule
from test_subgroups_integration import schedule_fixture, subgroups  # noqa: F401

from app.academics.service import get_student_academics
from app.models import Assessment, AssessmentGroup, AssessmentResult, Lesson, LessonGroup, Subgroup
from app.schedule.participants import Participant, replace_lesson_participants

pytestmark = pytest.mark.integration


def list_participants(db, lesson_id):
    return set(
        db.execute(
            select(LessonGroup.group_id, LessonGroup.subgroup_id).where(
                LessonGroup.lesson_id == lesson_id
            )
        ).tuples()
    )


def test_participant_version_changes_once_per_changed_set_and_rolls_back(subgroups):  # noqa: F811
    s = subgroups
    lesson = s.lesson()
    group = s.groups[0].id
    version = lesson.version
    desired = [Participant(group, s.a.id), Participant(group, s.b.id)]
    replace_lesson_participants(s.db, lesson.id, [Participant(group)])
    assert lesson.version == version
    replace_lesson_participants(s.db, lesson.id, desired)
    assert lesson.version == version + 1  # One deletion and two insertions, one version.
    replace_lesson_participants(s.db, lesson.id, list(reversed(desired)))
    assert lesson.version == version + 1
    with s.db.begin_nested() as savepoint:
        replace_lesson_participants(s.db, lesson.id, [])
        assert lesson.version == version + 2
        assert list_participants(s.db, lesson.id) == set()
        savepoint.rollback()
    assert lesson.version == version + 1
    assert list_participants(s.db, lesson.id) == {(group, s.a.id), (group, s.b.id)}
    replace_lesson_participants(s.db, lesson.id, [])
    assert lesson.version == version + 2
    replace_lesson_participants(s.db, lesson.id, [])
    assert lesson.version == version + 2
    with pytest.raises(ValueError):
        replace_lesson_participants(s.db, lesson.id, [Participant(group, s.foreign.id)])
    assert lesson.version == version + 2


def test_participant_replacement_refreshes_preloaded_assignment(subgroups):  # noqa: F811
    s = subgroups
    lesson = s.lesson()
    assignment = s.db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == lesson.id)).one()
    # A different writer changes the row without synchronizing the identity map.
    s.db.execute(
        text("UPDATE lesson_groups SET subgroup_id=:subgroup WHERE id=:id"),
        {"subgroup": s.a.id, "id": assignment.id},
    )
    assert assignment.subgroup_id is None
    replace_lesson_participants(s.db, lesson.id, [Participant(s.groups[0].id)])
    assert list_participants(s.db, lesson.id) == {(s.groups[0].id, None)}


@pytest.fixture
def committed_lesson(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "head")
    with Session(engine) as db:
        s = create_schedule.__wrapped__(db)
        lesson = s.lesson()
        a, b = [s.add(Subgroup, group_id=s.groups[0].id, name=name) for name in ("А", "Б")]
        values = SimpleNamespace(
            engine=engine,
            lesson_id=lesson.id,
            group_id=s.groups[0].id,
            a_id=a.id,
            b_id=b.id,
            version=lesson.version,
        )
        db.commit()
    return values


def require_blocked_writer(engine, blocker_pid, waiter_pid):
    deadline = monotonic() + 5
    with engine.connect() as observer:
        while monotonic() < deadline:
            if observer.scalar(
                text("SELECT :blocker = ANY(pg_blocking_pids(:waiter))"),
                {"blocker": blocker_pid, "waiter": waiter_pid},
            ):
                return
            Event().wait(0.01)
    pytest.fail("Concurrent participant writer did not wait for the lesson lock")


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
@pytest.mark.parametrize("same_set", [True, False])
def test_concurrent_replacements_version_actual_changes_without_lost_updates(
    committed_lesson, isolation, same_set
):
    s = committed_lesson
    ready, proceed = Event(), Event()
    waiter_pid = []
    target = [Participant(s.group_id, s.a_id if same_set else s.b_id)]

    def replace_after_preload():
        with Session(s.engine, expire_on_commit=False) as db:
            db.connection(execution_options={"isolation_level": isolation})
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            # Keep strong references: both entities must remain in the identity map.
            lesson = db.get(Lesson, s.lesson_id)
            assignments = list(
                db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == s.lesson_id))
            )
            ready.set()
            assert proceed.wait(5)
            replace_lesson_participants(db, s.lesson_id, target)
            assert assignments  # Preloaded ORM state was retained throughout the call.
            version = lesson.version
            db.commit()
            return version

    with ThreadPoolExecutor(max_workers=1) as executor, Session(s.engine) as first:
        pending = executor.submit(replace_after_preload)
        try:
            assert ready.wait(5)
            blocker_pid = first.scalar(text("SELECT pg_backend_pid()"))
            replace_lesson_participants(first, s.lesson_id, [Participant(s.group_id, s.a_id)])
            proceed.set()
            require_blocked_writer(s.engine, blocker_pid, waiter_pid[0])
            first.commit()
        finally:
            first.rollback()
            proceed.set()
        if isolation == "REPEATABLE READ":
            with pytest.raises(DBAPIError) as rejected:
                pending.result(timeout=5)
            assert rejected.value.orig.sqlstate == "40001"
            # Standard PostgreSQL serialization retry starts a fresh transaction.
            with Session(s.engine) as retry:
                replace_lesson_participants(retry, s.lesson_id, target)
                retry.commit()
        else:
            assert pending.result(timeout=5) == s.version + (1 if same_set else 2)
    with Session(s.engine) as db:
        assert db.get(Lesson, s.lesson_id).version == s.version + (1 if same_set else 2)
        assert list_participants(db, s.lesson_id) == {(s.group_id, target[0].subgroup_id)}


def test_concurrent_replacement_refreshes_assignment_changed_in_place(committed_lesson):
    s = committed_lesson
    ready, proceed = Event(), Event()
    waiter_pid = []

    def replace_after_preload():
        with Session(s.engine) as db:
            waiter_pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            assignment = db.scalars(
                select(LessonGroup).where(LessonGroup.lesson_id == s.lesson_id)
            ).one()
            assert assignment.subgroup_id is None
            ready.set()
            assert proceed.wait(5)
            replace_lesson_participants(db, s.lesson_id, [Participant(s.group_id)])
            db.commit()

    with ThreadPoolExecutor(max_workers=1) as executor, Session(s.engine) as first:
        pending = executor.submit(replace_after_preload)
        try:
            assert ready.wait(5)
            blocker_pid = first.scalar(text("SELECT pg_backend_pid()"))
            lesson = first.scalars(
                select(Lesson).where(Lesson.id == s.lesson_id).with_for_update()
            ).one()
            assignment = first.scalars(
                select(LessonGroup).where(LessonGroup.lesson_id == s.lesson_id)
            ).one()
            assignment.subgroup_id = s.a_id
            lesson.version += 1
            first.flush()
            proceed.set()
            require_blocked_writer(s.engine, blocker_pid, waiter_pid[0])
            first.commit()
        finally:
            first.rollback()
            proceed.set()
        pending.result(timeout=5)
    with Session(s.engine) as db:
        assert list_participants(db, s.lesson_id) == {(s.group_id, None)}
        assert db.get(Lesson, s.lesson_id).version == s.version + 2


def test_common_assessment_linked_to_subgroup_lesson_accepts_both_students(subgroups):  # noqa: F811
    s = subgroups
    a_lesson = s.assign(s.lesson(assigned=[]), s.a.id)
    b_lesson = s.assign(s.lesson("2026-11-11T09:00:00+03:00", assigned=[]), s.b.id)
    work = s.add(
        Assessment,
        course_offering_id=s.offering.id,
        title="Общая контрольная",
        type="test",
        max_score=10,
    )
    assignment = s.add(
        AssessmentGroup, assessment_id=work.id, group_id=s.groups[0].id, lesson_id=a_lesson.id
    )
    for student, score in zip(s.students, (7, 8), strict=True):
        s.add(
            AssessmentResult,
            assessment_group_id=assignment.id,
            student_id=student.id,
            score=score,
            graded_at=datetime.now(UTC),
        )
    assert [i["id"] for i in s.request().json()["items"]] == [str(a_lesson.id)]
    assert s.request(1).json()["items"] == []
    assert [i["id"] for i in s.request(1, start="2026-11-11").json()["items"]] == [str(b_lesson.id)]
    assert s.request(start="2026-11-11").json()["items"] == []
    for student, score in zip(s.students, (7, 8), strict=True):
        item = get_student_academics(s.db, student).items[0]
        assert item.total_score == score
        assert item.max_score == 10
        assert item.assessment_count == item.graded_assessment_count == 1
