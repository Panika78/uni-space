"""Official schedule operations. One transaction includes links, flags and audit."""

from dataclasses import dataclass
from datetime import datetime, time
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.audit import write_audit_event
from app.models import (
    AcademicTerm,
    AssessmentGroup,
    Building,
    CourseGroup,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    LessonRoom,
    Room,
    StudyGroup,
    Subgroup,
    Teacher,
    TeachingAssignment,
    User,
)
from app.permissions import PermissionCode, require_staff_permission
from app.schedule.conflicts import LessonProposal, validate_lesson_conflicts
from app.schedule.editor_schemas import (
    CatalogItem,
    CatalogPage,
    CatalogParams,
    EditorLesson,
    EditorSchedule,
    EditorScheduleParams,
    LessonParticipant,
    LessonWrite,
)
from app.schedule.participants import Participant, replace_lesson_participants
from app.schedule.service import MOSCOW
from app.teaching.service import require_teaching_assignment


@dataclass(frozen=True)
class ScheduleChanged:
    """Transactional hook payload for #86; never send notifications before commit."""

    lesson_id: int
    action: str
    continuation_id: int | None = None


class ScheduleConflict(Exception):
    def __init__(self, issues):
        self.issues = issues


def require_editor(db: Session, actor: User) -> None:
    require_staff_permission(db, actor, PermissionCode.SCHEDULE_EDIT)


def get_editor_lesson(db: Session, lesson_id: int) -> EditorLesson:
    lesson = db.get(Lesson, lesson_id, populate_existing=True)
    if lesson is None or lesson.is_additional:
        raise HTTPException(404, "not_found")
    participants = list(
        db.execute(
            select(LessonGroup.group_id, LessonGroup.subgroup_id)
            .where(LessonGroup.lesson_id == lesson_id)
            .order_by(LessonGroup.group_id, LessonGroup.subgroup_id.nullsfirst())
        )
    )
    return EditorLesson(
        id=str(lesson.id),
        course_offering_id=str(lesson.course_offering_id),
        teacher_id=str(lesson.teacher_id) if lesson.teacher_id else None,
        starts_at=lesson.starts_at,
        ends_at=lesson.ends_at,
        kind=lesson.kind,
        participants=[
            LessonParticipant(group_id=str(g), subgroup_id=str(s) if s else None)
            for g, s in participants
        ],
        room_ids=[
            str(i)
            for i in db.scalars(
                select(LessonRoom.room_id)
                .where(LessonRoom.lesson_id == lesson_id)
                .order_by(LessonRoom.room_id)
            )
        ],
        status=lesson.status,
        version=lesson.version,
        previous_lesson_id=str(lesson.previous_lesson_id) if lesson.previous_lesson_id else None,
        next_lesson_id=(
            str(n)
            if (n := db.scalar(select(Lesson.id).where(Lesson.previous_lesson_id == lesson_id)))
            else None
        ),
        created_by_user_id=str(lesson.created_by_user_id) if lesson.created_by_user_id else None,
    )


def snapshot(item: EditorLesson) -> dict:
    return {
        "course_offering_id": int(item.course_offering_id),
        "teacher_id": int(item.teacher_id) if item.teacher_id else None,
        "starts_at": item.starts_at,
        "ends_at": item.ends_at,
        "kind": item.kind,
        "status": item.status,
        "version": item.version,
        "previous_lesson_id": int(item.previous_lesson_id) if item.previous_lesson_id else None,
        "group_ids": sorted({int(p.group_id) for p in item.participants}),
        "participants": [
            {
                "group_id": int(p.group_id),
                "subgroup_id": int(p.subgroup_id) if p.subgroup_id else None,
            }
            for p in item.participants
        ],
        "room_ids": [int(i) for i in item.room_ids],
    }


def audit_lesson(db, actor, lesson_id, action, before):
    write_audit_event(
        db,
        actor=actor,
        entity_type="lesson",
        entity_id=lesson_id,
        action=action,
        before_data=before,
        after_data=snapshot(get_editor_lesson(db, lesson_id)),
        reason="schedule_change",
    )


