"""Real PostgreSQL preflight, proposed assignments and transaction ownership."""
# ruff: noqa: F811

from dataclasses import asdict, replace
from datetime import datetime
from unittest.mock import patch

import pytest
from sqlalchemy import event, select
from test_schedule_integration import schedule  # noqa: F401

from app.models import Lesson, LessonGroup, Subgroup
from app.schedule.conflicts import LessonProposal, validate_lesson_conflicts
from app.schedule.participants import Participant, replace_lesson_participants

pytestmark = pytest.mark.integration


def proposal(s, **changes):
    return replace(
        LessonProposal(
            course_offering_id=s.offering.id,
            starts_at=datetime.fromisoformat("2026-11-10T09:00:00+03:00"),
            ends_at=datetime.fromisoformat("2026-11-10T10:00:00+03:00"),
            teacher_id=s.teacher.id,
            room_ids=tuple(r.id for r in s.rooms),
            participants=tuple(Participant(g.id) for g in s.groups),
            status="scheduled",
            is_additional=False,
        ),
        **changes,
    )


def validate(s, **changes):
    return validate_lesson_conflicts(s.db, proposal(s, **changes))


def codes(result):
    return [issue.code for issue in result.issues]


@pytest.mark.parametrize("additional", [False, True])
def test_all_resources_return_unique_private_field_issues(schedule, additional):
    s = schedule
    for _ in range(2):
        s.lesson(assigned=s.groups, room_ids=[r.id for r in s.rooms], teacher_id=s.teacher.id)
    result = validate(s, is_additional=additional)
    assert [asdict(issue) for issue in result.issues] == [
        {"code": code, "field": field, "severity": "warning" if additional else "blocking"}
        for code, field in [
            ("teacher_conflict", "teacher_id"),
            ("room_conflict", "room_ids"),
            ("participants_conflict", "participants"),
        ]
    ]
    assert len(result.warnings) == (3 if additional else 0)
    assert len(result.blocking) == (0 if additional else 3)


@pytest.mark.parametrize("resource", ["teacher", "room", "participants"])
def test_each_resource_independently_detects_collision(schedule, resource):
    s = schedule
    s.lesson(
        teacher_id=s.teacher.id if resource == "teacher" else None,
        assigned=[s.groups[1]] if resource == "participants" else [],
        room_ids=[s.rooms[1].id] if resource == "room" else [],
    )
    assert codes(validate(s)) == [f"{resource}_conflict"]


@pytest.mark.parametrize("status", ["cancelled", "moved"])
def test_only_scheduled_positions_occupy_resources(schedule, status):
    s = schedule
    s.lesson(status=status, teacher_id=s.teacher.id, room_ids=[r.id for r in s.rooms])
    assert not validate(s).issues
    s.lesson(teacher_id=s.teacher.id)
    assert not validate(s, status=status).issues


def test_edit_move_restore_and_proposed_resources(schedule):
    s = schedule
    source = s.lesson(teacher_id=s.teacher.id, room_ids=[r.id for r in s.rooms], assigned=s.groups)
    assert not validate(s, lesson_id=source.id).issues
    assert not validate(s, source_lesson_id=source.id).issues
    restored = s.lesson(status="cancelled")
    assert len(validate(s, lesson_id=restored.id).blocking) == 3
    # Replacement participants/teacher/rooms are used, not the saved assignments.
    assert not validate(
        s,
        lesson_id=restored.id,
        source_lesson_id=source.id,
        teacher_id=None,
        room_ids=(),
        participants=(Participant(s.groups[1].id),),
    ).issues
    other = s.lesson()
    assert codes(validate(s, source_lesson_id=source.id)) == ["participants_conflict"]
    assert other.status == "scheduled" and source.status == "scheduled"


@pytest.mark.parametrize("existing_additional", [False, True])
def test_official_candidate_blocks_against_additional_and_official(schedule, existing_additional):
    s = schedule
    s.lesson(is_additional=existing_additional, teacher_id=s.teacher.id)
    assert codes(validate(s)) == ["teacher_conflict", "participants_conflict"]
    assert len(validate(s).blocking) == 2


