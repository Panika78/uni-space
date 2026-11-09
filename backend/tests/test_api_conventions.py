import base64
import json
from typing import Annotated
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from pydantic import Field, TypeAdapter, ValidationError

from app.core.errors import install_exception_handlers
from app.core.middleware import REQUEST_ID_PATTERN, ApiHeadersMiddleware
from app.core.pagination import InvalidCursorError, paginate
from app.core.schemas import DateTime, Id, Page, PaginationParams, RequestModel
from app.main import app


class RequestBody(RequestModel):
    name: str
    count: Annotated[int, Field(ge=1, le=5)]


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

    @test_app.get("/api/v1/crash")
    def crash() -> None:
        raise RuntimeError("private database password")

    @test_app.get("/api/v1/limited")
    def limited() -> None:
        raise HTTPException(status_code=429, detail="rate_limited", headers={"Retry-After": "30"})

    @test_app.post("/api/v1/validate")
    def validate(body: RequestBody) -> RequestBody:
        return body

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

    limited = client.get("/api/v1/limited")
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "30"
    assert limited.json()["error"]["code"] == "rate_limited"


def test_validation_and_internal_errors_are_safely_normalized() -> None:
    client = TestClient(make_error_test_app(), raise_server_exceptions=False)
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

    server_error = client.get("/api/v1/crash")
    assert server_error.status_code == 500
    assert server_error.json() == {
        "error": {
            "code": "internal_error",
            "message": "Внутренняя ошибка сервера",
            "details": [],
        }
    }
    assert "password" not in server_error.text
    assert server_error.headers.get("x-request-id")
    assert server_error.headers["cache-control"] == "no-store"


def test_api_prefix_and_existing_documentation_paths_remain_available() -> None:
    client = TestClient(app)
    docs = client.get("/api/docs")
    openapi = client.get("/api/openapi.json")
    assert docs.status_code == 200
    assert docs.headers.get("x-request-id")
    assert openapi.status_code == 200
    assert openapi.json()["components"]["schemas"]["ApiError"]
    assert openapi.json()["servers"] == [{"url": "/api/v1"}]
    assert openapi.json()["paths"] == {}
    assert client.get("/api/v1").status_code == 404
    assert client.get("/docs").status_code == 404
