from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.schemas import DateTime, Id, RequestModel


class Service(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Id
    code: Literal["study_certificate"]
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


class ApplicationResponse(RequestModel):
    id: Id
    service: Service
    form_data: ApplicationFormData
    review_status: Literal[
        "submitted", "in_review", "needs_correction", "resubmitted", "approved", "rejected"
    ]
    document_status: Literal["not_required", "pending", "ready", "failed"]
    feedback: str | None
    created_at: DateTime
    updated_at: DateTime
