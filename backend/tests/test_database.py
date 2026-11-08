from unittest.mock import Mock

from app.dependencies import database


def test_get_db_session_closes_session_without_committing(monkeypatch) -> None:
    session = Mock()
    monkeypatch.setattr(database, "SessionLocal", Mock(return_value=session))

    dependency = database.get_db_session()
    assert next(dependency) is session
    dependency.close()

    session.close.assert_called_once_with()
    session.commit.assert_not_called()
