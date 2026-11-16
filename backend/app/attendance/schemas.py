from typing import Literal

from app.core.schemas import DateTime, Id, PaginationParams, RequestModel
from app.teaching.validation import TeachingId


class AttendanceInput(RequestModel):
    status: Literal["attended", "absent"]


class AttendanceResponse(RequestModel):
    lesson_id: Id
    student_id: Id
    status: Literal["attended", "absent", "unmarked"]
    lesson_status: Literal["scheduled", "cancelled", "moved"]
    starts_at: DateTime
    ends_at: DateTime
    updated_at: DateTime | None


class AttendanceParams(PaginationParams):
    lesson_id: TeachingId | None = None
