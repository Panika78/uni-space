from unittest.mock import Mock

import pytest

from app.dependencies import database


def test_get_db_session_closes_session_without_committing(monkeypatch) -> None:
    session = Mock()
    monkeypatch.setattr(database, "SessionLocal", Mock(return_value=session))

    dependency = database.get_db_session()
    assert next(dependency) is session
    with pytest.raises(RuntimeError, match="request failed"):
        dependency.throw(RuntimeError("request failed"))

    session.rollback.assert_called_once_with()
    session.close.assert_called_once_with()
    session.commit.assert_not_called()


def test_api_engine_has_bounded_postgresql_deadlines() -> None:
    from app.core import database as core_database

    assert core_database.engine.dialect.name == "postgresql"
    assert f"lock_timeout={core_database.API_LOCK_TIMEOUT_MS}" in core_database.API_CONNECT_OPTIONS
    assert (
        f"statement_timeout={core_database.API_STATEMENT_TIMEOUT_MS}"
        in core_database.API_CONNECT_OPTIONS
    )
