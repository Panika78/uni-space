from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.schemas import DateTime, Id, Page, RequestModel


class Service(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Id
    code: str
    title: str


class ServiceList(RequestModel):
    items: list[Service]


class ApplicationFormData(RequestModel):
    place_of_submission: str = Field(strict=True)

    @field_validator("place_of_submission", mode="before")
    @classmethod
    def trim_and_validate(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("invalid text")
        value = value.strip()
        if (
            "\x00" in value
            or any(0xD800 <= ord(character) <= 0xDFFF for character in value)
            or not 1 <= len(value) <= 300
        ):
            raise ValueError("invalid length")
        return value


class CreateApplicationRequest(RequestModel):
    service_code: Literal["study_certificate"]
    form_data: ApplicationFormData


ReviewStatus = Literal[
    "submitted", "in_review", "needs_correction", "resubmitted", "approved", "rejected"
]


class ApplicationResponse(RequestModel):
    id: Id
    service: Service
    form_data: ApplicationFormData
    review_status: ReviewStatus
    document_status: Literal["not_required", "pending", "ready", "failed"]
    feedback: str | None
    created_at: DateTime
    updated_at: DateTime
    version: int


class ApplicationPage(Page[ApplicationResponse]):
    pass


class ReviewApplicationRequest(RequestModel):
    expected_version: int = Field(strict=True, ge=1, le=2_147_483_647)
    action: Literal["start_review", "approve", "reject", "return_for_correction"]
    comment: str | None = Field(default=None, strict=True, max_length=3000)

    @field_validator("comment")
    @classmethod
    def validate_comment(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value or "\x00" in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            raise ValueError("invalid comment")
        return value

    @model_validator(mode="after")
    def require_reason(self) -> Self:
        if self.action in ("reject", "return_for_correction") and self.comment is None:
            raise ValueError("reason required")
        return self


class ResubmitApplicationRequest(RequestModel):
    expected_version: int = Field(strict=True, ge=1, le=2_147_483_647)
    form_data: ApplicationFormData


class ApplicationHistoryEvent(RequestModel):
    id: Id
    actor_user_id: Id | None
    from_status: ReviewStatus | None
    to_status: ReviewStatus
    comment: str | None
    created_at: DateTime


class ApplicationHistoryPage(Page[ApplicationHistoryEvent]):
    pass


class StaffApplicationResponse(ApplicationResponse):
    student_id: Id
    reviewer_user_id: Id | None


class StaffApplicationPage(Page[StaffApplicationResponse]):
    pass
