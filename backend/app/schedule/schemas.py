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


AttendanceStatus = Literal["attended", "absent", "unmarked"]


class LinkedAssessmentResult(RequestModel):
    assessment_group_id: Id
    score: int | None
    max_score: int


class LessonDetails(LessonPosition):
    kind: Literal["lecture", "seminar", "lab", "other"]
    teacher: Ref | None
    rooms: list[RoomRef]
    previous_lesson: LessonPosition | None
    latest_lesson: LessonPosition | None


class LessonResponse(LessonDetails):
    course_offering: CourseOfferingRef
    groups: list[Ref]
    attendance_status: AttendanceStatus | None = None
    linked_assessments: list[LinkedAssessmentResult] | None = None


class ScheduleResponse(RequestModel):
    date_from: Date
    date_to: Date
    timezone: Literal["Europe/Moscow"]
    items: list[LessonResponse]
