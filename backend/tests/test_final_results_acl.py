"""Real production credentials, concurrent requests and durable audit rollback."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_final_results_integration import results as results_fixture

from app.dependencies.database import get_db_session
from app.models import AuditEvent, FinalResult

pytestmark = pytest.mark.integration


def test_runtime_acl_concurrency_and_atomic_failure(runtime_engine, monkeypatch):  # noqa: F811
    admin_engine, api_engine = runtime_engine
    with Session(admin_engine, expire_on_commit=False) as admin:
        s = results_fixture.__wrapped__(admin)
        admin.commit()
        course_id, student_id = s.courses[0].id, s.students[0].id
        path = f"/api/v1/final-results/courses/{course_id}/students/{student_id}"
        headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}

        def runtime_session():
            with Session(api_engine) as db:
                yield db

        s.app.dependency_overrides[get_db_session] = runtime_session

        def request(method, body=None):
            return s.client.request(method, path, json=body, headers=headers)

        assert request("GET").status_code == 200
        assert request("POST", {"retake_location": "A-101"}).status_code == 200
        assert request("PATCH", {"retake_location": "B-202"}).status_code == 200
        assert request("PATCH", {"passed": False}).status_code == 422
        assert request("DELETE").status_code == 200
        other = path.replace(f"students/{student_id}", f"students/{s.students[1].id}")
        assert s.client.get(other, headers=headers).status_code == 404
        assert s.client.patch(other, json={"grade_value": 2}, headers=headers).status_code == 404
        # Concurrent absent INSERT, partial UPDATE, and DELETE all use separate connections.
        for operations in [
            [("POST", {"grade_value": 2}), ("POST", {"grade_value": 3})],
            [("PATCH", {"grade_value": 2}), ("PATCH", {"retake_location": "C-303"})],
            [("DELETE", None), ("PATCH", {"retake_date": "2027-01-10"})],
            [("DELETE", None), ("DELETE", None)],
        ]:
            barrier = Barrier(2)

            def run(operation, barrier=barrier):
                barrier.wait(timeout=10)
                return request(*operation)

            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(run, operations))
            assert [r.status_code for r in responses] == [200, 200]
        with Session(admin_engine) as observer:
            rows = observer.scalars(
                select(FinalResult).where(FinalResult.course_offering_id == course_id)
            ).all()
            assert rows == []
            events = observer.scalars(
                select(AuditEvent)
                .where(AuditEvent.entity_type == "final_result")
                .order_by(AuditEvent.id)
            ).all()
            state = None
            for event in events:
                assert event.before_data == state
                state = event.after_data
            assert state is None
        assert request("POST", {"grade_value": 2, "retake_location": "A-101"}).status_code == 200
        # Fail after the real writer flushes both mutation and event, before commit.
        from app.final_results import write_audit_event

        def fail(*args, **kwargs):
            write_audit_event(*args, **kwargs)
            raise ValueError("simulated failure after audit flush")

        with monkeypatch.context() as patch:
            patch.setattr("app.final_results.write_audit_event", fail)
            for method, body in [("PATCH", {"grade_value": 5}), ("DELETE", None)]:
                assert request(method, body).status_code == 500
        assert request("GET").json()["grade_value"] == 2
        assert request("GET").json()["retake_location"] == "A-101"
        with api_engine.connect() as db:
            for privilege in ["UPDATE", "DELETE"]:
                assert not db.scalar(
                    text("SELECT has_table_privilege(current_user,'audit_events',:p)"),
                    {"p": privilege},
                )
                with pytest.raises(DBAPIError):
                    db.execute(
                        text(
                            f"{privilege} "
                            + (
                                "FROM audit_events"
                                if privilege == "DELETE"
                                else "audit_events SET action='delete'"
                            )
                        )
                    )
                db.rollback()
            assert not db.scalar(text("SELECT has_table_privilege(current_user,'users','UPDATE')"))
            for statement in (
                "UPDATE final_results SET student_id=student_id",
                "UPDATE final_results SET course_offering_id=course_offering_id",
                "UPDATE course_offerings SET attestation_type='exam'",
                "SELECT * FROM audit_events",
            ):
                with pytest.raises(DBAPIError):
                    db.execute(text(statement))
                db.rollback()
