import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "mode,cookie_secure,weak_key,proxy_enabled,proxies,expected_success",
    [
        (None, False, True, False, [], True),
        ("production", True, False, False, [], True),
        ("production", False, False, False, [], False),
        ("production", True, True, False, [], False),
        ("production", True, False, True, ["127.0.0.1"], True),
        ("production", True, False, True, [], False),
        ("production", True, False, True, ["*"], False),
        ("production", True, False, False, ["127.0.0.1"], False),
    ],
)
def test_compose_effective_environment_controls_application_startup(
    mode, cookie_secure, weak_key, proxy_enabled, proxies, expected_success
):
    environment = os.environ.copy()
    environment.pop("APP_ENV", None)
    if mode is not None:
        environment["APP_ENV"] = mode
    key = "abcdefghijklmnopabcdefghijklmnop" if weak_key else secrets.token_urlsafe(48)
    environment.update(
        JWT_SIGNING_KEY=key,
        COOKIE_SECURE=str(cookie_secure).lower(),
        ALLOWED_ORIGINS='["https://uni.example"]',
        PROXY_HEADERS_ENABLED=str(proxy_enabled).lower(),
        TRUSTED_PROXY_IPS=json.dumps(proxies),
    )
    rendered = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(ROOT / ".env.example"),
            "config",
            "--format",
            "json",
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    )
    api = json.loads(rendered.stdout)["services"]["api"]
    assert api["environment"]["APP_ENV"] == (mode or "development")
    assert api["environment"]["PROXY_HEADERS_ENABLED"] == str(proxy_enabled).lower()
    assert json.loads(api["environment"]["TRUSTED_PROXY_IPS"]) == proxies
    assert api["ports"][0]["host_ip"] == "127.0.0.1"
    assert api["ports"][0]["target"] == 8000

    # Use exactly the resolved API environment and the real container entrypoint.
    # A fresh interpreter imports the application, including startup validation.
    process_environment = {
        name: value
        for name, value in environment.items()
        if name
        not in {
            "DATABASE_URL",
            "APP_ENV",
            "JWT_SIGNING_KEY",
            "COOKIE_SECURE",
            "ALLOWED_ORIGINS",
            "JWT_ISSUER",
            "JWT_AUDIENCE",
            "ACCESS_TTL_SECONDS",
            "SESSION_TTL_SECONDS",
        }
    }
    process_environment.update(api["environment"])
    process_environment["PATH"] = (
        str(Path(sys.executable).parent) + os.pathsep + environment["PATH"]
    )
    result = subprocess.run(
        [
            "sh",
            str(ROOT / "backend/docker-entrypoint.sh"),
            sys.executable,
            "-c",
            "from app.main import settings; print(settings.app_env)",
        ],
        cwd=ROOT / "backend",
        env=process_environment,
        capture_output=True,
        text=True,
    )
    if expected_success:
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == (mode or "development")
    else:
        assert result.returncode != 0
        assert "Invalid or missing environment settings" in result.stderr
        assert key not in result.stderr
        assert "local-development-password" not in result.stderr
