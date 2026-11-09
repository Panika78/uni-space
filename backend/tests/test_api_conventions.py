import asyncio
import base64
import json
import logging
import socket
import threading
import time
import traceback
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import urlencode

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from app.core.errors import install_exception_handlers
from app.core.middleware import REQUEST_ID_PATTERN, ApiHeadersMiddleware, ResponseStreamAborted
from app.core.pagination import (
    InvalidCursorError,
    SortDirection,
    decode_page_cursor,
    paginate,
    paginate_results,
)
from app.core.schemas import Date, DateTime, Id, Page, PaginationParams, RequestModel
from app.main import app, create_openapi_schema


class RequestBody(RequestModel):
    name: str
    count: Annotated[int, Field(ge=1, le=5)]


class LocationNestedBody(BaseModel):
    body: int


class LocationItemBody(BaseModel):
    header: int


class LocationBody(BaseModel):
    body: int
    form_data: LocationNestedBody
    query: int
    items: list[LocationItemBody]


SYNTHETIC_SECRET = "f06-synthetic-token-7b10"


def make_error_test_app() -> FastAPI:
    test_app = FastAPI()
    test_app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(test_app)

    @test_app.get("/api/v1/ok")
    def ok() -> dict[str, bool]:
        return {"ok": True}

    @test_app.get("/api/v1/fail")
    def fail() -> None:
        raise HTTPException(status_code=404, detail="not_found")

    @test_app.get("/api/v1/unauthorized")
    def unauthorized() -> None:
        raise HTTPException(status_code=401, detail="invalid_credentials")

    @test_app.get("/api/v1/wrong-401-code")
    def wrong_unauthorized_code() -> None:
        raise HTTPException(status_code=401, detail="not_found")

    @test_app.get("/api/v1/forbidden")
    def forbidden() -> None:
        raise HTTPException(status_code=403, detail="forbidden")

    @test_app.get("/api/v1/wrong-code")
    def wrong_code() -> None:
        raise HTTPException(status_code=404, detail="access_expired")

    @test_app.get("/api/v1/explicit-500")
    def explicit_server_error() -> None:
        raise HTTPException(
            status_code=500,
            detail="private database secret",
            headers={"Retry-After": "11"},
        )

    @test_app.get("/api/v1/explicit-422")
    def explicit_validation_error() -> None:
        raise HTTPException(status_code=422, detail="access_expired")

    @test_app.get("/api/v1/crash")
    def crash() -> None:
        raise RuntimeError(f"database credential: {SYNTHETIC_SECRET}")

    @test_app.get("/api/v1/stream-crash")
    def stream_crash() -> StreamingResponse:
        def body():
            yield b"partial response"
            raise RuntimeError(f"stream failed with token {SYNTHETIC_SECRET}")

        return StreamingResponse(body(), media_type="text/plain")

    @test_app.get("/api/v1/stream-ok")
    def stream_ok() -> StreamingResponse:
        def body():
            yield b"first "
            yield b"second"

        return StreamingResponse(body(), media_type="text/plain")

    @test_app.get("/api/v1/limited")
    def limited() -> None:
        raise HTTPException(status_code=429, detail="rate_limited", headers={"Retry-After": "30"})

    @test_app.post("/api/v1/validate")
    def validate(body: RequestBody) -> RequestBody:
        return body

    @test_app.post("/api/v1/field-locations")
    def field_locations(body: LocationBody) -> LocationBody:
        return body

    @test_app.get("/api/v1/query-location")
    def query_location(cursor: int = Query(...)) -> dict[str, int]:
        return {"cursor": cursor}

    @test_app.get("/api/v1/page")
    def page(params: Annotated[PaginationParams, Query()]) -> dict[str, object]:
        rows = [
            {"published_at": "2026-11-03", "id": 9},
            {"published_at": "2026-11-03", "id": 5},
            {"published_at": "2026-11-02", "id": 8},
            {"published_at": "2026-11-02", "id": 4},
            {"published_at": "2026-11-01", "id": 7},
            {"published_at": "2026-11-01", "id": 3},
        ]
        result = paginate(
            rows,
            key=lambda row: (row["published_at"], row["id"]),
            key_types=(str, int),
            direction="desc",
            limit=params.limit,
            cursor=params.cursor,
        )
        return {"limit": params.limit, "items": result.items, "next_cursor": result.next_cursor}

    return test_app


