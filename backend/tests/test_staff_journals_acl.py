"""Exercise staff journal HTTP reads under the production PostgreSQL ACL."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_staff_journals_integration import staff
from test_staff_journals_integration import staff_journal as journal_fixture

from app.dependencies.database import get_db_session

pytestmark = pytest.mark.integration


def test_staff_history_uses_restricted_projection_and_pair_index(runtime_engine):  # noqa: F811
    admin_engine, api_engine = runtime_engine
    with Session(admin_engine, expire_on_commit=False) as owner:
        s = journal_fixture.__wrapped__(owner)
        _, headers, _ = staff(s, "grades.edit")
        student, assessment = s.students[0].id, s.work.id
        owner.commit()

        def runtime_session():
            with Session(api_engine) as db:
                yield db

        s.app.dependency_overrides[get_db_session] = runtime_session
        write = s.results.replace("/staff/journals/", "/teaching/") + f"/{student}"
        assert s.client.put(write, json={"score": 0}, headers=headers).status_code == 200
        assert s.client.put(write, json={"score": None}, headers=headers).status_code == 200

        owner.execute(
            text("""
                INSERT INTO audit_events (entity_type, entity_id, action, after_data)
                SELECT CASE i % 4 WHEN 0 THEN 'assessment_result' WHEN 1 THEN 'final_result'
                       ELSE 'attendance' END, i, 'create',
                       jsonb_build_object(
                           'assessment_group_id', 200 + i % 2000,
                           'course_offering_id', 200 + i % 3000,
                           'student_id', 200 + i % 80001, 'score', 0
                       )
                FROM generate_series(1,400000) i
            """)
        )
        # Mismatched update snapshots must never appear in either student's timeline.
        owner.execute(
            text("""
                INSERT INTO audit_events (entity_type, entity_id, action, before_data, after_data)
                VALUES ('assessment_result', 999999, 'update',
                    jsonb_build_object('assessment_group_id', :assessment, 'student_id', :other,
                                       'score', 5),
                    jsonb_build_object('assessment_group_id', :assessment, 'student_id', :student,
                                       'score', 10))
            """),
            {"assessment": assessment, "student": student, "other": s.students[2].id},
        )
        owner.execute(text("ANALYZE audit_events"))
        owner.commit()

    history = s.client.get(f"{s.results}/{student}/history", headers=headers)
    assert history.status_code == 200, history.text
    assert [item["action"] for item in history.json()["items"]] == ["delete", "create"]
    assert history.json()["items"][1]["after"] == {"score": 0}

    with api_engine.connect() as db:
        plan = "\n".join(
            db.scalars(
                text("""
                    EXPLAIN (ANALYZE, BUFFERS)
                    SELECT id, created_at, before, after FROM staff_journal_events
                    WHERE entity_type = 'assessment_result'
                      AND target_id = to_jsonb(CAST(:assessment AS bigint))
                      AND student_id = to_jsonb(CAST(:student AS bigint))
                    ORDER BY created_at DESC, id DESC LIMIT 21
                """),
                {"assessment": assessment, "student": student},
            )
        )
        assert "Index Scan using ix_audit_events_journal_pair" in plan, plan
        assert "Seq Scan" not in plan
        for statement in (
            "SELECT before_data, after_data FROM audit_events",
            "UPDATE audit_events SET action = 'update'",
            "DELETE FROM audit_events",
            "DELETE FROM staff_journal_events",
        ):
            with pytest.raises(DBAPIError):
                db.execute(text(statement))
            db.rollback()
