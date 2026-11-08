import pytest

from app.core.config import load_settings


def test_load_settings_reports_missing_database_url_without_values(monkeypatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(
        RuntimeError,
        match=r"^Invalid or missing environment settings: database_url$",
    ) as error:
        load_settings()

    assert "postgresql" not in str(error.value)


def test_load_settings_reports_invalid_database_url_without_secret(monkeypatch) -> None:
    secret_value = "do-not-log-this-value"
    monkeypatch.setenv("DATABASE_URL", f"mysql://user:{secret_value}@localhost/database")

    with pytest.raises(
        RuntimeError,
        match=r"^Invalid or missing environment settings: database_url$",
    ) as error:
        load_settings()

    assert secret_value not in str(error.value)