def validate_state(
    db, data: LessonWrite, *, lesson_id=None, source_id=None, validate_assignment=True
):
    groups = {int(p.group_id) for p in data.participants}
    if db.get(CourseOffering, int(data.course_offering_id)) is None:
        raise HTTPException(422, "validation_error")
    if validate_assignment and data.teacher_id:
        for group_id in sorted(groups):
            try:
                # Selected teacher's subject assignment; the staff actor does
                # not need a teacher profile or a journal assignment.
                require_teaching_assignment(
                    db, int(data.teacher_id), int(data.course_offering_id), group_id
                )
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                raise HTTPException(422, "validation_error") from exc
    rooms = {int(i) for i in data.room_ids}
    if rooms != set(db.scalars(select(Room.id).where(Room.id.in_(rooms)))):
        raise HTTPException(422, "validation_error")
    result = validate_lesson_conflicts(
        db,
        LessonProposal(
            course_offering_id=int(data.course_offering_id),
            starts_at=data.starts_at,
            ends_at=data.ends_at,
            teacher_id=int(data.teacher_id) if data.teacher_id else None,
            room_ids=tuple(rooms),
            participants=tuple(
                Participant(int(p.group_id), int(p.subgroup_id) if p.subgroup_id else None)
                for p in data.participants
            ),
            status="scheduled",
            is_additional=False,
            lesson_id=lesson_id,
            source_lesson_id=source_id,
        ),
    )
    if result.blocking:
        raise ScheduleConflict(result.blocking)


def insert_lesson(db, actor, data, previous_id=None):
    lesson = Lesson(
        course_offering_id=int(data.course_offering_id),
        teacher_id=int(data.teacher_id) if data.teacher_id else None,
        starts_at=data.starts_at,
        ends_at=data.ends_at,
        kind=data.kind,
        status="scheduled",
        version=1,
        previous_lesson_id=previous_id,
        is_additional=False,
        created_by_user_id=actor.id,
    )
    db.add(lesson)
    db.flush()
    for p in data.participants:
        db.add(
            LessonGroup(
                lesson_id=lesson.id,
                group_id=int(p.group_id),
                subgroup_id=int(p.subgroup_id) if p.subgroup_id else None,
            )
        )
    for room_id in data.room_ids:
        db.add(LessonRoom(lesson_id=lesson.id, room_id=int(room_id)))
    db.flush()
    audit_lesson(db, actor, lesson.id, "create", None)
    return lesson


def mark_assessment_dates(db, actor, lesson_id):
    # Parent is locked first. NOWAIT children avoid inverse lock order in #71
    # and SQL triggers (assessment tuple -> parent). Roll back the whole request.
    rows = db.scalars(
        select(AssessmentGroup)
        .where(AssessmentGroup.lesson_id == lesson_id)
        .order_by(AssessmentGroup.id)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    ).all()
    for row in rows:
        if row.date_needs_confirmation:
            continue
        before = {
            "planned_date": row.planned_date,
            "lesson_id": row.lesson_id,
            "date_needs_confirmation": False,
        }
        row.date_needs_confirmation = True
        write_audit_event(
            db,
            actor=actor,
            entity_type="assessment_group",
            entity_id=row.id,
            action="update",
            before_data=before,
            after_data=before | {"date_needs_confirmation": True},
            reason="schedule_change",
        )


