"""PostgreSQL and private filesystem acceptance tests for academic leave files."""

from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select

from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.models import (
    Application,
    ApplicationAttachment,
    ApplicationHistory,
    OrgUnit,
    Program,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    User,
)

pytestmark = pytest.mark.integration

PDF = b"%PDF-1.4\nfictional supporting record\n%%EOF"


def test_academic_leave_upload_download_and_atomic_resubmit(
    postgresql_engine, monkeypatch, tmp_path
):
    from sqlalchemy.orm import Session

    from app.applications import router as router_module
    from app.main import app

    suffix = uuid4().hex
    with Session(postgresql_engine) as db:
        faculty = OrgUnit(name=f"Attachment Faculty {suffix}", type="faculty")
        db.add(faculty)
        db.flush()
        office = OrgUnit(
            name=f"Attachment Dean Office {suffix}", type="dean_office", parent_id=faculty.id
        )
        program = Program(
            code=suffix,
            name=suffix,
            direction_code=suffix,
            direction_name=suffix,
            faculty_id=faculty.id,
        )
        db.add_all([office, program])
        db.flush()
        group = StudyGroup(name=suffix, program_id=program.id, course_number=1)
        owner = User(
            login=f"attach-{suffix}",
            password_hash="fixture",
            full_name="Fictional Owner",
            role="student",
            is_active=True,
        )
        stranger = User(
            login=f"attach-other-{suffix}",
            password_hash="fixture",
            full_name="Fictional Stranger",
            role="student",
            is_active=True,
        )
        db.add_all([group, owner, stranger])
        db.flush()
        student = Student(user_id=owner.id, group_id=group.id, academic_status="enrolled")
        other = Student(user_id=stranger.id, group_id=group.id, academic_status="enrolled")
        db.add_all([student, other])
        db.commit()
        student_id, other_student_id = student.id, other.id
        group_id = group.id
        owner_user_id, stranger_user_id = owner.id, stranger.id
        office_id = office.id
        staff = User(
            login=f"attach-staff-{suffix}",
            password_hash="fixture",
            full_name="Fictional Reviewer",
            role="staff",
            is_active=True,
        )
        db.add(staff)
        db.flush()
        profile = StaffProfile(user_id=staff.id, org_unit_id=office.id)
        db.add(profile)
        db.flush()
        db.add(
            StaffPermission(
                staff_profile_id=profile.id,
                permission_code="applications.review",
                scope_org_unit_id=office.id,
            )
        )
        db.commit()
        staff_user_id = staff.id

    class TestSettings:
        attachment_storage_path = str(tmp_path / "private-files")

    current_student = [Student(id=student_id, group_id=group_id, user_id=owner_user_id)]

    def override_session():
        from sqlalchemy.orm import Session

        with Session(postgresql_engine) as session:
            yield session

    app.dependency_overrides[get_current_student] = lambda: current_student[0]
    app.dependency_overrides[get_db_session] = override_session
    monkeypatch.setattr(router_module, "get_settings", lambda: TestSettings())
    client = TestClient(app)
    form = {
        "basis": "medical",
        "starts_on": "2026-12-01",
        "ends_on": "2026-12-31",
        "explanation": None,
    }
    created_id = None
    try:
        oversized = client.post(
            "/api/v1/applications",
            content=b"body is rejected by declared size before parsing",
            headers={"Content-Length": str(54 * 1024 * 1024 + 1)},
        )
        assert oversized.status_code == 413
        assert oversized.json()["error"]["code"] == "request_too_large"
        no_file = client.post(
            "/api/v1/applications", json={"service_code": "academic_leave", "form_data": form}
        )
        assert no_file.status_code == 422
        assert no_file.json()["error"]["code"] == "attachment_required"
        assert client.get("/api/v1/services").json()["items"]

        created = client.post(
            "/api/v1/applications",
            data={"form_data": __import__("json").dumps(form)},
            files=[("files", ("proof.pdf", PDF, "application/pdf"))],
        )
        assert created.status_code == 201, created.text
        payload = created.json()
        created_id = int(payload["id"])
        with Session(postgresql_engine) as db:
            assert (
                db.scalar(
                    select(Application.assigned_org_unit_id).where(Application.id == created_id)
                )
                == office_id
            )
        attachment = payload["attachments"][0]
        assert set(attachment) == {"id", "original_filename", "mime_type", "size_bytes"}
        assert attachment["original_filename"] == "proof.pdf"
        assert "storage_key" not in created.text and str(tmp_path) not in created.text
        assert (tmp_path / "private-files" / ".staging").exists()
        assert (tmp_path / "private-files").stat().st_mode & 0o777 == 0o700
        with Session(postgresql_engine) as db:
            key = db.scalar(
                select(ApplicationAttachment.storage_key).where(
                    ApplicationAttachment.application_id == created_id
                )
            )
        assert (tmp_path / "private-files" / key).stat().st_mode & 0o777 == 0o600
        assert client.get(f"/api/v1/applications/{created_id}/attachments").json() == [attachment]

        downloaded = client.get(f"/api/v1/applications/attachments/{attachment['id']}/download")
        assert downloaded.status_code == 200
        assert downloaded.content == PDF
        assert downloaded.headers["cache-control"] == "no-store"
        assert downloaded.headers["x-content-type-options"] == "nosniff"
        assert "attachment;" in downloaded.headers["content-disposition"]

        current_student[0] = Student(
            id=other_student_id, group_id=group_id, user_id=stranger_user_id
        )
        assert (
            client.get(f"/api/v1/applications/attachments/{attachment['id']}/download").status_code
            == 404
        )
        assert client.get(f"/api/v1/applications/{created_id}/attachments").status_code == 404
        current_student[0] = Student(id=student_id, group_id=group_id, user_id=owner_user_id)

        app.dependency_overrides[get_current_user] = lambda: User(
            id=staff_user_id, role="staff", is_active=True
        )
        assert client.get(f"/api/v1/staff/applications/{created_id}/attachments").json() == [
            attachment
        ]
        staff_download = client.get(
            f"/api/v1/staff/applications/attachments/{attachment['id']}/download"
        )
        assert staff_download.status_code == 200 and staff_download.content == PDF
        app.dependency_overrides.pop(get_current_user)

        with Session(postgresql_engine) as db, db.begin():
            application = db.get(Application, created_id)
            application.review_status = "needs_correction"
            application.version = 2
            application.feedback = "Fictional correction"
        form["basis"] = "family"
        form["explanation"] = None
        resubmitted = client.post(
            f"/api/v1/applications/{created_id}/resubmit",
            json={
                "expected_version": 2,
                "form_data": form,
                "keep_attachment_ids": [attachment["id"]],
            },
        )
        assert resubmitted.status_code == 200, resubmitted.text
        assert resubmitted.json()["form_data"]["basis"] == "family"
        assert [item["id"] for item in resubmitted.json()["attachments"]] == [attachment["id"]]
        assert (
            client.get(f"/api/v1/applications/attachments/{attachment['id']}/download").content
            == PDF
        )

        stale = client.post(
            f"/api/v1/applications/{created_id}/resubmit",
            json={
                "expected_version": 2,
                "form_data": form,
                "keep_attachment_ids": [attachment["id"]],
            },
        )
        assert stale.status_code == 409
        with Session(postgresql_engine) as db:
            assert db.scalar(select(Application.version).where(Application.id == created_id)) == 3
            assert (
                db.scalar(select(Application.review_status).where(Application.id == created_id))
                == "resubmitted"
            )
            assert (
                db.scalar(
                    select(ApplicationHistory.to_status)
                    .where(ApplicationHistory.application_id == created_id)
                    .order_by(ApplicationHistory.id.desc())
                    .limit(1)
                )
                == "resubmitted"
            )

        with Session(postgresql_engine) as db, db.begin():
            application = db.get(Application, created_id)
            application.review_status = "needs_correction"
            application.version = 4
        request_body = {
            "expected_version": 4,
            "form_data": form,
            "keep_attachment_ids": [attachment["id"]],
        }
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda _index: client.post(
                        f"/api/v1/applications/{created_id}/resubmit", json=request_body
                    ),
                    range(2),
                )
            )
        assert sorted(response.status_code for response in responses) == [200, 409]
        with Session(postgresql_engine) as db:
            assert db.scalar(select(Application.version).where(Application.id == created_id)) == 5
            assert (
                len(
                    db.scalars(
                        select(ApplicationAttachment).where(
                            ApplicationAttachment.application_id == created_id,
                            ApplicationAttachment.is_current.is_(True),
                        )
                    ).all()
                )
                == 1
            )

        def fail_commit(_session):
            raise RuntimeError("fictional attachment commit failure")

        event.listen(Session, "before_commit", fail_commit)
        try:
            failed = client.post(
                "/api/v1/applications",
                data={"form_data": __import__("json").dumps(form)},
                files=[("files", ("rollback.pdf", PDF, "application/pdf"))],
            )
        finally:
            event.remove(Session, "before_commit", fail_commit)
        assert failed.status_code == 500
        stored_files = [path for path in (tmp_path / "private-files").iterdir() if path.is_file()]
        assert len(stored_files) == 1

        invalid = client.post(
            "/api/v1/applications",
            data={"form_data": __import__("json").dumps(form)},
            files=[("files", ("bad.pdf", b"not a PDF", "application/pdf"))],
        )
        assert invalid.status_code == 422
        assert invalid.json()["error"]["code"] == "invalid_attachment"
    finally:
        app.dependency_overrides.clear()
        with Session(postgresql_engine) as db, db.begin():
            if created_id:
                db.execute(delete(Application).where(Application.id == created_id))
            db.execute(delete(Student).where(Student.id.in_([student_id, other_student_id])))
            db.execute(
                delete(User).where(User.login.in_([f"attach-{suffix}", f"attach-other-{suffix}"]))
            )
            db.execute(
                delete(StaffPermission).where(
                    StaffPermission.staff_profile_id.in_(
                        select(StaffProfile.id).where(StaffProfile.user_id == staff_user_id)
                    )
                )
            )
            db.execute(delete(StaffProfile).where(StaffProfile.user_id == staff_user_id))
            db.execute(delete(User).where(User.login == f"attach-staff-{suffix}"))
            db.execute(delete(StudyGroup).where(StudyGroup.name == suffix))
            db.execute(delete(Program).where(Program.code == suffix))
            db.execute(
                delete(OrgUnit).where(
                    OrgUnit.name.in_(
                        [f"Attachment Faculty {suffix}", f"Attachment Dean Office {suffix}"]
                    )
                )
            )
