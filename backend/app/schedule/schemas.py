from typing import Literal, Self

from pydantic import model_validator

from app.core.schemas import Date, DateTime, Id, Ref, RequestModel

LessonStatus = Literal["scheduled", "cancelled", "moved"]


class ScheduleParams(RequestModel):
    date_from: Date
    date_to: Date

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if not 0 <= (self.date_to - self.date_from).days < 31:
            raise ValueError("Expected 1 to 31 calendar days")
        return self


class LessonPosition(RequestModel):
    id: Id
    starts_at: DateTime
    ends_at: DateTime
    status: LessonStatus


class CourseOfferingRef(RequestModel):
    id: Id
    discipline: Ref


class RoomRef(Ref):
    building: Ref


class LessonResponse(LessonPosition):
    course_offering: CourseOfferingRef
    kind: Literal["lecture", "seminar", "lab", "other"]
    teacher: Ref | None
    groups: list[Ref]
    rooms: list[RoomRef]
    previous_lesson: LessonPosition | None
    latest_lesson: LessonPosition | None


class ScheduleResponse(RequestModel):
    date_from: Date
    date_to: Date
    timezone: Literal["Europe/Moscow"]
    items: list[LessonResponse]
