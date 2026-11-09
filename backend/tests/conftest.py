import os
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from alembic import command
from alembic.config import Config

os.environ.setdefault("JWT_SIGNING_KEY", "test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ")


@pytest.fixture(scope="session")
def postgresql_engine():
    from app.core.config import load_settings

    settings = load_settings()
    if settings.app_env != "test":
        pytest.fail("PostgreSQL integration tests require APP_ENV=test")

    engine = create_engine(settings.database_url.get_secret_value())
    with engine.connect() as connection:
        database, user = connection.execute(text("SELECT current_database(), current_user")).one()
    if (database, user) != ("uni_space_test", "uni_space_test"):
        engine.dispose()
        pytest.fail("PostgreSQL integration tests require the isolated uni_space_test database")

    backend_directory = Path(__file__).resolve().parents[1]
    alembic_config = Config(str(backend_directory / "alembic.ini"))
    command.upgrade(alembic_config, "head")

    yield engine

    engine.dispose()


@pytest.fixture
def db_session(postgresql_engine):
    connection = postgresql_engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
