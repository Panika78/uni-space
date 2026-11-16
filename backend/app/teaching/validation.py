"""Teaching-only BIGINT identifiers, validated before authorization queries."""

from typing import Annotated

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from pydantic import AfterValidator, Field, TypeAdapter, ValidationError

from app.core.schemas import Id

MAX_BIGINT_ID = "9223372036854775807"


def validate_bigint_id(value: str) -> str:
    # Length is bounded by Field before this validator; never parse arbitrary input.
    if len(value) == 19 and value > MAX_BIGINT_ID:
        raise ValueError("ID exceeds PostgreSQL BIGINT")
    return value


TeachingId = Annotated[
    Id,
    Field(max_length=19, description="Positive PostgreSQL BIGINT ID: 1..9223372036854775807"),
    AfterValidator(validate_bigint_id),
]
ID_ADAPTER = TypeAdapter(TeachingId)
ID_FIELDS = frozenset(
    {
        "course_offering_id",
        "group_id",
        "term_id",
        "student_id",
        "assessment_group_id",
        "assessment_id",
        "lesson_id",
    }
)


def validate_teaching_ids(request: Request) -> None:
    """Run at router level before any DB dependency, including for query filters."""
    errors = []
    for location, fields in (("path", request.path_params), ("query", request.query_params)):
        for name in sorted(ID_FIELDS.intersection(fields)):
            values = fields.getlist(name) if location == "query" else [fields[name]]
            for value in values:
                try:
                    ID_ADAPTER.validate_python(value)
                except ValidationError as exc:
                    errors.extend({**error, "loc": (location, name)} for error in exc.errors())
    if errors:
        raise RequestValidationError(errors)
