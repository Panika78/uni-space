import re
from functools import lru_cache
from ipaddress import IPv4Address, IPv6Address, collapse_addresses, ip_network
from typing import Literal

from pydantic import (
    Field,
    SecretStr,
    ValidationError,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError


def create_database_url(
    *,
    username: str,
    password: str,
    host: str,
    port: int,
    database: str,
) -> str:
    return URL.create(
        "postgresql+psycopg",
        username=username,
        password=password,
        host=host,
        port=port,
        database=database,
    ).render_as_string(hide_password=False)


class Settings(BaseSettings):
    app_env: Literal["development", "test", "production"] = "development"
    database_url: SecretStr
    jwt_signing_key: SecretStr
    jwt_issuer: str = Field(default="uni-space", min_length=1)
    jwt_audience: str = Field(default="uni-space-api", min_length=1)
    access_ttl_seconds: int = Field(default=600, ge=1, le=3600)
    session_ttl_seconds: int = Field(default=604800, ge=1, le=2592000)
    cookie_secure: bool = True
    allowed_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    proxy_headers_enabled: bool = False
    trusted_proxy_ips: list[str] = Field(default_factory=list)

    @field_validator("trusted_proxy_ips")
    @classmethod
    def validate_trusted_proxies(cls, values: list[str], info: ValidationInfo) -> list[str]:
        if bool(values) != info.data.get("proxy_headers_enabled", False):
            raise ValueError(
                "proxy headers require an explicitly enabled, nonempty trusted IP list"
            )
        networks = []
        for value in values:
            # Uvicorn also accepts arbitrary literals and '*'; this application
            # deliberately permits only exact IP addresses or canonical CIDRs.
            try:
                network = ip_network(value)
            except ValueError:
                raise ValueError(
                    "trusted proxies must be IP addresses or canonical CIDRs"
                ) from None
            if value != value.strip() or network.prefixlen == 0:
                raise ValueError("trusting all addresses or whitespace is forbidden")
            networks.append(network)
        for version in (4, 6):
            if any(
                network.prefixlen == 0
                for network in collapse_addresses(
                    network for network in networks if network.version == version
                )
            ):
                raise ValueError("trusted networks must not cover every address")
        return values

    @field_validator("jwt_signing_key")
    @classmethod
    def validate_signing_key(cls, value: SecretStr) -> SecretStr:
        key = value.get_secret_value()
        if len(key.encode()) < 32 or len(set(key)) < 16:
            raise ValueError("must contain at least 32 bytes with sufficient diversity")
        return value

    @field_validator("jwt_issuer", "jwt_audience")
    @classmethod
    def validate_jwt_identifier(cls, value: str) -> str:
        if value != value.strip() or not value:
            raise ValueError("must be a nonblank identifier")
        return value

    @field_validator("allowed_origins")
    @classmethod
    def validate_origins(cls, values: list[str]) -> list[str]:
        if not values:
            raise ValueError("must include an explicit origin")
        for value in values:
            match = re.fullmatch(
                r"https?://(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?", value
            )
            if match is None:
                raise ValueError("must be a serialized HTTP(S) origin without path or delimiters")
            host, port = match.groups()
            if port is not None and not 1 <= int(port) <= 65535:
                raise ValueError("invalid origin port")
            if host.startswith("["):
                IPv6Address(host[1:-1])
            elif all(character in "0123456789." for character in host):
                IPv4Address(host)
            elif (
                len(host) > 253
                or re.fullmatch(
                    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
                    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?",
                    host,
                )
                is None
            ):
                raise ValueError("invalid origin host")
        return values

    @model_validator(mode="after")
    def validate_production_auth(self) -> "Settings":
        if self.app_env == "production":
            private_ranges = [
                ip_network(value)
                for value in (
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "127.0.0.0/8",
                    "fc00::/7",
                    "::1/128",
                )
            ]
            for value in self.trusted_proxy_ips:
                network = ip_network(value)
                if not any(
                    network.version == private.version and network.subnet_of(private)
                    for private in private_ranges
                ):
                    raise ValueError("production proxy trust must use private or loopback networks")
            key = self.jwt_signing_key.get_secret_value().lower()
            if (
                not self.cookie_secure
                # Reject complete repetitions of any shorter block (including
                # mixed-case variants). This is a pattern check, not entropy estimation.
                or key in (key + key)[1:-1]
                or any(
                    word in key
                    for word in (
                        "test",
                        "example",
                        "development",
                        "placeholder",
                        "changeme",
                        "secret",
                        "password",
                        "qwerty",
                        "0123456789",
                        "abcdefghijklmnopqrstuvwxyz",
                        "abcdefghijklmnop",
                        "9876543210",
                        "zyxwvutsrqponmlkjihgfedcba",
                        "demo",
                        "sample",
                    )
                )
                or any(not origin.startswith("https://") for origin in self.allowed_origins)
            ):
                raise ValueError(
                    "production requires a private random key, Secure and HTTPS origins"
                )
        return self

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr) -> SecretStr:
        try:
            parsed_url = make_url(value.get_secret_value())
            port = parsed_url.port
        except (ArgumentError, TypeError, ValueError) as error:
            raise ValueError("must be a valid PostgreSQL connection URL") from error

        if parsed_url.drivername != "postgresql+psycopg":
            raise ValueError("must use the postgresql+psycopg driver")
        if not parsed_url.username or not parsed_url.password:
            raise ValueError("must include a username and password")
        if not parsed_url.host or not parsed_url.database:
            raise ValueError("must include a host and database")
        if any(character in parsed_url.host for character in "@/\\"):
            raise ValueError("must include a valid host")
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("must use a valid port")
        return value

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


def load_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as error:
        invalid_fields = sorted(
            ".".join(str(part) for part in item["loc"]) for item in error.errors()
        )
        field_list = ", ".join(invalid_fields) or "unknown"
        raise RuntimeError(f"Invalid or missing environment settings: {field_list}") from None


@lru_cache
def get_settings() -> Settings:
    return load_settings()
