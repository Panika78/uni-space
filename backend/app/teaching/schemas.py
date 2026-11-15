from typing import Literal

from pydantic import Field, model_validator

from app.core.schemas import Date, DateTime, Id, PaginationParams, Ref, RequestModel
from app.teaching.validation import TeachingId


class AssignmentParams(PaginationParams):
    course_offering_id: TeachingId | None = None
    group_id: TeachingId | None = None
    term_id: TeachingId | None = None


class StudentParams(PaginationParams):
    student_id: TeachingId | None = None


class AssessmentParams(PaginationParams):
    assessment_group_id: TeachingId | None = None


class LessonParams(PaginationParams):
    lesson_id: TeachingId | None = None
    starts_from: DateTime | None = None
    starts_before: DateTime | None = None
    status: Literal["scheduled", "cancelled", "moved"] | None = None

    @model_validator(mode="after")
    def validate_interval(self):
        if self.starts_from and self.starts_before and self.starts_from >= self.starts_before:
            raise ValueError("starts_before must follow starts_from")
        return self


class TeachingAssignmentResponse(RequestModel):
    id: Id
    course_offering_id: Id
    discipline: Ref
    term: Ref
    group: Ref
    attestation_type: Literal["exam", "pass_fail", "graded_pass"]


class JournalStudent(RequestModel):
    id: Id
    full_name: str
    subgroup_id: Id | None
    academic_status: Literal["enrolled", "academic_leave", "expelled", "graduated"]


class JournalAssessment(RequestModel):
    id: Id = Field(description="assessment_groups.id; group-specific work identity")
    assessment_id: Id
    title: str
    type: str
    description: str | None
    max_score: int
    planned_date: Date | None
    lesson_id: Id | None
    date_needs_confirmation: bool


class JournalResult(RequestModel):
    student_id: Id
    full_name: str
    result_id: Id | None
    score: int | None
    graded_at: DateTime | None
    is_current_group_member: bool


class JournalLesson(RequestModel):
    id: Id
    starts_at: DateTime
    ends_at: DateTime
    kind: Literal["lecture", "seminar", "lab", "other"]
    status: Literal["scheduled", "cancelled", "moved"]
    is_additional: bool
    version: int


class AssessmentDateUpdate(RequestModel):
    assessment_group_id: TeachingId
    planned_date: Date | None
    lesson_id: TeachingId | None

    @model_validator(mode="after")
    def validate_date_link(self):
        if self.lesson_id is not None and self.planned_date is None:
            raise ValueError("A linked lesson requires a date")
        return self


class AssessmentDatesRequest(RequestModel):
    items: list[AssessmentDateUpdate] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_unique_targets(self):
        if len({item.assessment_group_id for item in self.items}) != len(self.items):
            raise ValueError("Duplicate assessment group")
        return self


class AssessmentDateResponse(RequestModel):
    assessment_group_id: TeachingId
    planned_date: Date | None
    lesson_id: TeachingId | None
    date_needs_confirmation: bool


class AssessmentDatesResponse(RequestModel):
    items: list[AssessmentDateResponse]
