import json
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings

ROOT = Path(__file__).resolve().parents[2]


def create_production_settings(**options):
    return Settings(
        _env_file=None,
        app_env="production",
        database_url="postgresql+psycopg://unused:unused@localhost/unused",
        jwt_signing_key="2ghJj3eYC65ZV4zuLr8s-91QTNpXvWbA",
        **options,
    )


@pytest.mark.parametrize(
    "origin", ["https://uni.test", "https://uni.test:8443", "https://[fd00::1]:8443"]
)
def test_production_accepts_one_canonical_origin(origin):
    settings = create_production_settings(public_origin=origin, allowed_origins=[origin])
    assert settings.allowed_origins == [origin]


@pytest.mark.parametrize(
    "origin,allowed",
    [
        ("https://uni.test", ["https://other.test"]),
        ("https://uni.test:8443", ["https://uni.test"]),
        ("https://uni.test", ["https://uni.test", "https://other.test"]),
        ("http://uni.test", ["http://uni.test"]),
        ("https://uni.test:443", ["https://uni.test:443"]),
        ("https://UNI.test", ["https://UNI.test"]),
        ("https://uni.test:08443", ["https://uni.test:08443"]),
        ("https://uni.test:0", ["https://uni.test:0"]),
        ("https://uni.test:65536", ["https://uni.test:65536"]),
        ("https://uni.test/path", ["https://uni.test/path"]),
    ],
)
def test_production_rejects_inconsistent_or_noncanonical_origin(origin, allowed):
    with pytest.raises(ValidationError):
        create_production_settings(public_origin=origin, allowed_origins=allowed)


@pytest.mark.parametrize(
    "proxy", ["172.30.19.2", "172.30.19.2/32", "127.0.0.1", "fd00::2", "fd00::2/128", "::1"]
)
def test_production_trusts_individual_private_proxy_addresses(proxy):
    create_production_settings(
        allowed_origins=["https://uni.test"], proxy_headers_enabled=True, trusted_proxy_ips=[proxy]
    )


@pytest.mark.parametrize(
    "proxy",
    [
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "172.30.19.0/24",
        "172.30.19.2/31",
        "127.0.0.0/8",
        "fc00::/7",
        "fd00::/64",
        "fd00::2/127",
    ],
)
def test_production_rejects_proxy_networks_containing_multiple_peers(proxy):
    with pytest.raises(ValidationError):
        create_production_settings(
            allowed_origins=["https://uni.test"],
            proxy_headers_enabled=True,
            trusted_proxy_ips=[proxy],
        )


def test_compose_derives_api_and_nginx_from_one_public_origin(tmp_path):
    import os

    env = os.environ.copy()
    env.update(
        PUBLIC_ORIGIN="https://uni.test:8443",
        RELEASE_TAG="fixture",
        POSTGRES_DB="fixture",
        POSTGRES_USER="fixture",
        JWT_SIGNING_KEY_FILE=str(tmp_path / "jwt"),
        POSTGRES_PASSWORD_FILE=str(tmp_path / "password"),
        TLS_CERT_FILE=str(tmp_path / "cert"),
        TLS_KEY_FILE=str(tmp_path / "key"),
        # Legacy caller variables must not reintroduce a mismatch in the effective config.
        SERVER_NAME="other.test",
        ALLOWED_ORIGINS='["https://other.test"]',
    )
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            str(ROOT / "compose.prod.yaml"),
            "config",
            "--format",
            "json",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    config = json.loads(result.stdout)["services"]
    assert config["api"]["environment"]["PUBLIC_ORIGIN"] == "https://uni.test:8443"
    assert json.loads(config["api"]["environment"]["ALLOWED_ORIGINS"]) == ["https://uni.test:8443"]
    assert config["nginx"]["environment"]["PUBLIC_ORIGIN"] == "https://uni.test:8443"
    assert "SERVER_NAME" not in config["nginx"]["environment"]
