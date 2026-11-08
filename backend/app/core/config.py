from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: Literal["development", "test", "production"] = "development"
    database_url: SecretStr

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr) -> SecretStr:
        database_url = value.get_secret_value()
        if not database_url.startswith("postgresql+psycopg://"):
            raise ValueError("must use the postgresql+psycopg driver")
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