def make_cursor(
    key: list[str | int | float],
    *,
    version: int = 2,
    direction: str = "desc",
    extra: dict[str, object] | None = None,
) -> str:
    payload: dict[str, object] = {"v": version, "direction": direction, "key": key}
    if extra:
        payload.update(extra)
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_id_is_a_positive_integer_string_and_page_defaults_to_empty_items() -> None:
    adapter = TypeAdapter(Id)
    assert adapter.validate_python("123") == "123"
    for invalid_id in (0, "0", "-1", "01", "abc"):
        with pytest.raises(ValidationError):
            adapter.validate_python(invalid_id)

    date_time_adapter = TypeAdapter(DateTime)
    with pytest.raises(ValidationError):
        date_time_adapter.validate_python("2026-11-01T12:00:00")
    assert date_time_adapter.validate_python("2026-11-01T15:00:00+03:00").isoformat() == (
        "2026-11-01T12:00:00+00:00"
    )
    assert Page[dict[str, str]](items=[], next_cursor=None).model_dump() == {
        "items": [],
        "next_cursor": None,
    }

    with pytest.raises(ValidationError):
        Page[dict[str, str]](items=[{"id": "0"}], next_cursor=None, extra="ignored")


@pytest.mark.parametrize("value", ["0001-01-01", "2024-02-29", "9999-12-31"])
def test_date_accepts_contract_strings_and_calendar_boundaries(value: str) -> None:
    adapter = TypeAdapter(Date)
    assert adapter.validate_json(json.dumps(value)).isoformat() == value


@pytest.mark.parametrize(
    "value",
    [
        "2023-02-29",
        "2024-02-30",
        "2024-2-09",
        "2024-02-29T00:00:00Z",
        "0000-01-01",
        "2024-00-01",
        "2024-13-01",
        "2024-01-00",
    ],
)
def test_date_rejects_invalid_json_formats_and_calendar_values(value: str) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(Date).validate_json(json.dumps(value))


def test_date_rejects_json_unix_timestamps_and_accepts_python_date_values() -> None:
    adapter = TypeAdapter(Date)
    with pytest.raises(ValidationError):
        adapter.validate_json("1793563200")
    assert adapter.validate_python(date(2024, 2, 29)) == date(2024, 2, 29)
    assert adapter.dump_json(date(2024, 2, 29)) == b'"2024-02-29"'
    with pytest.raises(ValidationError):
        adapter.validate_python(datetime(2024, 2, 29, tzinfo=UTC))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-11-01T12:00:00Z", "2026-11-01T12:00:00+00:00"),
        ("2026-11-01T15:00:00+03:00", "2026-11-01T12:00:00+00:00"),
        ("2026-11-01T07:00:00-05:00", "2026-11-01T12:00:00+00:00"),
        ("2026-11-01T15:00:00+0300", "2026-11-01T12:00:00+00:00"),
    ],
)
def test_datetime_accepts_iso_8601_timezone_forms_and_normalizes_to_utc(
    value: str,
    expected: str,
) -> None:
    adapter = TypeAdapter(DateTime)
    assert adapter.validate_json(json.dumps(value)).isoformat() == expected


@pytest.mark.parametrize(
    "value",
    [
        "2026-11-01T12:00:00",
        "2026-11-01 12:00:00Z",
        "2026-11-01T12:00:00UTC",
        "2026-11-01T12:00:00+25:00",
        "2026-11-01T12:00:00+03:99",
        "2026-02-30T12:00:00Z",
    ],
)
def test_datetime_rejects_missing_or_invalid_timezone_and_calendar_values(value: str) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(DateTime).validate_json(json.dumps(value))


@pytest.mark.parametrize("timestamp", [1793563200, 1793563200.0])
def test_datetime_rejects_json_unix_timestamps(timestamp: int | float) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(DateTime).validate_json(json.dumps(timestamp))


