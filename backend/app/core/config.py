from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, ValidationError, field_validator
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
