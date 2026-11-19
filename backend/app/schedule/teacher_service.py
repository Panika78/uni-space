from collections import defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import DateTime, and_, cast, literal, or_, select
from sqlalchemy.orm import Session, aliased

from app.models import (
    Building,
    CourseOffering,
    Discipline,
    Lesson,
    LessonGroup,
    LessonRoom,
    Room,
    StudyGroup,
    Subgroup,
    TeachingAssignment,
)
from app.schedule.teacher_schemas import (
    TeacherLessonPosition,
    TeacherScheduleItem,
    TeacherScheduleParams,
    TeacherScheduleResponse,
)

MOSCOW = ZoneInfo("Europe/Moscow")


def _has_teacher_scope(lesson_id, offering_id, teacher_id):
    return (
        select(TeachingAssignment.id)
        .join(LessonGroup, LessonGroup.group_id == TeachingAssignment.group_id)
        .where(
            TeachingAssignment.teacher_id == teacher_id,
            TeachingAssignment.course_offering_id == offering_id,
            LessonGroup.lesson_id == lesson_id,
        )
        .exists()
    )


def _position(lesson) -> TeacherLessonPosition:
    return TeacherLessonPosition(
        id=str(lesson.id), starts_at=lesson.starts_at, ends_at=lesson.ends_at, status=lesson.status
    )


def list_teacher_schedule(db: Session, teacher_id: int, params: TeacherScheduleParams):
    range_start = datetime.combine(params.date_from, time.min, MOSCOW)
    range_end = (
        cast(literal("10000-01-01 00:00:00+03"), DateTime(timezone=True))
        if params.date_to == date.max
        else datetime.combine(params.date_to + timedelta(days=1), time.min, MOSCOW)
    )
    rows = db.execute(
        select(
            Lesson,
            CourseOffering.id,
            Discipline.id,
            Discipline.name,
        )
        .join(CourseOffering, CourseOffering.id == Lesson.course_offering_id)
        .join(Discipline, Discipline.id == CourseOffering.discipline_id)
        .where(
            Lesson.teacher_id == teacher_id,
            Lesson.is_additional.is_(False),
            or_(
                and_(
                    Lesson.status == "scheduled",
                    Lesson.starts_at < range_end,
                    Lesson.ends_at > range_start,
                ),
                and_(
                    Lesson.status.in_(("cancelled", "moved")),
                    Lesson.starts_at >= range_start,
                    Lesson.starts_at < range_end,
                ),
            ),
            _has_teacher_scope(Lesson.id, Lesson.course_offering_id, teacher_id),
        )
        .order_by(Lesson.starts_at, Lesson.id)
    ).all()
    if not rows:
        return TeacherScheduleResponse(
            date_from=params.date_from,
            date_to=params.date_to,
            timezone="Europe/Moscow",
            items=[],
        )

    lesson_ids = [row[0].id for row in rows]
    allowed_groups: dict[int, list[dict]] = defaultdict(list)
    for lesson_id, group_id, group_name, subgroup_id, subgroup_name in db.execute(
        select(
            LessonGroup.lesson_id,
            StudyGroup.id,
            StudyGroup.name,
            Subgroup.id,
            Subgroup.name,
        )
        .join(StudyGroup, StudyGroup.id == LessonGroup.group_id)
        .outerjoin(Subgroup, Subgroup.id == LessonGroup.subgroup_id)
        .join(Lesson, Lesson.id == LessonGroup.lesson_id)
        .join(CourseOffering, CourseOffering.id == Lesson.course_offering_id)
        .join(
            TeachingAssignment,
            and_(
                TeachingAssignment.course_offering_id == Lesson.course_offering_id,
                TeachingAssignment.group_id == LessonGroup.group_id,
                TeachingAssignment.teacher_id == teacher_id,
            ),
        )
        .where(LessonGroup.lesson_id.in_(lesson_ids))
        .order_by(StudyGroup.name, StudyGroup.id, Subgroup.name, Subgroup.id)
    ):
        allowed_groups[lesson_id].append(
            {
                "id": str(group_id),
                "name": group_name,
                "subgroup": (
                    {"id": str(subgroup_id), "name": subgroup_name}
                    if subgroup_id is not None
                    else None
                ),
            }
        )

    rooms: dict[int, list[dict]] = defaultdict(list)
    for lesson_id, room, building in db.execute(
        select(LessonRoom.lesson_id, Room, Building)
        .join(Room, Room.id == LessonRoom.room_id)
        .join(Building, Building.id == Room.building_id)
        .where(LessonRoom.lesson_id.in_(lesson_ids))
        .order_by(Building.name, Building.id, Room.name, Room.id)
    ):
        rooms[lesson_id].append(
            {
                "id": str(room.id),
                "name": room.name,
                "building": {"id": str(building.id), "name": building.name},
            }
        )

    previous_ids = [row[0].previous_lesson_id for row in rows if row[0].previous_lesson_id]
    previous: dict[int, TeacherLessonPosition] = {}
    if previous_ids:
        previous = {
            lesson.id: _position(lesson)
            for lesson in db.scalars(
                select(Lesson).where(
                    Lesson.id.in_(previous_ids),
                    Lesson.teacher_id == teacher_id,
                    Lesson.is_additional.is_(False),
                    _has_teacher_scope(Lesson.id, Lesson.course_offering_id, teacher_id),
                )
            )
        }

    moved_ids = [row[0].id for row in rows if row[0].status == "moved"]
    latest: dict[int, TeacherLessonPosition] = {}
    if moved_ids:
        chain = (
            select(
                Lesson.id.label("root_id"),
                Lesson.id,
                Lesson.course_offering_id,
                Lesson.teacher_id,
                Lesson.starts_at,
                Lesson.ends_at,
                Lesson.status,
                Lesson.is_additional,
                Lesson.previous_lesson_id,
            )
            .where(Lesson.id.in_(moved_ids))
            .cte("teacher_lesson_chain", recursive=True)
        )
        child = aliased(Lesson)
        chain = chain.union(
            select(
                chain.c.root_id,
                child.id,
                child.course_offering_id,
                child.teacher_id,
                child.starts_at,
                child.ends_at,
                child.status,
                child.is_additional,
                child.previous_lesson_id,
            )
            .join(child, child.previous_lesson_id == chain.c.id)
            .where(chain.c.status == "moved")
        )
        for position in db.execute(
            select(chain).where(
                chain.c.status != "moved",
                chain.c.teacher_id == teacher_id,
                chain.c.is_additional.is_(False),
                _has_teacher_scope(chain.c.id, chain.c.course_offering_id, teacher_id),
            )
        ):
            latest[position.root_id] = _position(position)

    items = [
        TeacherScheduleItem(
            id=str(lesson.id),
            starts_at=lesson.starts_at,
            ends_at=lesson.ends_at,
            kind=lesson.kind,
            status=lesson.status,
            course_offering={
                "id": str(offering_id),
                "discipline": {"id": str(discipline_id), "name": discipline_name},
            },
            groups=allowed_groups[lesson.id],
            rooms=rooms[lesson.id],
            previous_lesson=previous.get(lesson.previous_lesson_id),
            latest_lesson=latest.get(lesson.id),
        )
        for lesson, offering_id, discipline_id, discipline_name in rows
    ]
    return TeacherScheduleResponse(
        date_from=params.date_from,
        date_to=params.date_to,
        timezone="Europe/Moscow",
        items=items,
    )
