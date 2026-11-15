"""The approved service registry is installed on clean databases and is repeatable."""

import pytest
from sqlalchemy import text
from test_academics_migrations import migration_database, run_migration  # noqa: F401

pytestmark = pytest.mark.integration

EXPECTED = {
    "study_certificate": ("automatic", True),
    "academic_transcript": ("automatic", True),
    "academic_leave": ("manual", False),
    "accounting_certificate": ("manual", True),
}


def test_service_registry_migration_is_idempotent(migration_database):  # noqa: F811
    run_migration(migration_database, "upgrade", "20261115_03")
    run_migration(migration_database, "upgrade", "head")
    run_migration(migration_database, "upgrade", "head")
    with migration_database.connect() as connection:
        records = connection.execute(
            text("SELECT code, processing_mode, produces_document FROM service_types ORDER BY code")
        ).all()
    assert {row.code: (row.processing_mode, row.produces_document) for row in records} == EXPECTED
    assert len(records) == 4