def test_null_teacher_and_no_rooms_do_not_collide(schedule):
    s = schedule
    s.lesson(teacher_id=None, assigned=[s.groups[0]])
    assert not validate(
        s, teacher_id=None, room_ids=(), participants=(Participant(s.groups[1].id),)
    ).issues


@pytest.mark.parametrize(
    "existing,proposed,conflict",
    [
        ("a", "b", False),
        ("a", "a", True),
        (None, "a", True),
        ("b", None, True),
    ],
)
def test_formal_subgroup_semantics(schedule, existing, proposed, conflict):
    s = schedule
    subgroups = {
        name: s.add(Subgroup, group_id=s.groups[0].id, name=name).id for name in ("a", "b")
    }
    lesson = s.lesson()
    replace_lesson_participants(
        s.db, lesson.id, [Participant(s.groups[0].id, subgroups.get(existing))]
    )
    result = validate(
        s,
        teacher_id=None,
        room_ids=(),
        participants=(Participant(s.groups[0].id, subgroups.get(proposed)),),
    )
    assert codes(result) == (["participants_conflict"] if conflict else [])


@pytest.mark.parametrize(
    "start,end,conflict",
    [
        ("2026-11-10T08:00:00+03:00", "2026-11-10T09:00:00+03:00", False),
        ("2026-11-10T10:00:00+03:00", "2026-11-10T11:00:00+03:00", False),
        ("2026-11-10T05:59:00Z", "2026-11-10T06:01:00Z", True),
    ],
)
def test_half_open_intervals_compare_instants(schedule, start, end, conflict):
    s = schedule
    s.lesson()
    assert (
        bool(
            validate(
                s, starts_at=datetime.fromisoformat(start), ends_at=datetime.fromisoformat(end)
            ).issues
        )
        == conflict
    )


def test_midnight_overlap_uses_full_timestamptz(schedule):
    s = schedule
    s.lesson("2026-11-10T23:30:00+03:00", "2026-11-11T00:30:00+03:00")
    assert codes(
        validate(
            s,
            starts_at=datetime.fromisoformat("2026-11-10T21:00:00Z"),
            ends_at=datetime.fromisoformat("2026-11-10T22:00:00Z"),
        )
    ) == ["participants_conflict"]


@pytest.mark.parametrize("invalid", ["empty", "duplicate", "redundant", "foreign", "unknown_group"])
def test_invalid_participants_fail_closed_using_existing_validator(schedule, invalid):
    s = schedule
    subgroup = s.add(Subgroup, group_id=s.groups[1].id, name="foreign")
    whole = Participant(s.groups[0].id)
    values = {
        "empty": (),
        "duplicate": (whole, whole),
        "redundant": (Participant(s.groups[1].id), Participant(s.groups[1].id, subgroup.id)),
        "foreign": (Participant(s.groups[0].id, subgroup.id),),
        "unknown_group": (Participant(-1),),
    }
    assert codes(validate(s, participants=values[invalid])) == ["invalid_participants"]


@pytest.mark.parametrize("invalid", ["equal", "reversed", "naive", "status"])
def test_invalid_interval_and_status_block(schedule, invalid):
    s = schedule
    p = proposal(s)
    changes = {
        "equal": {"ends_at": p.starts_at},
        "reversed": {"starts_at": p.ends_at, "ends_at": p.starts_at},
        "naive": {"starts_at": p.starts_at.replace(tzinfo=None)},
        "status": {"status": "unknown"},
    }
    result = validate(s, **changes[invalid])
    assert codes(result) == (
        ["invalid_status"] if invalid == "status" else ["invalid_interval"] * 2
    )
    assert result.blocking == result.issues


