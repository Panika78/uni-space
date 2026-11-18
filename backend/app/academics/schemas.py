from typing import Literal

from app.core.schemas import Date, DateTime, Id, Ref, RequestModel
from app.schedule.schemas import AttendanceStatus, LessonDetails


class AcademicTermResponse(Ref):
    starts_on: Date
    ends_on: Date


class FinalResultResponse(RequestModel):
    grade_value: Literal[2, 3, 4, 5] | None
    passed: bool | None
    has_debt: bool
    retake_date: Date | None
    retake_location: str | None


class AcademicItem(RequestModel):
    course_offering_id: Id
    discipline: Ref
    total_score: int
    max_score: int
    graded_assessment_count: int
    assessment_count: int
    attestation_type: Literal["exam", "pass_fail", "graded_pass"]
    final_result: FinalResultResponse


class AcademicsResponse(RequestModel):
    term: AcademicTermResponse | None
    items: list[AcademicItem]


class StudentCourse(AcademicItem):
    term: AcademicTermResponse
    group: Ref
    teachers: list[Ref]


class StudentCourseLesson(LessonDetails):
    attendance_status: AttendanceStatus


class StudentCourseAssessment(RequestModel):
    assessment_group_id: Id
    assessment_id: Id
    title: str
    type: Literal[
        "test",
        "laboratory",
        "practical",
        "seminar",
        "independent",
        "extended_homework",
        "exam",
        "other",
    ]
    description: str | None
    max_score: int
    planned_date: Date | None
    date_needs_confirmation: bool
    lesson_id: Id | None
    score: int | None
    graded_at: DateTime | None
