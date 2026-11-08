import pytest
from sqlalchemy.engine import make_url

from app.core.config import create_database_url, load_settings


@pytest.mark.parametrize(
    "database_url",
    [
        "",
        "mysql://user:pass@localhost/database",
        "postgresql+psycopg://user:pass@localhost:not-a-port/database",
        "postgresql+psycopg://user:pass@localhost:0/database",
        "postgresql+psycopg://user:pass@localhost:65536/database",
        "postgresql+psycopg://user:pass@/database",
        "postgresql+psycopg://user:pass@localhost/",
        "postgresql+psycopg://user@localhost/database",
        "postgresql+psycopg://user:safe@pass@db:5432/database",
    ],
)
def test_load_settings_rejects_invalid_database_urls(monkeypatch, database_url: str) -> None:
    monkeypatch.setenv("DATABASE_URL", database_url)

    with pytest.raises(
        RuntimeError,
        match=r"^Invalid or missing environment settings: database_url$",
    ):
        load_settings()


def test_load_settings_accepts_valid_database_url(monkeypatch) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://user:pass@localhost:5432/database",
    )

    assert load_settings().database_url.get_secret_value() == (
        "postgresql+psycopg://user:pass@localhost:5432/database"
    )


@pytest.mark.parametrize("password", ["safe@pass", "safe:pass", "safe/pass", "safe%pass"])
def test_create_database_url_round_trips_special_password(password: str) -> None:
    database_url = create_database_url(
        username="uni_space",
        password=password,
        host="db",
        port=5432,
        database="uni_space",
    )

    parsed_url = make_url(database_url)
    assert parsed_url.host == "db"
    assert parsed_url.password == password


def test_load_settings_diagnostic_does_not_include_database_url(monkeypatch) -> None:
    source_url = "postgresql+psycopg://user:secret@localhost:not-a-port/database"
    monkeypatch.setenv("DATABASE_URL", source_url)

    with pytest.raises(RuntimeError) as error:
        load_settings()

    assert "secret" not in str(error.value)
    assert source_url not in str(error.value)


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
