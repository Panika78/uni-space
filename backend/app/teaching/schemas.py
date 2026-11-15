from typing import Literal

from pydantic import Field, StrictInt, model_validator

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


class ScoreWriteRequest(RequestModel):
    score: StrictInt | None = Field(ge=0)


class ScoreWriteResponse(RequestModel):
    result_id: Id | None
    score: int | None
    graded_at: DateTime | None


class JournalLesson(RequestModel):
    id: Id
    starts_at: DateTime
    ends_at: DateTime
    kind: Literal["lecture", "seminar", "lab", "other"]
    status: Literal["scheduled", "cancelled", "moved"]
    is_additional: bool
    version: int
