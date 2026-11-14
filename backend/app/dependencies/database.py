from collections.abc import Generator

from sqlalchemy.orm import Session

from app.core.database import SessionLocal


def get_db_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    except BaseException:
        # PostgreSQL marks a transaction failed after statement/lock timeouts.
        # Roll it back before the connection is returned to the pool.
        session.rollback()
        raise
    finally:
        session.close()
