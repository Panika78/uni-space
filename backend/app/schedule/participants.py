"""Formal participant contract shared by schedule reads and future #73/#74.

NULL assignment means the whole group. NULL student distribution grants only
whole-group lessons. Overlap is conservative: whole group intersects each of its
subgroups; different known subgroups do not intersect. No discipline allocation.
"""

from dataclasses import dataclass

from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session

from app.models import CourseGroup, Lesson, LessonGroup, Subgroup


@dataclass(frozen=True)
class Participant:
    group_id: int
    subgroup_id: int | None = None


def has_participant_overlap(left: Participant, right: Participant) -> bool:
    return left.group_id == right.group_id and (
        left.subgroup_id is None
        or right.subgroup_id is None
        or left.subgroup_id == right.subgroup_id
    )


def get_student_lesson_condition(lesson_id, group_id: int, subgroup_id: int | None):
    assignment = LessonGroup.subgroup_id.is_(None)
    if subgroup_id is not None:
        assignment = or_(assignment, LessonGroup.subgroup_id == subgroup_id)
    return exists().where(
        LessonGroup.lesson_id == lesson_id, LessonGroup.group_id == group_id, assignment
    )


def validate_lesson_participants(
    db: Session, lesson: Lesson, participants: list[Participant]
) -> None:
    groups = set()
    subgroups = set()
    seen = set()
    whole_groups = set()
    for participant in participants:
        if participant in seen:
            raise ValueError("Duplicate lesson participant")
        seen.add(participant)
        groups.add(participant.group_id)
        if participant.subgroup_id is None:
            whole_groups.add(participant.group_id)
        else:
            subgroups.add((participant.group_id, participant.subgroup_id))
    if any(p.group_id in whole_groups and p.subgroup_id is not None for p in participants):
        raise ValueError("Whole group and its subgroup overlap")
    with db.no_autoflush:
        assigned_groups = set(
            db.scalars(
                select(CourseGroup.group_id).where(
                    CourseGroup.course_offering_id == lesson.course_offering_id,
                    CourseGroup.group_id.in_(groups),
                )
            )
        )
        known_subgroups = (
            set(
                db.execute(
                    select(Subgroup.group_id, Subgroup.id).where(
                        Subgroup.id.in_({subgroup_id for _, subgroup_id in subgroups})
                    )
                ).tuples()
            )
            if subgroups
            else set()
        )
    if groups != assigned_groups:
        raise ValueError("Participant group does not belong to course offering")
    if subgroups != known_subgroups:
        raise ValueError("Subgroup does not belong to participant group")


def replace_lesson_participants(
    db: Session, lesson_id: int, participants: list[Participant]
) -> None:
    """Validate complete set and flush in caller's transaction; no public write API.

    Lock the lesson to serialize cooperating writers. Direct SQL is constrained
    by FKs and unique indexes; whole-group/subgroup redundancy is a service rule.
    """
    lesson = db.scalars(
        select(Lesson)
        .where(Lesson.id == lesson_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    validate_lesson_participants(db, lesson, participants)
    existing = {
        Participant(row.group_id, row.subgroup_id): row
        for row in db.scalars(select(LessonGroup).where(LessonGroup.lesson_id == lesson_id))
    }
    wanted = set(participants)
    for participant, row in existing.items():
        if participant not in wanted:
            db.delete(row)
    db.flush()
    for participant in wanted - existing.keys():
        db.add(
            LessonGroup(
                lesson_id=lesson_id,
                group_id=participant.group_id,
                subgroup_id=participant.subgroup_id,
            )
        )
    db.flush()
