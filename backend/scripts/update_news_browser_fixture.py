"""Update one fictional news title inside the isolated browser E2E database."""

import argparse

from sqlalchemy import update
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import News


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--news-id", type=int, required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()

    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value())
    if (
        settings.app_env != "test"
        or url.database != "uni_space_test"
        or url.host not in {"localhost", "127.0.0.1"}
        or url.username != "uni_space_test"
        or url.password != "test-only-password"
    ):
        raise SystemExit("Refusing to update news outside uni_space_test")

    with SessionLocal.begin() as session:
        result = session.execute(
            update(News).where(News.id == args.news_id).values(title=args.title)
        )
        if result.rowcount != 1:
            raise SystemExit("Expected exactly one isolated news fixture to be updated")

    print(f"Updated isolated news fixture {args.news_id}")


if __name__ == "__main__":
    main()
