"""Upgrade real MVP1 applications without inventing historical transitions."""

import pytest
from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database, run_migration  # noqa: F401
from test_models_postgresql import add_study_group, add_user

from app.models import Application, ApplicationHistory, ServiceType, Student

pytestmark = pytest.mark.integration


def test_history_upgrade_preserves_existing_applications_and_has_single_head(migration_database):  # noqa: F811
    engine = migration_database
    run_migration(engine, "upgrade", "20261114_03")
    with Session(engine) as db, db.begin():
        group = add_study_group(db, "history-migration")
        user = add_user(db, "history-migration")
        actor_id = user.id
        student = Student(user_id=user.id, group_id=group.id, academic_status="enrolled")
        db.add(student)
        db.flush()
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        for status in ("submitted", "needs_correction", "approved", "rejected"):
            db.add(
                Application(
                    student_id=student.id,
                    service_type_id=service.id,
                    review_status=status,
                    document_status="pending",
                    version=7,
                    form_data={"place_of_submission": "Historical place"},
                    feedback="Historical reason",
                )
            )
    snapshot = text("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM applications a")
    with engine.connect() as db:
        before = db.scalar(snapshot)
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
    heads = run_migration(engine, "heads").stdout
    assert heads.count("(head)") == 1
    with engine.connect() as db:
        assert db.scalar(snapshot) == before
        assert db.scalar(text("SELECT count(*) FROM application_history")) == 0
    inspector = inspect(engine)
    assert {"ix_application_history_application_created_id"} == {
        index["name"] for index in inspector.get_indexes("application_history")
    }
    assert {fk["referred_table"] for fk in inspector.get_foreign_keys("application_history")} == {
        "applications",
        "users",
    }
    with Session(engine) as db, db.begin():
        application = db.scalar(select(Application).order_by(Application.id))
        db.add(
            ApplicationHistory(
                application_id=application.id,
                actor_user_id=actor_id,
                from_status="submitted",
                to_status="in_review",
            )
        )
    # Downgrade/re-upgrade only in this throwaway database; parent rows survive.
    run_migration(engine, "downgrade", "20261114_03")
    with engine.connect() as db:
        assert db.scalar(snapshot) == before
    run_migration(engine, "upgrade", "head")
    run_migration(engine, "check")
