from datetime import UTC, date, datetime
from typing import Annotated

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)

Id = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*$", strict=True)]
Date = date


def to_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


DateTime = Annotated[datetime, AwareDatetime, AfterValidator(to_utc)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Page[T](RequestModel):
    items: list[T]
    next_cursor: str | None


class PaginationParams(RequestModel):
    limit: int = Field(default=20, ge=1, le=100)
    cursor: str | None = None

    @field_validator("cursor")
    @classmethod
    def validate_cursor(cls, cursor: str | None) -> str | None:
        if cursor is not None:
            from app.core.pagination import validate_cursor

            validate_cursor(cursor)
        return cursor


class Ref(RequestModel):
    id: Id
    name: str


class ErrorDetail(RequestModel):
    field: str | None
    code: str


class ErrorBody(RequestModel):
    code: str
    message: str
    details: list[ErrorDetail]


class ApiError(RequestModel):
    error: ErrorBody
