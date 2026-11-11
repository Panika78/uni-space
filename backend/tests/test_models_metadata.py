from sqlalchemy import BigInteger

from app.models import Base

EXPECTED_TABLES = {
    "users",
    "auth_sessions",
    "refresh_tokens",
    "org_units",
    "programs",
    "study_groups",
    "students",
    "teachers",
    "service_types",
    "applications",
    "news",
}


def test_mvp_account_and_university_models_are_registered() -> None:
    assert set(Base.metadata.tables) >= EXPECTED_TABLES


def test_mvp_model_ids_and_foreign_keys_use_bigint() -> None:
    for table_name in EXPECTED_TABLES:
        table = Base.metadata.tables[table_name]
        assert isinstance(table.c.id.type, BigInteger)
        assert table.c.id.identity is not None
        assert table.c.id.identity.always is False
        for column in table.columns:
            if column.foreign_keys:
                assert isinstance(column.type, BigInteger)