def mutate_lesson(
    db: Session,
    actor: User,
    action: Literal["create", "update", "cancel", "move", "restore"],
    *,
    lesson_id=None,
    version=None,
    data: LessonWrite | None = None,
) -> EditorLesson:
    """Caller commits, and MUST roll back on every exception (including audit)."""
    require_editor(db, actor)
    if action == "create":
        validate_state(db, data)
        target = insert_lesson(db, actor, data)
        event = ScheduleChanged(target.id, action)
    else:
        lesson = db.scalar(
            select(Lesson)
            .where(Lesson.id == lesson_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if lesson is None or lesson.is_additional:
            raise HTTPException(404, "not_found")
        if lesson.version != version:
            raise HTTPException(409, "version_conflict")
        expected_status = "cancelled" if action == "restore" else "scheduled"
        if lesson.status != expected_status or db.scalar(
            select(Lesson.id).where(Lesson.previous_lesson_id == lesson_id)
        ):
            raise HTTPException(409, "invalid_transition")
        old = get_editor_lesson(db, lesson_id)
        before = snapshot(old)
        if action == "update":
            desired_participants = sorted(
                data.participants, key=lambda p: (int(p.group_id), int(p.subgroup_id or 0))
            )
            desired = data.model_copy(
                update={
                    "participants": desired_participants,
                    "room_ids": sorted(data.room_ids, key=int),
                }
            )
            current = old.model_dump(include=LessonWrite.model_fields.keys())
            if desired.model_dump() == current:
                return old
        if action in ("update", "move", "restore"):
            proposed = data or old
            assignment_changed = (
                action == "move"
                or any(
                    getattr(proposed, field) != getattr(old, field)
                    for field in ("course_offering_id", "teacher_id")
                )
                or (
                    {p.group_id for p in proposed.participants}
                    != {p.group_id for p in old.participants}
                )
            )
            validate_state(
                db, proposed, lesson_id=lesson_id, validate_assignment=assignment_changed
            )
        if action == "update":
            # Preflight domain message; trigger remains authoritative for direct SQL/races.
            needed = set(
                db.scalars(
                    select(AssessmentGroup.group_id).where(AssessmentGroup.lesson_id == lesson_id)
                )
            )
            if not needed <= {int(p.group_id) for p in data.participants}:
                raise HTTPException(409, "assessment_group_in_use")
            lesson.course_offering_id = int(data.course_offering_id)
            lesson.teacher_id = int(data.teacher_id) if data.teacher_id else None
            lesson.starts_at, lesson.ends_at, lesson.kind = data.starts_at, data.ends_at, data.kind
            participants = [
                Participant(int(p.group_id), int(p.subgroup_id) if p.subgroup_id else None)
                for p in data.participants
            ]
            db.flush()
            replace_lesson_participants(db, lesson_id, participants)
            # #62 may already increment; exactly one increment for the whole operation.
            lesson.version = version + 1
            db.execute(delete(LessonRoom).where(LessonRoom.lesson_id == lesson_id))
            for room_id in data.room_ids:
                db.add(LessonRoom(lesson_id=lesson_id, room_id=int(room_id)))
        else:
            lesson.status = {"cancel": "cancelled", "move": "moved", "restore": "scheduled"}[action]
            lesson.version = version + 1
        db.flush()
        if action in ("cancel", "move"):
            mark_assessment_dates(db, actor, lesson_id)
        audit_lesson(db, actor, lesson_id, action, before)
        target = insert_lesson(db, actor, data, lesson_id) if action == "move" else lesson
        event = ScheduleChanged(lesson_id, action, target.id if action == "move" else None)
    # A transactional hook for the future notification integration. The owner
    # exposes events only after commit; rollback removes them in the router.
    db.info.setdefault("schedule_events", []).append(event)
    return get_editor_lesson(db, target.id)


def list_editor_schedule(db: Session, params: EditorScheduleParams) -> EditorSchedule:
    model = {"group": StudyGroup, "teacher": Teacher, "room": Room}[params.resource]
    if db.get(model, int(params.resource_id)) is None:
        raise HTTPException(404, "not_found")
    start = datetime.combine(params.date_from, time.min, MOSCOW)
    end = datetime.combine(params.date_to, time.max, MOSCOW)
    statement = select(Lesson.id).where(
        Lesson.is_additional.is_(False), Lesson.starts_at <= end, Lesson.ends_at > start
    )
    resource_id = int(params.resource_id)
    if params.resource == "teacher":
        statement = statement.where(Lesson.teacher_id == resource_id)
    elif params.resource == "group":
        statement = statement.where(
            Lesson.id.in_(select(LessonGroup.lesson_id).where(LessonGroup.group_id == resource_id))
        )
    else:
        statement = statement.where(
            Lesson.id.in_(select(LessonRoom.lesson_id).where(LessonRoom.room_id == resource_id))
        )
    if params.after_id:
        statement = statement.where(Lesson.id > int(params.after_id))
    ids = list(db.scalars(statement.order_by(Lesson.id).limit(params.limit + 1)))
    return EditorSchedule(
        items=[get_editor_lesson(db, i) for i in ids[: params.limit]],
        next_after_id=str(ids[params.limit - 1]) if len(ids) > params.limit else None,
    )


def list_editor_catalog(db: Session, kind: str, params: CatalogParams) -> CatalogPage:
    models = {
        "groups": StudyGroup,
        "subgroups": Subgroup,
        "teachers": Teacher,
        "rooms": Room,
        "course-offerings": CourseOffering,
        "teaching-assignments": TeachingAssignment,
    }
    model = models[kind]
    name = (
        model.name
        if kind in ("groups", "subgroups", "rooms")
        else (
            func.coalesce(User.full_name, Teacher.full_name)
            if kind == "teachers"
            else Discipline.name
        )
    )
    stmt = select(model, name)
    if kind == "teachers":
        stmt = stmt.outerjoin(User, Teacher.user_id == User.id)
    if kind in ("course-offerings", "teaching-assignments"):
        if kind == "teaching-assignments":
            stmt = stmt.join(
                CourseOffering, TeachingAssignment.course_offering_id == CourseOffering.id
            )
        stmt = stmt.join(Discipline, CourseOffering.discipline_id == Discipline.id)
    if params.q:
        stmt = stmt.where(name.icontains(params.q, autoescape=True))
    if params.after_id:
        stmt = stmt.where(model.id > int(params.after_id))
    if params.group_id:
        if kind in ("subgroups", "teaching-assignments"):
            stmt = stmt.where(model.group_id == int(params.group_id))
        elif kind == "course-offerings":
            stmt = stmt.where(
                CourseOffering.id.in_(
                    select(CourseGroup.course_offering_id).where(
                        CourseGroup.group_id == int(params.group_id)
                    )
                )
            )
        else:
            raise HTTPException(422, "validation_error")
    if params.course_offering_id:
        if kind == "teaching-assignments":
            stmt = stmt.where(model.course_offering_id == int(params.course_offering_id))
        elif kind == "groups":
            stmt = stmt.where(
                StudyGroup.id.in_(
                    select(CourseGroup.group_id).where(
                        CourseGroup.course_offering_id == int(params.course_offering_id)
                    )
                )
            )
        else:
            raise HTTPException(422, "validation_error")
    rows = db.execute(stmt.order_by(model.id).limit(params.limit + 1)).all()
    items = []
    for row, label in rows[: params.limit]:
        item = CatalogItem(id=str(row.id), name=label)
        if kind in ("subgroups", "teaching-assignments"):
            item.group_id = str(row.group_id)
        if kind == "teaching-assignments":
            item.course_offering_id, item.teacher_id = (
                str(row.course_offering_id),
                str(row.teacher_id),
            )
        if kind == "rooms":
            item.building_id = str(row.building_id)
            item.building_name = db.get(Building, row.building_id).name
        if kind == "course-offerings":
            item.term_id = str(row.term_id)
            item.term_name = db.get(AcademicTerm, row.term_id).name
            item.group_ids = [
                str(i)
                for i in db.scalars(
                    select(CourseGroup.group_id)
                    .where(CourseGroup.course_offering_id == row.id)
                    .order_by(CourseGroup.group_id)
                )
            ]
        items.append(item)
    return CatalogPage(
        items=items,
        next_after_id=str(rows[params.limit - 1][0].id) if len(rows) > params.limit else None,
    )
