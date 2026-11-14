"""Regression tests for the published news E2E diagnostic logs."""

import importlib.util
import json
from pathlib import Path

import pytest

SANITIZER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "sanitize-news-browser-logs.py"
SPEC = importlib.util.spec_from_file_location("news_browser_log_sanitizer", SANITIZER_PATH)
assert SPEC is not None and SPEC.loader is not None
SANITIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SANITIZER)


@pytest.mark.parametrize(
    ("source", "markers"),
    [
        (
            '{"authorization":"Bearer sentinel-json",'
            '"headers":{"Authorization":"Bearer sentinel-nested"},'
            '"password":"sentinel-password",'
            '"refresh_token":"sentinel-refresh"}',
            (
                "sentinel-json",
                "sentinel-nested",
                "sentinel-password",
                "sentinel-refresh",
            ),
        ),
        (
            "Authorization: Bearer sentinel-auth\n"
            "Proxy-Authorization: Basic sentinel-proxy\n"
            "Cookie: session=sentinel-cookie\n"
            "Set-Cookie: refresh=sentinel-session; HttpOnly\n"
            "X-API-Key: sentinel-api-key\n"
            'Authorization: Digest username="sentinel-digest" realm=private\n'
            "ERROR: retained diagnostic",
            (
                "sentinel-auth",
                "sentinel-proxy",
                "sentinel-cookie",
                "sentinel-session",
                "sentinel-api-key",
                "sentinel-digest",
            ),
        ),
        (
            "Authorization=Bearer sentinel-equal\n"
            "access_token=sentinel-access\n"
            "refresh_token=sentinel-refresh\n"
            "password=sentinel-password",
            (
                "sentinel-equal",
                "sentinel-access",
                "sentinel-refresh",
                "sentinel-password",
            ),
        ),
        (
            "AUTHORIZATION: Bearer sentinel-upper\n"
            "authorization: Bearer sentinel-lower\n"
            "Access_Token=sentinel-mixed",
            ("sentinel-upper", "sentinel-lower", "sentinel-mixed"),
        ),
        (
            '{"headers":{"x-api-key":"sentinel-nested-api",'
            '"X-Refresh-Token":"sentinel-nested-refresh"}}',
            ("sentinel-nested-api", "sentinel-nested-refresh"),
        ),
        (
            'INFO startup\n{"headers":{"Authorization":"Bearer sentinel-json-in-log"}}\n',
            ("sentinel-json-in-log",),
        ),
    ],
)
def test_sanitize_redacts_sensitive_json_and_text(source: str, markers: tuple[str, ...]) -> None:
    result = SANITIZER.sanitize(source)

    for marker in markers:
        assert marker not in result
    assert "[REDACTED]" in result


def test_sanitize_preserves_safe_diagnostics_and_is_idempotent() -> None:
    source = (
        "ERROR: API process failed on port 8000\n"
        "Traceback: news API readiness check failed\n"
        "Authorization: Bearer sentinel-idempotent\n"
        "Scenario: open fixture article"
    )

    result = SANITIZER.sanitize(source)

    assert "ERROR: API process failed on port 8000" in result
    assert "Traceback: news API readiness check failed" in result
    assert "Scenario: open fixture article" in result
    assert "sentinel-idempotent" not in result
    assert SANITIZER.sanitize(result) == result


def test_sanitize_redacts_existing_secret_field_names() -> None:
    source = (
        "passwd=sentinel-passwd passphrase=sentinel-passphrase "
        "token=sentinel-token access_token=sentinel-access "
        "refresh_token=sentinel-refresh id_token=sentinel-id secret=sentinel-secret "
        "client_secret=sentinel-client api_key=sentinel-api apikey=sentinel-apikey"
    )

    result = SANITIZER.sanitize(source)

    for marker in (
        "sentinel-passwd",
        "sentinel-passphrase",
        "sentinel-token",
        "sentinel-access",
        "sentinel-refresh",
        "sentinel-id",
        "sentinel-secret",
        "sentinel-client",
        "sentinel-api",
        "sentinel-apikey",
    ):
        assert marker not in result


def test_sanitize_keeps_json_valid_and_redacts_nested_values() -> None:
    source = json.dumps({"headers": {"Authorization": "Bearer sentinel-json-valid"}, "port": 8000})

    result = json.loads(SANITIZER.sanitize(source))

    assert result["headers"]["Authorization"] == "[REDACTED]"
    assert result["port"] == 8000


def test_sanitize_redacts_sensitive_values_inside_json_strings() -> None:
    source = json.dumps(
        {
            "message": "Authorization: Bearer sentinel-auth",
            "error": "password=sentinel-password",
            "details": ["Request failed", "Cookie: session=sentinel-cookie"],
            "nested": {"message": "X-API-Key: sentinel-api"},
            "combined": "Authorization: Bearer sentinel-a; password=sentinel-b",
            "normal": "API process failed on port 8000",
        }
    )

    result = json.loads(SANITIZER.sanitize(source))

    for marker in (
        "sentinel-auth",
        "sentinel-password",
        "sentinel-cookie",
        "sentinel-api",
        "sentinel-a",
        "sentinel-b",
    ):
        assert marker not in json.dumps(result)
    assert result["details"][0] == "Request failed"
    assert result["normal"] == "API process failed on port 8000"
    assert isinstance(result["details"], list)
    assert isinstance(result["nested"], dict)
    assert json.loads(SANITIZER.sanitize(json.dumps(result))) == result
