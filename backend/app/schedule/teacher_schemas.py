from typing import Literal, Self

from pydantic import model_validator

from app.core.schemas import Date, DateTime, Id, Ref, RequestModel

LessonStatus = Literal["scheduled", "cancelled", "moved"]


class TeacherScheduleParams(RequestModel):
    date_from: Date
    date_to: Date

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if not 0 <= (self.date_to - self.date_from).days < 31:
            raise ValueError("Expected 1 to 31 calendar days")
        return self


class TeacherLessonPosition(RequestModel):
    id: Id
    starts_at: DateTime
    ends_at: DateTime
    status: LessonStatus


class TeacherCourseOfferingRef(RequestModel):
    id: Id
    discipline: Ref


class TeacherLessonGroup(Ref):
    subgroup: Ref | None


class TeacherRoomRef(Ref):
    building: Ref


class TeacherScheduleItem(TeacherLessonPosition):
    kind: Literal["lecture", "seminar", "lab", "other"]
    course_offering: TeacherCourseOfferingRef
    groups: list[TeacherLessonGroup]
    rooms: list[TeacherRoomRef]
    previous_lesson: TeacherLessonPosition | None
    latest_lesson: TeacherLessonPosition | None


class TeacherScheduleResponse(RequestModel):
    date_from: Date
    date_to: Date
    timezone: Literal["Europe/Moscow"]
    items: list[TeacherScheduleItem]
