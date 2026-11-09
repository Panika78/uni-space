import json
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.core.server import create_server_arguments

BACKEND = Path(__file__).resolve().parents[1]
ORIGIN = "http://localhost:5173"


def create_settings(**options):
    return Settings(
        _env_file=None,
        database_url="postgresql+psycopg://unused:unused@localhost/unused",
        jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        **options,
    )


@pytest.mark.parametrize(
    "enabled,proxies",
    [
        (True, []),
        (False, ["127.0.0.1"]),
        (True, ["*"]),
        (True, ["0.0.0.0/1", "128.0.0.0/1"]),
        (True, ["::/1", "8000::/1"]),
        (True, ["0.0.0.0/0"]),
        (True, ["::/0"]),
        (True, ["proxy.example"]),
        (True, ["127.0.0.1/8"]),
        (True, ["192.0.2.0/33"]),
        (True, ["192.0.2.300"]),
        (True, ["127.0.0.1", "*"]),
        (True, [""]),
        (True, [" 127.0.0.1"]),
    ],
)
def test_proxy_configuration_rejects_incomplete_or_unsafe_trust(enabled, proxies):
    with pytest.raises(ValidationError):
        create_settings(proxy_headers_enabled=enabled, trusted_proxy_ips=proxies)


@pytest.mark.parametrize(
    "proxies",
    [
        ["127.0.0.1"],
        ["127.0.0.0/8"],
        ["::1"],
        ["2001:db8::/32"],
        ["192.0.2.1", "2001:db8::/32"],
    ],
)
def test_server_passes_explicit_trusted_ips_and_networks_to_uvicorn(proxies):
    settings = create_settings(proxy_headers_enabled=True, trusted_proxy_ips=proxies)
    arguments = create_server_arguments(settings, host="127.0.0.1", port=8000)
    assert "--proxy-headers" in arguments
    assert arguments[arguments.index("--forwarded-allow-ips") + 1] == ",".join(proxies)
    assert "--no-proxy-headers" not in arguments


def test_server_disables_proxy_headers_by_default_even_in_production():
    # Production validation is independent of whether proxy headers are enabled.
    settings = Settings(
        _env_file=None,
        app_env="production",
        database_url="postgresql+psycopg://unused:unused@localhost/unused",
        jwt_signing_key="2ghJj3eYC65ZV4zuLr8s-91QTNpXvWbA",
        allowed_origins=["https://uni.example"],
    )
    arguments = create_server_arguments(settings, host="127.0.0.1", port=8000)
    assert "--no-proxy-headers" in arguments
    assert "--proxy-headers" not in arguments
    assert "--forwarded-allow-ips" not in arguments


def server_environment(options):
    environment = os.environ.copy()
    environment.update(
        APP_ENV="test",
        DATABASE_URL="postgresql+psycopg://unused:unused@localhost/unused",
        JWT_SIGNING_KEY="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        ALLOWED_ORIGINS=json.dumps([ORIGIN]),
        PROXY_HEADERS_ENABLED="false",
        TRUSTED_PROXY_IPS="[]",
        # These Uvicorn environment defaults must never bypass the launcher policy.
        FORWARDED_ALLOW_IPS="*",
        UVICORN_PROXY_HEADERS="true",
    )
    environment.update(options)
    environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment["PATH"]
    return environment


@contextmanager
def run_api_server(tmp_path, **environment):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with (tmp_path / "uvicorn.log").open("w+") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.core.server", "--port", str(port)],
            cwd=BACKEND,
            env=server_environment(environment),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            with httpx.Client(
                base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False
            ) as client:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(f"Uvicorn failed to start: {log.read()}")
                    try:
                        if client.get("/api/openapi.json").status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(0.02)
                else:
                    pytest.fail("Uvicorn did not start")
                yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def attempt_login(client, forwarded_ip):
    return client.post(
        "/api/v1/auth/login", json={}, headers={"Origin": ORIGIN, "X-Forwarded-For": forwarded_ip}
    )


def assert_limited(response):
    assert response.status_code == 429, response.text
    assert response.json()["error"]["code"] == "rate_limited"
    assert 1 <= int(response.headers["Retry-After"]) <= 60
    assert response.headers["x-request-id"]
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"PROXY_HEADERS_ENABLED": "true", "TRUSTED_PROXY_IPS": '["192.0.2.0/24"]'},
    ],
)
def test_real_uvicorn_ignores_forwarded_headers_when_disabled_or_peer_untrusted(tmp_path, options):
    with run_api_server(tmp_path, **options) as client:
        for index in range(5):
            assert attempt_login(client, f"192.0.2.{index + 1}").status_code == 422
        assert_limited(attempt_login(client, "198.51.100.1"))
        assert "192.0.2.1:0" not in (tmp_path / "uvicorn.log").read_text()


@pytest.mark.parametrize(
    "trust,first,second",
    [
        (["127.0.0.1"], "192.0.2.1", "192.0.2.2"),
        (["127.0.0.0/8"], "192.0.2.1", "192.0.2.2"),
        (["127.0.0.1"], "2001:db8::1", "2001:db8::2"),
    ],
)
def test_real_uvicorn_trusted_peer_provides_independent_client_limits(
    tmp_path, trust, first, second
):
    with run_api_server(
        tmp_path, PROXY_HEADERS_ENABLED="true", TRUSTED_PROXY_IPS=json.dumps(trust)
    ) as client:
        for _ in range(5):
            assert attempt_login(client, first).status_code == 422
        assert_limited(attempt_login(client, first))
        for _ in range(5):
            assert attempt_login(client, second).status_code == 422
        assert_limited(attempt_login(client, second))
        access_log = (tmp_path / "uvicorn.log").read_text()
        assert f"{first}:0" in access_log
        assert f"{second}:0" in access_log


def test_real_uvicorn_uses_nearest_untrusted_client_in_proxy_chain(tmp_path):
    with run_api_server(
        tmp_path, PROXY_HEADERS_ENABLED="true", TRUSTED_PROXY_IPS='["127.0.0.0/8"]'
    ) as client:
        for index in range(5):
            chain = f"198.51.100.{index + 1}, 192.0.2.1, 127.0.0.2"
            assert attempt_login(client, chain).status_code == 422
        assert_limited(attempt_login(client, "198.51.100.99, 192.0.2.1, 127.0.0.2"))
        assert attempt_login(client, "198.51.100.99, 192.0.2.2, 127.0.0.2").status_code == 422


@pytest.mark.parametrize("proxies", [[], ["*"], ["0.0.0.0/0"], ["not-an-ip"]])
def test_launcher_refuses_unsafe_proxy_configuration_before_starting_uvicorn(proxies):
    result = subprocess.run(
        [sys.executable, "-m", "app.core.server"],
        cwd=BACKEND,
        env=server_environment(
            {"PROXY_HEADERS_ENABLED": "true", "TRUSTED_PROXY_IPS": json.dumps(proxies)}
        ),
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert "trusted_proxy_ips" in result.stderr
    assert "Uvicorn running" not in result.stderr
    assert "test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ" not in result.stderr
