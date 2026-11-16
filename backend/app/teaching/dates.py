"""Confirmed dates of existing works; caller owns commit and rollback.

Lock target assignments before validating. Lesson locks are NOWAIT: #74 and
participant writers lock lesson parents first, so waiting here could deadlock.
A conflict aborts the entire request, never just a single group. #74 must mark
and audit linked assignments in its lesson transaction after locking the lesson.
"""

from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select

from app.audit import write_audit_event
from app.models import Assessment, AssessmentGroup, Lesson, LessonGroup, TeachingAssignment
from app.teaching.service import require_current_teacher


def get_date_snapshot(row):
    return {
        name: getattr(row, name)
        for name in ("planned_date", "lesson_id", "date_needs_confirmation")
    }


def update_assessment_dates(db, actor, course_id, assessment_id, request):
    teacher_id = require_current_teacher(db, actor)
    wanted = {int(item.assessment_group_id): item for item in request.items}
    rows = db.scalars(
        select(AssessmentGroup)
        .join(Assessment)
        .join(
            TeachingAssignment,
            (
                (TeachingAssignment.course_offering_id == Assessment.course_offering_id)
                & (TeachingAssignment.group_id == AssessmentGroup.group_id)
                & (TeachingAssignment.teacher_id == teacher_id)
            ),
        )
        .where(
            Assessment.course_offering_id == course_id,
            Assessment.id == assessment_id,
            AssessmentGroup.id.in_(wanted),
        )
        .order_by(AssessmentGroup.id)
        .with_for_update(of=(AssessmentGroup, TeachingAssignment), nowait=True)
        .execution_options(populate_existing=True)
    ).all()
    if len(rows) != len(wanted):
        raise HTTPException(404, "not_found")
    lesson_ids = sorted({int(item.lesson_id) for item in request.items if item.lesson_id})
    lessons = {
        row.id: row
        for row in db.scalars(
            select(Lesson)
            .where(Lesson.id.in_(lesson_ids))
            .order_by(Lesson.id)
            .with_for_update(nowait=True)
            .execution_options(populate_existing=True)
        )
    }
    # Lesson parent locks serialize all cooperating participant edits; the
    # existing PostgreSQL assignment trigger touches the same lesson parent.
    participants = set(
        db.execute(
            select(LessonGroup.lesson_id, LessonGroup.group_id).where(
                LessonGroup.lesson_id.in_(lesson_ids)
            )
        ).tuples()
    )
    changes = []
    for row in rows:
        item = wanted[row.id]
        lesson_id = int(item.lesson_id) if item.lesson_id else None
        if lesson_id is not None:
            lesson = lessons.get(lesson_id)
            if (
                lesson is None
                or lesson.course_offering_id != course_id
                or (lesson_id, row.group_id) not in participants
            ):
                raise HTTPException(404, "not_found")
            if (
                lesson.status != "scheduled"
                or item.planned_date is None
                or item.planned_date
                != lesson.starts_at.astimezone(ZoneInfo("Europe/Moscow")).date()
            ):
                raise HTTPException(422, "validation_error")
        before = get_date_snapshot(row)
        after = dict(
            planned_date=item.planned_date, lesson_id=lesson_id, date_needs_confirmation=False
        )
        changes.append((row, before, after))
    # All targets must pass scope and domain validation before the first write.
    for row, before, after in changes:
        if before == after:
            continue
        for name, value in after.items():
            setattr(row, name, value)
        write_audit_event(
            db,
            actor=actor,
            entity_type="assessment_group",
            entity_id=row.id,
            action="update",
            before_data=before,
            after_data=after,
        )
    return dict(
        items=[
            {
                **get_date_snapshot(row),
                "assessment_group_id": str(row.id),
                "lesson_id": str(row.lesson_id) if row.lesson_id else None,
            }
            for row in rows
        ]
    )