def test_preflight_does_not_flush_mutate_or_own_transaction(schedule):
    s = schedule
    lesson = s.lesson(teacher_id=s.teacher.id)
    version = lesson.version
    lesson.status = "cancelled"  # Pending state must not hide persisted occupancy.
    pending = Lesson(course_offering_id=s.offering.id)  # Would fail if autoflushed.
    s.db.add(pending)
    before = (set(s.db.new), set(s.db.dirty), set(s.db.deleted))
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(s.db.bind, "before_cursor_execute", record)
    try:
        with (
            patch.object(s.db, "flush", side_effect=AssertionError("flush")),
            patch.object(s.db, "commit", side_effect=AssertionError("commit")),
            patch.object(s.db, "rollback", side_effect=AssertionError("rollback")),
            patch.object(s.db, "begin", side_effect=AssertionError("begin")),
            patch.object(s.db, "begin_nested", side_effect=AssertionError("savepoint")),
        ):
            assert codes(validate(s)) == ["teacher_conflict", "participants_conflict"]
    finally:
        event.remove(s.db.bind, "before_cursor_execute", record)
    assert len(statements) <= 4  # Course assignment, occupied slots, rooms, participants.
    assert all(statement.lstrip().upper().startswith("SELECT") for statement in statements)
    assert not any("JOIN" in statement.upper() for statement in statements)
    assert before == (set(s.db.new), set(s.db.dirty), set(s.db.deleted))
    assert lesson.version == version and lesson.status == "cancelled"
    with s.db.no_autoflush:
        assert s.db.scalar(select(Lesson.status).where(Lesson.id == lesson.id)) == "scheduled"
        assert (
            s.db.scalar(select(LessonGroup.group_id).where(LessonGroup.lesson_id == lesson.id))
            == s.groups[0].id
        )


def test_multiple_known_subgroups_and_groups_use_every_assignment(schedule):
    s = schedule
    a, b = [s.add(Subgroup, group_id=s.groups[0].id, name=name) for name in ("a", "b")]
    lesson = s.lesson(assigned=[])
    replace_lesson_participants(
        s.db,
        lesson.id,
        [
            Participant(s.groups[0].id, a.id),
            Participant(s.groups[0].id, b.id),
            Participant(s.groups[1].id),
        ],
    )
    assert not validate(
        s,
        lesson_id=lesson.id,
        participants=(
            Participant(s.groups[0].id, a.id),
            Participant(s.groups[0].id, b.id),
            Participant(s.groups[1].id),
        ),
    ).issues
    assert codes(validate(s, participants=(Participant(s.groups[0].id, b.id),))) == [
        "participants_conflict"
    ]
    assert codes(validate(s, participants=(Participant(s.groups[1].id),))) == [
        "participants_conflict"
    ]


def test_edit_checks_unsaved_new_resources_instead_of_saved_links(schedule):
    s = schedule
    target = s.lesson(assigned=[s.groups[0]], teacher_id=None)
    s.lesson(assigned=[s.groups[1]], teacher_id=s.teacher.id, room_ids=[s.rooms[1].id])
    assert not validate(
        s,
        lesson_id=target.id,
        teacher_id=None,
        room_ids=(),
        participants=(Participant(s.groups[0].id),),
    ).issues
    assert codes(validate(s, lesson_id=target.id, participants=(Participant(s.groups[1].id),))) == [
        "teacher_conflict",
        "room_conflict",
        "participants_conflict",
    ]


def test_query_count_is_bounded_as_overlapping_lessons_and_links_grow(schedule):
    s = schedule
    a, b = [s.add(Subgroup, group_id=s.groups[0].id, name=name) for name in ("a", "b")]
    participants = (
        Participant(s.groups[0].id, a.id),
        Participant(s.groups[0].id, b.id),
        Participant(s.groups[1].id),
    )

    def count_queries():
        statements = []

        def record(conn, cursor, statement, params, context, many):
            statements.append(statement)

        event.listen(s.db.bind, "before_cursor_execute", record)
        try:
            assert len(validate(s, participants=participants).blocking) == 3
        finally:
            event.remove(s.db.bind, "before_cursor_execute", record)
        return len(statements)

    def add_lesson():
        lesson = s.lesson(assigned=[], room_ids=[r.id for r in s.rooms], teacher_id=s.teacher.id)
        replace_lesson_participants(s.db, lesson.id, list(participants))

    add_lesson()
    assert count_queries() == 5  # Offering groups, subgroup validity, three resource reads.
    for _ in range(20):
        add_lesson()
    assert count_queries() == 5
