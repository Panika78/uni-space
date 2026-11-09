from sqlalchemy import create_engine

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from app.core.config import get_settings


def main() -> None:
    script = ScriptDirectory.from_config(Config("alembic.ini"))
    expected_heads = set(script.get_heads())
    engine = create_engine(get_settings().database_url.get_secret_value())

    with engine.connect() as connection:
        actual_heads = set(MigrationContext.configure(connection).get_current_heads())

    if actual_heads != expected_heads:
        raise SystemExit(
            "Database Alembic revisions do not match migration heads: "
            f"database={sorted(actual_heads)}, migrations={sorted(expected_heads)}"
        )

    if expected_heads:
        print(f"Database is at all Alembic heads: {', '.join(sorted(expected_heads))}")
    else:
        print("No Alembic revisions exist; database matches the empty migration graph")


if __name__ == "__main__":
    main()
