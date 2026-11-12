from typing import Literal

from app.core.schemas import Date, Id, Ref, RequestModel


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
