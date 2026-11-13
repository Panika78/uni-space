import base64
import json
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select

from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Application, OrgUnit, Program, ServiceType, Student, StudyGroup, User


@pytest.mark.integration
def test_application_reads_isolate_students_and_page_in_sql(db_session):
    from app.main import app

    suffix = uuid4().hex
    faculty = OrgUnit(name=suffix, type="faculty")
    db_session.add(faculty)
    db_session.flush()
    program = Program(
        code=suffix,
        name=suffix,
        direction_code=suffix,
        direction_name=suffix,
        faculty_id=faculty.id,
    )
    db_session.add(program)
    db_session.flush()
    group = StudyGroup(name=suffix, program_id=program.id, course_number=1)
    users = [
        User(
            login=f"{suffix}-{i}",
            password_hash="fixture",
            full_name=suffix,
            role="student",
            is_active=True,
        )
        for i in range(2)
    ]
    db_session.add_all([group, *users])
    db_session.flush()
    students = [
        Student(user_id=user.id, group_id=group.id, academic_status="enrolled") for user in users
    ]
    db_session.add_all(students)
    db_session.flush()
    service = db_session.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
    timestamp = datetime(2026, 11, 1, tzinfo=UTC)
    rows = [
        Application(
            student_id=students[0].id,
            service_type_id=service.id,
            review_status="submitted",
            document_status="pending",
            form_data={"place_of_submission": f"Place {i}"},
            version=1,
            created_at=timestamp,
        )
        for i in range(43)
    ]
    foreign = Application(
        student_id=students[1].id,
        service_type_id=service.id,
        review_status="approved",
        document_status="failed",
        feedback="Feedback",
        form_data={"place_of_submission": "Private"},
        version=1,
    )
    db_session.add_all([*rows, foreign])
    db_session.flush()
    current = [students[0]]
    app.dependency_overrides[get_db_session] = lambda: db_session
    app.dependency_overrides[get_current_student] = lambda: current[0]
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if "FROM applications" in statement:
            statements.append((statement, parameters))

    event.listen(db_session.bind, "before_cursor_execute", capture)
    try:
        client = TestClient(app)
        first = client.get("/api/v1/applications")
        assert first.status_code == 200
        assert first.headers["cache-control"] == "no-store"
        page = first.json()
        assert len(page["items"]) == 20
        assert "applications.student_id =" in statements[-1][0]
        assert "LIMIT" in statements[-1][0]
        seen = [item["id"] for item in page["items"]]
        # Insert after page one: the cursor continues below the original boundary.
        new = Application(
            student_id=students[0].id,
            service_type_id=service.id,
            review_status="submitted",
            document_status="pending",
            form_data={"place_of_submission": "New"},
            version=1,
        )
        db_session.add(new)
        db_session.flush()
        while page["next_cursor"]:
            response = client.get("/api/v1/applications", params={"cursor": page["next_cursor"]})
            assert response.status_code == 200
            page = response.json()
            seen.extend(item["id"] for item in page["items"])
        assert seen == [str(row.id) for row in reversed(rows)]
        assert len(set(seen)) == 43
        assert client.get("/api/v1/applications?limit=1").json()["items"][0]["id"] == str(new.id)
        assert len(client.get("/api/v1/applications?limit=100").json()["items"]) == 44
        for query in (
            "limit=0",
            "limit=101",
            "limit=-1",
            "limit=1.5",
            "limit=true",
            "limit=",
            "cursor=",
            "cursor=broken",
            "student_id=1",
            "foo=1",
            "limit=1&limit=2",
            "cursor=x&cursor=y",
        ):
            response = client.get(f"/api/v1/applications?{query}")
            assert response.status_code == 422, query
            assert response.json()["error"]["code"] == "validation_error"
        for key, direction in (
            (["broken", 1], "desc"),
            (["2026-01-01", 1], "desc"),
            (["2026-01-01T00:00:00Z", 0], "desc"),
            (["2026-01-01T00:00:00Z", 9223372036854775808], "desc"),
            (["2026-01-01T00:00:00Z", "1"], "desc"),
            (["2026-01-01T00:00:00Z", 1], "asc"),
        ):
            cursor = (
                base64.urlsafe_b64encode(
                    json.dumps({"v": 2, "direction": direction, "key": key}).encode()
                )
                .decode()
                .rstrip("=")
            )
            assert client.get("/api/v1/applications", params={"cursor": cursor}).status_code == 422
        owned = client.get(f"/api/v1/applications/{rows[0].id}")
        assert owned.status_code == 200
        assert owned.json()["form_data"] == {"place_of_submission": "Place 0"}
        assert "applications.student_id =" in statements[-1][0]
        missing = client.get("/api/v1/applications/9223372036854775807")
        other = client.get(f"/api/v1/applications/{foreign.id}")
        assert missing.status_code == other.status_code == 404
        assert missing.json() == other.json()
        for identifier in ("0", "-1", "abc", "1.0", "9223372036854775808", "9" * 100):
            assert client.get(f"/api/v1/applications/{identifier}").status_code == 422
        assert client.get(f"/api/v1/applications/{rows[0].id}?student_id=1").status_code == 422
        current[0] = students[1]
        assert [item["id"] for item in client.get("/api/v1/applications").json()["items"]] == [
            str(foreign.id)
        ]
        detail = client.get(f"/api/v1/applications/{foreign.id}").json()
        assert (detail["review_status"], detail["document_status"], detail["feedback"]) == (
            "approved",
            "failed",
            "Feedback",
        )
        assert client.get(f"/api/v1/applications/{rows[0].id}").status_code == 404
        current[0] = Student(id=9223372036854775807)
        assert client.get("/api/v1/applications").json() == {"items": [], "next_cursor": None}
    finally:
        event.remove(db_session.bind, "before_cursor_execute", capture)
        app.dependency_overrides.clear()
