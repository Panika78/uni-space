"""Staff editor contract; complete proposed state on PATCH and move."""

from datetime import date
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from app.core.schemas import DateTime, RequestModel
from app.core.schemas import Id as CoreId
from app.schedule.schemas import ScheduleParams


def validate_editor_id(value: str) -> str:
    if len(value) > 19 or int(value) > 9223372036854775807:
        raise ValueError("ID exceeds PostgreSQL bigint range")
    return value


Id = Annotated[CoreId, AfterValidator(validate_editor_id)]


class LessonParticipant(RequestModel):
    group_id: Id
    subgroup_id: Id | None = None


class EditorParticipantDisplay(RequestModel):
    group_id: Id
    group_name: str
    subgroup_id: Id | None = None
    subgroup_name: str | None = None


class EditorRoomDisplay(RequestModel):
    id: Id
    name: str
    building_id: Id
    building_name: str


class EditorOfferingGroupDisplay(RequestModel):
    id: Id
    name: str


class EditorCourseOfferingDisplay(RequestModel):
    id: Id
    discipline_id: Id
    discipline_name: str
    discipline_code: str | None
    term_id: Id
    term_name: str
    term_starts_on: date
    term_ends_on: date
    attestation_type: Literal["exam", "pass_fail", "graded_pass"]
    groups: list[EditorOfferingGroupDisplay]


class EditorTeacherDisplay(RequestModel):
    id: Id
    full_name: str


class EditorLessonDisplay(RequestModel):
    course_offering: EditorCourseOfferingDisplay
    teacher: EditorTeacherDisplay | None
    participants: list[EditorParticipantDisplay]
    rooms: list[EditorRoomDisplay]


class LessonWrite(RequestModel):
    course_offering_id: Id
    teacher_id: Id | None = None
    starts_at: DateTime
    ends_at: DateTime
    kind: Literal["lecture", "seminar", "lab", "other"]
    participants: list[LessonParticipant] = Field(min_length=1, max_length=200)
    room_ids: list[Id] = Field(max_length=100)

    @model_validator(mode="after")
    def validate_state(self) -> Self:
        if self.ends_at <= self.starts_at or len(set(self.room_ids)) != len(self.room_ids):
            raise ValueError("Invalid interval or duplicate rooms")
        return self


class ExpectedVersion(RequestModel):
    version: int = Field(ge=1, strict=True)


class LessonChange(LessonWrite, ExpectedVersion):
    pass


class EditorLesson(LessonWrite):
    participants: list[LessonParticipant]
    id: Id
    version: int
    status: Literal["scheduled", "cancelled", "moved"]
    previous_lesson_id: Id | None
    next_lesson_id: Id | None
    created_by_user_id: Id | None
    display: EditorLessonDisplay


class EditorScheduleParams(ScheduleParams):
    resource: Literal["group", "teacher", "room"]
    resource_id: Id
    after_id: Id | None = Field(
        default=None,
        description="Last lesson ID: (starts_at, id) anchor within the same selection",
    )
    limit: int = Field(default=100, ge=1, le=200)


class EditorSchedule(RequestModel):
    items: list[EditorLesson]
    next_after_id: Id | None


class CatalogParams(RequestModel):
    q: str = Field(default="", max_length=100)
    after_id: Id | None = None
    limit: int = Field(default=50, ge=1, le=100)
    group_id: Id | None = None
    course_offering_id: Id | None = None


class CatalogItem(RequestModel):
    id: Id
    name: str
    group_id: Id | None = None
    building_id: Id | None = None
    building_name: str | None = None
    term_id: Id | None = None
    term_name: str | None = None
    group_ids: list[Id] = Field(default_factory=list)
    course_offering_id: Id | None = None
    teacher_id: Id | None = None


class CatalogPage(RequestModel):
    items: list[CatalogItem]
    next_after_id: Id | None
