from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator
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
            parsed = urlsplit(value)
            try:
                port = parsed.port
            except ValueError:
                raise ValueError("invalid origin port") from None
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.path
                or parsed.query
                or parsed.fragment
                or "*" in value
                or value != value.strip()
                or (port is not None and not 1 <= port <= 65535)
            ):
                raise ValueError("must be an exact HTTP(S) origin without path")
        return values

    @model_validator(mode="after")
    def validate_production_auth(self) -> "Settings":
        if self.app_env == "production":
            key = self.jwt_signing_key.get_secret_value().lower()
            if (
                not self.cookie_secure
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