def test_datetime_accepts_aware_python_values_and_serializes_utc() -> None:
    adapter = TypeAdapter(DateTime)
    source = datetime(2026, 11, 1, 15, 0, tzinfo=timezone(timedelta(hours=3)))
    normalized = adapter.validate_python(source)
    assert normalized == datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    assert adapter.dump_json(normalized) == b'"2026-11-01T12:00:00Z"'

    with pytest.raises(ValidationError):
        adapter.validate_python(datetime(2026, 11, 1, 12, 0))


def test_openapi_common_date_schemas_keep_standard_formats() -> None:
    date_schema = TypeAdapter(Date).json_schema()
    datetime_schema = TypeAdapter(DateTime).json_schema()
    assert date_schema["type"] == "string"
    assert date_schema["format"] == "date"
    assert datetime_schema["type"] == "string"
    assert datetime_schema["format"] == "date-time"


@pytest.mark.parametrize("limit", [0, 101, -1])
def test_pagination_params_reject_out_of_range_limits(limit: int) -> None:
    with pytest.raises(ValidationError):
        PaginationParams(limit=limit)


def test_pagination_params_accepts_default_and_inclusive_bounds() -> None:
    assert PaginationParams().limit == 20
    assert PaginationParams(limit=1).limit == 1
    assert PaginationParams(limit=100).limit == 100


@pytest.mark.parametrize("cursor", ["!", "", "bm90LWpzb24", "eyJ2IjoyLCJrZXkiOlsxXX0"])
def test_pagination_params_rejects_malformed_cursor(cursor: str) -> None:
    with pytest.raises(ValidationError):
        PaginationParams(cursor=cursor)


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "cursor=invalid", "unexpected=1"])
def test_invalid_pagination_query_returns_422(query: str) -> None:
    client = TestClient(make_error_test_app())
    response = client.get(f"/api/v1/page?{query}")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert response.headers.get("x-request-id")


@pytest.mark.parametrize(
    "cursor",
    [
        make_cursor(["2026-11-03", "9"]),
        make_cursor(["2026-11-03"]),
        make_cursor(["2026-11-03", 9], version=1),
        make_cursor(["2026-11-03", 9], extra={"unexpected": True}),
        make_cursor(["2026-11-03", 9], direction="asc"),
    ],
)
def test_selection_incompatible_cursor_returns_api_422(cursor: str) -> None:
    client = TestClient(make_error_test_app())
    response = client.get(f"/api/v1/page?{urlencode({'limit': 2, 'cursor': cursor})}")
    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "validation_error",
            "message": "Проверьте введённые данные",
            "details": [{"field": "cursor", "code": "invalid_value"}],
        }
    }


def test_desc_cursor_pagination_preserves_multi_date_order_without_gaps_or_duplicates() -> None:
    rows = [
        {"published_at": "2026-11-03", "id": 9},
        {"published_at": "2026-11-03", "id": 5},
        {"published_at": "2026-11-02", "id": 8},
        {"published_at": "2026-11-02", "id": 4},
        {"published_at": "2026-11-01", "id": 7},
        {"published_at": "2026-11-01", "id": 3},
        {"published_at": "2026-10-31", "id": 99},
    ]
    pages = []
    cursor = None
    for _ in range(10):
        page = paginate(
            rows,
            key=lambda row: (row["published_at"], row["id"]),
            key_types=(str, int),
            direction="desc",
            limit=2,
            cursor=cursor,
        )
        pages.append(page)
        cursor = page.next_cursor
        if cursor is None:
            break
    else:
        pytest.fail("pagination did not terminate")

    actual = [(row["published_at"], row["id"]) for page in pages for row in page.items]
    expected = [(row["published_at"], row["id"]) for row in rows]
    assert actual == expected
    assert len(actual) == len(set(actual)) == 7
    assert [len(page.items) for page in pages] == [2, 2, 2, 1]
    assert pages[-1].next_cursor is None


def test_cursor_is_validated_against_empty_selection_schema() -> None:
    def key(row: dict[str, str | int]) -> tuple[str, int]:
        return row["published_at"], row["id"]

    valid_cursor = make_cursor(["2026-11-01", 2])
    page = paginate(
        [],
        key=key,
        key_types=(str, int),
        direction="desc",
        cursor=valid_cursor,
    )
    assert page.items == []
    assert page.next_cursor is None

    with pytest.raises(InvalidCursorError):
        paginate(
            [],
            key=key,
            key_types=(str, int),
            direction="desc",
            cursor=make_cursor(["2026-11-01", "2"]),
        )


