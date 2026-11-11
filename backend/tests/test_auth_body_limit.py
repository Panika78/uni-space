import asyncio
import json

import httpx
import pytest

from app.auth.body_limit import AUTH_BODY_LIMIT
from app.main import app

AUTH_PATH = "/api/v1/auth/"
HEADERS = {"Origin": "http://localhost:5173", "X-Request-ID": "body-limit-regression"}


@pytest.fixture(autouse=True)
def reset_login_limiter(monkeypatch):
    from app.auth import router as auth_routes
    from app.auth.rate_limit import LoginRateLimiter

    monkeypatch.setattr(auth_routes, "login_rate_limiter", LoginRateLimiter())


def send_request(path, content=b"", headers=None):
    async def send():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost:5173"
        ) as client:
            return await client.post(
                AUTH_PATH + path, content=content, headers=HEADERS | (headers or {})
            )

    return asyncio.run(send())


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    assert response.json()["error"]["details"] == [] or status == 422
    assert response.headers["x-request-id"] == "body-limit-regression"
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("path", ["login", "refresh", "logout"])
@pytest.mark.parametrize("size", [AUTH_BODY_LIMIT + 1, AUTH_BODY_LIMIT * 10])
def test_auth_rejects_oversized_body_before_fastapi_parsing(path, size):
    response = send_request(path, b"x" * size)
    assert_error(response, 413, "request_too_large")


@pytest.mark.parametrize("path", ["refresh", "logout"])
@pytest.mark.parametrize("content", [b"{}", b" ", b"x" * AUTH_BODY_LIMIT])
def test_refresh_and_logout_reject_small_nonempty_body(path, content):
    assert_error(send_request(path, content), 422, "validation_error")


def test_auth_empty_body_preserves_existing_behavior():
    assert_error(send_request("login"), 422, "validation_error")
    assert_error(send_request("refresh"), 401, "invalid_refresh")
    response = send_request("logout")
    assert response.status_code == 200 and response.json() == {"session_revoked": False}
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"] == "body-limit-regression"


@pytest.mark.parametrize("path", ["login", "refresh", "logout"])
@pytest.mark.parametrize("headers", [{}, {"Content-Length": "1"}])
def test_streaming_auth_body_is_bounded_and_rejected_early(path, headers):
    consumed = []

    async def stream():
        for index in range(100):
            consumed.append(index)
            yield b"x" * 1024

    response = send_request(path, stream(), headers)
    if not headers:
        assert "content-length" not in response.request.headers
        assert response.request.headers["transfer-encoding"] == "chunked"
    assert_error(response, 413, "request_too_large")
    assert consumed == list(range(17)), "the server must not drain or buffer the rest of the stream"


def test_login_rejects_oversized_valid_json_before_validation(monkeypatch):
    from starlette.requests import Request

    async def reject_json_parsing(_request):
        pytest.fail("oversized login must be rejected before JSON parsing")

    monkeypatch.setattr(Request, "json", reject_json_parsing)
    body = json.dumps({"login": "fictional", "password": "x" * AUTH_BODY_LIMIT}).encode()
    assert_error(
        send_request("login", body, {"Content-Type": "application/json"}), 413, "request_too_large"
    )


@pytest.mark.parametrize("character", ["\x01", "\U0001f600"])
def test_login_accepts_maximum_escaped_strings_for_field_validation(character):
    # Worst-case JSON escaping of the maximum allowed character counts fits 16 KiB.
    body = json.dumps(
        {"login": character * 256, "password": character * 1024, "extra": "invalid"}
    ).encode()
    assert len(body) <= AUTH_BODY_LIMIT
    assert_error(
        send_request("login", body, {"Content-Type": "application/json"}), 422, "validation_error"
    )


def test_auth_openapi_documents_shared_413_error():
    schema = app.openapi()
    for path in ["login", "refresh", "logout"]:
        response = schema["paths"][AUTH_PATH + path]["post"]["responses"]["413"]
        assert response["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ApiError"
        }
