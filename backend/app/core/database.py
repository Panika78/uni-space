from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import get_settings

settings = get_settings()
# These limits apply only to the application pool. Alembic and operational tools
# create their own engines and keep their maintenance windows independent.
API_LOCK_TIMEOUT_MS = 5_000
API_STATEMENT_TIMEOUT_MS = 30_000
API_CONNECT_OPTIONS = (
    f"-c lock_timeout={API_LOCK_TIMEOUT_MS} -c statement_timeout={API_STATEMENT_TIMEOUT_MS}"
)
engine = create_engine(
    settings.database_url.get_secret_value(),
    pool_pre_ping=True,
    connect_args={"options": API_CONNECT_OPTIONS},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