def test_wrong_item_order_is_rejected_instead_of_silently_skipping_rows() -> None:
    wrong_order = [
        {"published_at": "2026-11-01", "id": 1},
        {"published_at": "2026-11-02", "id": 2},
    ]
    with pytest.raises(ValueError, match="strictly ordered"):
        paginate(
            wrong_order,
            key=lambda row: (row["published_at"], row["id"]),
            key_types=(str, int),
            direction="desc",
        )

    duplicated_key = [
        {"published_at": "2026-11-02", "id": 2},
        {"published_at": "2026-11-02", "id": 2},
    ]
    with pytest.raises(ValueError, match="strictly ordered"):
        paginate(
            duplicated_key,
            key=lambda row: (row["published_at"], row["id"]),
            key_types=(str, int),
            direction="desc",
        )


@pytest.mark.parametrize("direction", ["asc", "desc"])
def test_bounded_query_pages_walk_composite_key_without_gaps_or_duplicates(
    direction: SortDirection,
) -> None:
    ascending_rows = [
        {"created_at": "2026-11-01", "id": 1},
        {"created_at": "2026-11-01", "id": 4},
        {"created_at": "2026-11-02", "id": 2},
        {"created_at": "2026-11-02", "id": 7},
        {"created_at": "2026-11-03", "id": 3},
        {"created_at": "2026-11-03", "id": 8},
        {"created_at": "2026-11-04", "id": 9},
    ]
    ordered_rows = ascending_rows if direction == "asc" else list(reversed(ascending_rows))
    pages = []
    collected = []
    cursor = None

    for _ in range(10):
        cursor_key = decode_page_cursor(
            cursor,
            key_types=(str, int),
            direction=direction,
        )
        # This bounded list models the SQL cursor predicate, ORDER BY, and LIMIT 3.
        if cursor_key is None:
            query_rows = ordered_rows
        elif direction == "asc":
            query_rows = [
                row for row in ordered_rows if (row["created_at"], row["id"]) > cursor_key
            ]
        else:
            query_rows = [
                row for row in ordered_rows if (row["created_at"], row["id"]) < cursor_key
            ]
        query_rows = query_rows[:3]
        page = paginate_results(
            iter(query_rows),
            key=lambda row: (row["created_at"], row["id"]),
            key_types=(str, int),
            direction=direction,
            limit=2,
        )
        pages.append(page)
        collected.extend(page.items)
        cursor = page.next_cursor
        if cursor is None:
            break
        assert decode_page_cursor(
            cursor,
            key_types=(str, int),
            direction=direction,
        ) == (page.items[-1]["created_at"], page.items[-1]["id"])
    else:
        pytest.fail("bounded keyset pagination did not terminate")

    actual = [(row["created_at"], row["id"]) for row in collected]
    expected = [(row["created_at"], row["id"]) for row in ordered_rows]
    assert actual == expected
    assert len(actual) == len(set(actual)) == len(ordered_rows)
    assert [len(page.items) for page in pages] == [2, 2, 2, 1]
    assert pages[-1].next_cursor is None


def test_paginate_results_consumes_only_limit_plus_one_generator_items() -> None:
    consumed = 0

    def rows():
        nonlocal consumed
        for identifier in range(100):
            consumed += 1
            yield {"id": identifier}

    page = paginate_results(
        rows(),
        key=lambda row: (row["id"],),
        key_types=(int,),
        direction="asc",
        limit=2,
    )
    assert [row["id"] for row in page.items] == [0, 1]
    assert page.next_cursor is not None
    assert decode_page_cursor(page.next_cursor, key_types=(int,), direction="asc") == (1,)
    assert consumed == 3


def test_decode_page_cursor_rejects_incompatible_key_before_query_construction() -> None:
    cursor = make_cursor(["2026-11-01", "4"], direction="desc")
    with pytest.raises(InvalidCursorError):
        decode_page_cursor(cursor, key_types=(str, int), direction="desc")


