from datetime import date
from typing import Annotated, Literal, Self

from pydantic import Field, ValidationInfo, field_validator, model_validator

from app.core.schemas import Date, DateTime, Id, Page, RequestModel

ServiceCode = Literal[
    "study_certificate", "academic_transcript", "academic_leave", "accounting_certificate"
]


class Service(RequestModel):
    id: Id
    code: str
    title: str
    description: str
    processing_mode: Literal["automatic", "manual"]
    produces_document: bool
    action_available: bool
    unavailable_reason: str | None
    requirements: list[str]


class ServiceList(RequestModel):
    items: list[Service]


class StudyCertificateFormData(RequestModel):
    place_of_submission: str = Field(strict=True)

    @field_validator("place_of_submission", mode="before")
    @classmethod
    def trim_and_validate(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("invalid text")
        value = value.strip()
        if (
            "\x00" in value
            or any(0xD800 <= ord(c) <= 0xDFFF for c in value)
            or not 1 <= len(value) <= 300
        ):
            raise ValueError("invalid length")
        return value


# Historical import name retained for MVP1 consumers and tests.
ApplicationFormData = StudyCertificateFormData


class AcademicTranscriptInput(RequestModel):
    pass


class AcademicTranscriptFormData(RequestModel):
    academic_term_id: Id
    academic_term_name: str
    starts_on: Date
    ends_on: Date


class AcademicLeaveFormData(RequestModel):
    basis: Literal["medical", "family", "other"]
    starts_on: Date
    ends_on: Date
    explanation: str | None = Field(
        default=None, strict=True, max_length=3000, validate_default=True
    )

    @field_validator("ends_on")
    @classmethod
    def validate_end_date(cls, value: date, info: ValidationInfo) -> date:
        starts_on = info.data.get("starts_on")
        if starts_on is not None and starts_on > value:
            raise ValueError("start date must not follow end date")
        return value

    @field_validator("explanation")
    @classmethod
    def validate_explanation(cls, value: str | None, info: ValidationInfo) -> str | None:
        basis = info.data.get("basis")
        if value is not None:
            value = value.strip()
        if basis == "other" and value is None:
            raise ValueError("explanation required for other basis")
        if basis != "other" and value is not None:
            raise ValueError("explanation is only accepted for other basis")
        if value is not None and (
            not value or "\x00" in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value)
        ):
            raise ValueError("invalid explanation")
        return value


class AccountingCertificateFormData(RequestModel):
    purpose: str | None = Field(default=None, strict=True, max_length=300)

    @field_validator("purpose")
    @classmethod
    def validate_purpose(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value or "\x00" in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            raise ValueError("invalid purpose")
        return value


class CreateStudyCertificateRequest(RequestModel):
    service_code: Literal["study_certificate"]
    form_data: StudyCertificateFormData


class CreateAcademicTranscriptRequest(RequestModel):
    service_code: Literal["academic_transcript"]
    form_data: AcademicTranscriptInput


class CreateAcademicLeaveRequest(RequestModel):
    service_code: Literal["academic_leave"]
    form_data: AcademicLeaveFormData


class CreateAccountingCertificateRequest(RequestModel):
    service_code: Literal["accounting_certificate"]
    form_data: AccountingCertificateFormData


CreateApplicationRequest = Annotated[
    CreateStudyCertificateRequest
    | CreateAcademicTranscriptRequest
    | CreateAcademicLeaveRequest
    | CreateAccountingCertificateRequest,
    Field(discriminator="service_code"),
]


ReviewStatus = Literal[
    "submitted", "in_review", "needs_correction", "resubmitted", "approved", "rejected"
]


class AttachmentMetadata(RequestModel):
    id: Id
    original_filename: str
    mime_type: Literal["application/pdf", "image/jpeg", "image/png"]
    size_bytes: int


class IssuedDocumentMetadata(RequestModel):
    id: Id
    filename: str
    issued_at: DateTime


class ApplicationResponse(RequestModel):
    id: Id
    service: Service
    form_data: (
        StudyCertificateFormData
        | AcademicTranscriptFormData
        | AcademicLeaveFormData
        | AccountingCertificateFormData
    )
    review_status: ReviewStatus
    document_status: Literal["not_required", "pending", "ready", "failed"]
    feedback: str | None
    created_at: DateTime
    updated_at: DateTime
    version: int
    attachments: list[AttachmentMetadata] = Field(default_factory=list)
    document: IssuedDocumentMetadata | None = None


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
    form_data: (
        StudyCertificateFormData
        | AcademicTranscriptInput
        | AcademicLeaveFormData
        | AccountingCertificateFormData
    )
    keep_attachment_ids: list[Id] = Field(default_factory=list, max_length=5)


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
