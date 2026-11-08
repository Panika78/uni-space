from typing import Annotated

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
    def page(params: Annotated[PaginationParams, Query()]) -> dict[str, int]:
        return {"limit": params.limit}

    return test_app


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


def test_cursor_pagination_keeps_equal_sort_values_without_gaps_or_duplicates() -> None:
    rows = [{"published_at": "2026-11-01", "id": str(index)} for index in range(7, 0, -1)]
    first_page = paginate(rows, key=lambda row: (row["published_at"], -int(row["id"])), limit=3)
    second_page = paginate(
        rows,
        key=lambda row: (row["published_at"], -int(row["id"])),
        limit=3,
        cursor=first_page.next_cursor,
    )
    final_page = paginate(
        rows,
        key=lambda row: (row["published_at"], -int(row["id"])),
        limit=3,
        cursor=second_page.next_cursor,
    )

    assert [row["id"] for row in first_page.items + second_page.items + final_page.items] == [
        str(index) for index in range(7, 0, -1)
    ]
    assert len({row["id"] for row in first_page.items + second_page.items + final_page.items}) == 7
    assert final_page.next_cursor is None


def test_pagination_rejects_invalid_runtime_arguments() -> None:
    with pytest.raises(InvalidCursorError):
        paginate([], key=lambda row: (row,), cursor="invalid")
    with pytest.raises(ValueError):
        paginate([], key=lambda row: (row,), limit=0)


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
