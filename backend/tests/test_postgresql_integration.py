import pytest
from sqlalchemy import create_engine, text

from app.core.config import get_settings


@pytest.mark.integration
def test_database_connection_uses_test_postgresql() -> None:
    database_url = get_settings().database_url.get_secret_value()
    engine = create_engine(database_url)

    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT 1")).scalar_one() == 1
            assert (
                connection.execute(text("SELECT current_database()")).scalar_one()
                == "uni_space_test"
            )
    finally:
        engine.dispose()
