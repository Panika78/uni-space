from collections import defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import DateTime, cast, func, literal, select
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
    Teacher,
    User,
)
from app.schedule.participants import get_student_lesson_condition
from app.schedule.schemas import LessonPosition, LessonResponse, ScheduleParams, ScheduleResponse

MOSCOW = ZoneInfo("Europe/Moscow")


def get_lesson_position(lesson) -> LessonPosition:
    return LessonPosition(
        id=str(lesson.id), starts_at=lesson.starts_at, ends_at=lesson.ends_at, status=lesson.status
    )


def list_student_schedule(
    db: Session, group_id: int, params: ScheduleParams, subgroup_id: int | None = None
) -> ScheduleResponse:
    range_start = datetime.combine(params.date_from, time.min, MOSCOW)
    range_end = (
        cast(literal("10000-01-01 00:00:00+03"), DateTime(timezone=True))
        if params.date_to == date.max
        else datetime.combine(params.date_to + timedelta(days=1), time.min, MOSCOW)
    )
    # EXISTS limits actual lesson assignments without multiplying groups by rooms.
    rows = db.execute(
        select(
            Lesson,
            CourseOffering.id,
            Discipline.id,
            Discipline.name,
            Teacher.id,
            func.coalesce(User.full_name, Teacher.full_name),
        )
        .join(CourseOffering, Lesson.course_offering_id == CourseOffering.id)
        .join(Discipline, CourseOffering.discipline_id == Discipline.id)
        .outerjoin(Teacher, Lesson.teacher_id == Teacher.id)
        .outerjoin(User, Teacher.user_id == User.id)
        .where(
            get_student_lesson_condition(Lesson.id, group_id, subgroup_id),
            Lesson.starts_at < range_end,
            Lesson.ends_at > range_start,
        )
        .order_by(Lesson.starts_at, Lesson.id)
    ).all()
    if not rows:
        return ScheduleResponse(
            date_from=params.date_from, date_to=params.date_to, timezone="Europe/Moscow", items=[]
        )
    ids = [row[0].id for row in rows]
    groups = defaultdict(list)
    for lesson_id, group in db.execute(
        select(LessonGroup.lesson_id, StudyGroup)
        .join(StudyGroup, LessonGroup.group_id == StudyGroup.id)
        .where(LessonGroup.lesson_id.in_(ids))
        .distinct()
        .order_by(StudyGroup.name, StudyGroup.id)
    ):
        groups[lesson_id].append({"id": str(group.id), "name": group.name})
    rooms = defaultdict(list)
    for lesson_id, room, building in db.execute(
        select(LessonRoom.lesson_id, Room, Building)
        .join(Room, LessonRoom.room_id == Room.id)
        .join(Building, Room.building_id == Building.id)
        .where(LessonRoom.lesson_id.in_(ids))
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
    previous = (
        {
            lesson.id: get_lesson_position(lesson)
            for lesson in db.scalars(
                select(Lesson).where(
                    Lesson.id.in_(previous_ids),
                    get_student_lesson_condition(Lesson.id, group_id, subgroup_id),
                )
            )
        }
        if previous_ids
        else {}
    )
    moved_ids = [row[0].id for row in rows if row[0].status == "moved"]
    latest = {}
    if moved_ids:
        # UNION deduplicates even malformed cyclic imports. No per-lesson/chain SQL.
        chain = (
            select(
                Lesson.id.label("root_id"),
                Lesson.id,
                Lesson.starts_at,
                Lesson.ends_at,
                Lesson.status,
            )
            .where(Lesson.id.in_(moved_ids))
            .cte("lesson_chain", recursive=True)
        )
        child = aliased(Lesson)
        chain = chain.union(
            select(chain.c.root_id, child.id, child.starts_at, child.ends_at, child.status)
            .join(child, child.previous_lesson_id == chain.c.id)
            .where(chain.c.status == "moved")
        )
        # Traverse the whole chain, then authorize the returned terminal position.
        # An intermediate reassignment must not hide a later return to this group.
        for position in db.execute(
            select(chain).where(
                chain.c.status != "moved",
                get_student_lesson_condition(chain.c.id, group_id, subgroup_id),
            )
        ):
            latest[position.root_id] = get_lesson_position(position)
    items = []
    for lesson, offering_id, discipline_id, discipline_name, teacher_id, teacher_name in rows:
        items.append(
            LessonResponse(
                **get_lesson_position(lesson).model_dump(),
                course_offering={
                    "id": str(offering_id),
                    "discipline": {"id": str(discipline_id), "name": discipline_name},
                },
                kind=lesson.kind,
                teacher={"id": str(teacher_id), "name": teacher_name} if teacher_id else None,
                groups=groups[lesson.id],
                rooms=rooms[lesson.id],
                previous_lesson=previous.get(lesson.previous_lesson_id),
                latest_lesson=latest.get(lesson.id),
            )
        )
    return ScheduleResponse(
        date_from=params.date_from, date_to=params.date_to, timezone="Europe/Moscow", items=items
    )
