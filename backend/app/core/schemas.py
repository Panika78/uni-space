import re
from datetime import UTC, date, datetime
from typing import Annotated

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)

Id = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*$", strict=True)]

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?"
    r"(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d|[+-](?:[01]\d|2[0-3]))$"
)


def parse_api_date(value: object) -> date:
    if isinstance(value, datetime):
        raise ValueError("Date must not include a time")
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise ValueError("Date must use YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Date is not a valid calendar date") from exc


def parse_api_datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        if value.utcoffset() is None:
            raise ValueError("DateTime must include a timezone")
        return value
    if not isinstance(value, str) or not DATETIME_PATTERN.fullmatch(value):
        raise ValueError("DateTime must use ISO 8601 with a timezone")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("DateTime is not a valid ISO 8601 value") from exc


Date = Annotated[date, BeforeValidator(parse_api_date)]


def to_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


DateTime = Annotated[
    datetime,
    AwareDatetime,
    BeforeValidator(parse_api_datetime),
    AfterValidator(to_utc),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Page[T](RequestModel):
    items: list[T]
    next_cursor: str | None


def parse_pagination_limit(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        return int(value)
    raise ValueError("Input should be a whole number")


class PaginationParams(RequestModel):
    limit: Annotated[int, BeforeValidator(parse_pagination_limit)] = Field(default=20, ge=1, le=100)
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
