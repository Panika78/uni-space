"""Read-only preflight for #74; the caller owns writes, authorization and versions.

Pass complete proposed assignments, not persisted links. Exclusions are trusted
internal IDs: #74 must authorize the edit/move and retire its source atomically.
Results describe the database at query time, not a reservation against concurrent
writers. Pending Session changes are deliberately not flushed or overlaid.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Lesson, LessonGroup, LessonRoom
from app.schedule.participants import (
    Participant,
    has_participant_overlap,
    validate_lesson_participants,
)


@dataclass(frozen=True)
class LessonProposal:
    course_offering_id: int
    starts_at: datetime
    ends_at: datetime
    teacher_id: int | None
    room_ids: tuple[int, ...]
    participants: tuple[Participant, ...]
    status: Literal["scheduled", "cancelled", "moved"]
    is_additional: bool
    lesson_id: int | None = None
    source_lesson_id: int | None = None


@dataclass(frozen=True)
class LessonConflict:
    code: Literal[
        "teacher_conflict",
        "room_conflict",
        "participants_conflict",
        "invalid_interval",
        "invalid_status",
        "invalid_participants",
    ]
    field: Literal["teacher_id", "room_ids", "participants", "starts_at", "ends_at", "status"]
    severity: Literal["blocking", "warning"]


@dataclass(frozen=True)
class ConflictValidation:
    issues: tuple[LessonConflict, ...] = ()

    @property
    def blocking(self) -> tuple[LessonConflict, ...]:
        return tuple(issue for issue in self.issues if issue.severity == "blocking")

    @property
    def warnings(self) -> tuple[LessonConflict, ...]:
        return tuple(issue for issue in self.issues if issue.severity == "warning")


def validate_lesson_conflicts(db: Session, proposal: LessonProposal) -> ConflictValidation:
    """Return one issue per resource type, without IDs, names or student data.

    NULL teacher and an empty room set occupy no such resources. Empty/invalid
    participants fail closed (also for additional lessons). All additional
    temporal collisions are warnings; physical room collisions remain a distinct
    issue. Invalid proposals always block. A non-scheduled proposal occupies no
    resources, but still must have valid data.
    """
    issues = []
    start, end = proposal.starts_at, proposal.ends_at
    if (
        start.utcoffset() is None
        or end.utcoffset() is None
        or (end.astimezone(UTC) <= start.astimezone(UTC))
    ):
        issues.extend(
            LessonConflict("invalid_interval", field, "blocking")
            for field in ("starts_at", "ends_at")
        )
    if proposal.status not in ("scheduled", "cancelled", "moved"):
        issues.append(LessonConflict("invalid_status", "status", "blocking"))
    with db.no_autoflush:
        try:
            if not proposal.participants:
                raise ValueError("Missing participants")
            validate_lesson_participants(
                db,
                Lesson(course_offering_id=proposal.course_offering_id),
                list(proposal.participants),
            )
        except ValueError:
            # Do not expose validator details or IDs of inaccessible assignments.
            issues.append(LessonConflict("invalid_participants", "participants", "blocking"))
        if issues or proposal.status != "scheduled":
            return ConflictValidation(tuple(issues))

        occupied = select(Lesson.id).where(
            Lesson.status == "scheduled",
            Lesson.starts_at < end,
            start < Lesson.ends_at,
        )
        excluded = {
            value for value in (proposal.lesson_id, proposal.source_lesson_id) if value is not None
        }
        if excluded:
            occupied = occupied.where(Lesson.id.not_in(excluded))
        # Scalar rows avoid stale ORM entities and any mutation of identity-map state.
        severity = "warning" if proposal.is_additional else "blocking"
        if (
            proposal.teacher_id is not None
            and db.scalar(occupied.where(Lesson.teacher_id == proposal.teacher_id).limit(1))
            is not None
        ):
            issues.append(LessonConflict("teacher_conflict", "teacher_id", severity))
        occupied_ids = occupied
        if (
            proposal.room_ids
            and db.scalar(
                select(LessonRoom.lesson_id)
                .where(
                    LessonRoom.lesson_id.in_(occupied_ids),
                    LessonRoom.room_id.in_(proposal.room_ids),
                )
                .limit(1)
            )
            is not None
        ):
            issues.append(LessonConflict("room_conflict", "room_ids", severity))
        assignments = db.execute(
            select(LessonGroup.group_id, LessonGroup.subgroup_id).where(
                LessonGroup.lesson_id.in_(occupied_ids),
                LessonGroup.group_id.in_({p.group_id for p in proposal.participants}),
            )
        )
        if any(
            has_participant_overlap(proposed, Participant(group_id, subgroup_id))
            for group_id, subgroup_id in assignments
            for proposed in proposal.participants
        ):
            issues.append(LessonConflict("participants_conflict", "participants", severity))
    return ConflictValidation(tuple(issues))