def test_pagination_rejects_invalid_runtime_arguments() -> None:
    with pytest.raises(InvalidCursorError):
        paginate([], key=lambda row: (row,), key_types=(str,), cursor="invalid")
    with pytest.raises(ValueError):
        paginate([], key=lambda row: (row,), key_types=(str,), limit=0)


def test_request_ids_and_cache_headers_cover_success_and_errors() -> None:
    client = TestClient(make_error_test_app(), raise_server_exceptions=False)

    success = client.get("/api/v1/ok", headers={"X-Request-ID": "caller-request_1"})
    assert success.status_code == 200
    assert success.headers["x-request-id"] == "caller-request_1"
    assert success.headers["cache-control"] == "no-store"

    not_found = client.get("/api/v1/fail", headers={"X-Request-ID": "invalid id"})
    assert not_found.status_code == 404
    assert REQUEST_ID_PATTERN.fullmatch(not_found.headers["x-request-id"])
    assert not_found.headers["cache-control"] == "no-store"
    assert not_found.json() == {
        "error": {
            "code": "not_found",
            "message": "Not Found",
            "details": [],
        }
    }

    unauthorized = client.get("/api/v1/unauthorized")
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "invalid_credentials"

    wrong_unauthorized_code = client.get("/api/v1/wrong-401-code")
    assert wrong_unauthorized_code.status_code == 401
    assert wrong_unauthorized_code.json()["error"]["code"] == "invalid_access"

    forbidden = client.get("/api/v1/forbidden")
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "forbidden"

    wrong_code = client.get("/api/v1/wrong-code")
    assert wrong_code.status_code == 404
    assert wrong_code.json()["error"]["code"] == "not_found"

    explicit_validation = client.get("/api/v1/explicit-422")
    assert explicit_validation.status_code == 422
    assert explicit_validation.json()["error"]["code"] == "validation_error"

    limited = client.get("/api/v1/limited")
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "30"
    assert limited.json()["error"]["code"] == "rate_limited"


def test_explicit_http_500_is_generic_and_preserves_required_headers() -> None:
    client = TestClient(make_error_test_app(), raise_server_exceptions=False)
    response = client.get("/api/v1/explicit-500")

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "internal_error",
            "message": "Внутренняя ошибка сервера",
            "details": [],
        }
    }
    assert "secret" not in response.text
    assert response.headers["retry-after"] == "11"
    assert response.headers.get("x-request-id")
    assert response.headers["cache-control"] == "no-store"


def test_validation_and_internal_errors_are_safely_normalized(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = TestClient(make_error_test_app())
    extra_field = client.post(
        "/api/v1/validate",
        json={"name": "valid", "count": 2, "unexpected": "reject me"},
    )
    assert extra_field.status_code == 422
    assert extra_field.json()["error"]["code"] == "validation_error"
    assert extra_field.json()["error"]["details"] == [
        {"field": "unexpected", "code": "invalid_value"}
    ]
    assert extra_field.headers.get("x-request-id")

    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="app.core.errors"):
        server_error = client.get(
            "/api/v1/crash",
            headers={"X-Request-ID": "f06-safe-request-id"},
        )
    assert server_error.status_code == 500
    assert server_error.json() == {
        "error": {
            "code": "internal_error",
            "message": "Внутренняя ошибка сервера",
            "details": [],
        }
    }
    assert SYNTHETIC_SECRET not in server_error.text
    assert SYNTHETIC_SECRET not in caplog.text
    assert "Traceback" not in caplog.text
    assert "RuntimeError" in caplog.text
    assert "f06-safe-request-id" in caplog.text
    assert server_error.headers["x-request-id"] == "f06-safe-request-id"
    assert server_error.headers["cache-control"] == "no-store"
    assert len([record for record in caplog.records if record.name == "app.core.errors"]) == 1


def test_validation_error_locations_preserve_field_names_and_array_indices() -> None:
    client = TestClient(make_error_test_app())
    body_response = client.post(
        "/api/v1/field-locations",
        json={"form_data": {"body": "invalid"}, "items": [{"header": "invalid"}]},
    )

    assert body_response.status_code == 422
    assert body_response.json()["error"]["code"] == "validation_error"
    assert [detail["field"] for detail in body_response.json()["error"]["details"]] == [
        "body",
        "form_data.body",
        "query",
        "items.0.header",
    ]

    query_response = client.get("/api/v1/query-location", params={"cursor": "not-an-int"})
    assert query_response.status_code == 422
    assert query_response.json()["error"]["code"] == "validation_error"
    assert query_response.json()["error"]["details"] == [
        {"field": "cursor", "code": "invalid_value"}
    ]


def test_stream_exception_after_response_start_aborts_without_final_body_or_secret_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sent_messages = []

    async def crashing_app(scope, _receive, send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"partial response", "more_body": True})
        raise RuntimeError(f"stream failed with token {SYNTHETIC_SECRET}")

    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message) -> None:
        sent_messages.append(dict(message))

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/v1/stream-crash",
        "headers": [(b"x-request-id", b"f09-safe-request-id")],
        "state": {},
    }

    with (
        caplog.at_level(logging.ERROR, logger="app.core.errors"),
        pytest.raises(ResponseStreamAborted) as raised,
    ):
        asyncio.run(ApiHeadersMiddleware(crashing_app)(scope, receive, send))

    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert SYNTHETIC_SECRET not in "".join(traceback.format_exception(raised.value))
    assert SYNTHETIC_SECRET not in caplog.text
    assert "Traceback" not in caplog.text
    assert "RuntimeError" in caplog.text
    assert "f09-safe-request-id" in caplog.text
    assert [message["type"] for message in sent_messages] == [
        "http.response.start",
        "http.response.body",
    ]
    assert sent_messages[-1]["more_body"] is True


def test_successful_stream_finishes_with_complete_body() -> None:
    response = TestClient(make_error_test_app()).get("/api/v1/stream-ok")

    assert response.status_code == 200
    assert response.content == b"first second"
    assert response.headers.get("x-request-id")
    assert response.headers["cache-control"] == "no-store"


def test_uvicorn_client_detects_stream_interruption_without_secret_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        host, port = listener.getsockname()

    server = uvicorn.Server(
        uvicorn.Config(
            make_error_test_app(),
            host=host,
            port=port,
            log_level="error",
            access_log=False,
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    with caplog.at_level(logging.ERROR):
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started and time.monotonic() < deadline:
                time.sleep(0.01)
            assert server.started, "Uvicorn did not start in time"

            with httpx.Client(timeout=5) as client:
                response = client.send(
                    client.build_request(
                        "GET",
                        f"http://{host}:{port}/api/v1/stream-crash",
                        headers={"X-Request-ID": "f09-uvicorn-request-id"},
                    ),
                    stream=True,
                )
                try:
                    assert response.status_code == 200
                    assert response.headers["x-request-id"] == "f09-uvicorn-request-id"
                    assert response.headers["cache-control"] == "no-store"
                    received_body = bytearray()
                    with pytest.raises(httpx.RemoteProtocolError):
                        for chunk in response.iter_bytes():
                            received_body.extend(chunk)
                    assert received_body == b"partial response"
                finally:
                    response.close()
        finally:
            server.should_exit = True
            thread.join(timeout=5)

    assert not thread.is_alive()
    assert SYNTHETIC_SECRET not in caplog.text


def test_api_prefix_and_existing_documentation_paths_remain_available() -> None:
    client = TestClient(app)
    docs = client.get("/api/docs")
    openapi = client.get("/api/openapi.json")
    assert docs.status_code == 200
    assert docs.headers.get("x-request-id")
    assert openapi.status_code == 200
    assert openapi.json()["components"]["schemas"]["ApiError"]
    assert "servers" not in openapi.json()
    assert openapi.json()["paths"] == {}
    assert client.get("/api/v1").status_code == 404
    assert client.get("/docs").status_code == 404


def test_openapi_uses_synthetic_route_prefix_once_in_effective_url() -> None:
    probe_app = FastAPI()

    @probe_app.get("/api/v1/probe")
    def probe() -> dict[str, bool]:
        return {"ok": True}

    schema = create_openapi_schema(probe_app)
    server_url = schema.get("servers", [{"url": "/"}])[0]["url"]
    effective_url = server_url.rstrip("/") + "/api/v1/probe"

    assert schema["paths"].keys() == {"/api/v1/probe"}
    assert effective_url == "/api/v1/probe"
