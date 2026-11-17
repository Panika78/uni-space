"""PostgreSQL and private filesystem acceptance tests for academic leave files."""

import asyncio
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, func, select

from app.dependencies.auth import get_current_student, get_current_user
from app.dependencies.database import get_db_session
from app.models import (
    Application,
    ApplicationAttachment,
    ApplicationHistory,
    OrgUnit,
    Program,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    User,
)

pytestmark = pytest.mark.integration

PDF = Path(__file__).with_name("fixtures").joinpath("minimal.pdf").read_bytes()


@pytest.fixture
def real_auth(postgresql_engine, monkeypatch):
    from test_auth_integration import auth as auth_fixture

    yield from auth_fixture.__wrapped__(postgresql_engine, monkeypatch)


def test_academic_leave_upload_download_and_atomic_resubmit(
    postgresql_engine, monkeypatch, tmp_path
):
    from sqlalchemy.orm import Session

    from app.applications import router as router_module
    from app.main import RequestBodyLimitMiddleware, app

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
    commit_ack_loss = [False]

    def override_session():
        from sqlalchemy.orm import Session

        with Session(postgresql_engine) as session:
            session.info["lose_commit_ack"] = commit_ack_loss[0]
            yield session

    app.dependency_overrides[get_current_student] = lambda: current_student[0]
    app.dependency_overrides[get_db_session] = override_session
    monkeypatch.setattr(router_module, "get_settings", lambda: TestSettings())
    client = TestClient(app)
    monkeypatch.setattr(RequestBodyLimitMiddleware, "limit_bytes", 128)
    form = {
        "basis": "medical",
        "starts_on": "2026-12-01",
        "ends_on": "2026-12-31",
        "explanation": None,
    }
    original_commit = Session.commit

    def commit_then_lose_ack(session):
        original_commit(session)
        if session.info.pop("lose_commit_ack", False):
            raise RuntimeError("fictional lost commit acknowledgement")

    monkeypatch.setattr(Session, "commit", commit_then_lose_ack)
    created_id = None
    try:
        oversized = client.post(
            "/api/v1/applications",
            content=b"x",
            headers={"Content-Length": "129", "Content-Type": "application/json"},
        )
        assert oversized.status_code == 413
        assert oversized.json()["error"]["code"] == "request_too_large"
        assert oversized.headers.get("x-request-id")
        assert oversized.headers["cache-control"] == "no-store"
        assert oversized.headers["x-content-type-options"] == "nosniff"

        async def check_streaming_limit():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as async_client:

                async def stream(body):
                    yield body

                boundary = await async_client.post(
                    "/api/v1/applications",
                    content=stream(b"x" * 128),
                    headers={"Content-Type": "application/json"},
                )
                exceeded = await async_client.post(
                    "/api/v1/applications",
                    content=stream(b"x" * 129),
                    headers={"Content-Type": "application/json"},
                )
                return boundary, exceeded

        boundary, chunked_oversized = asyncio.run(check_streaming_limit())
        assert boundary.status_code == 422
        assert chunked_oversized.status_code == 413
        assert chunked_oversized.json()["error"]["code"] == "request_too_large"
        monkeypatch.setattr(RequestBodyLimitMiddleware, "limit_bytes", 54 * 1024 * 1024)
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

        with Session(postgresql_engine) as db, db.begin():
            application = db.get(Application, created_id)
            application.review_status = "needs_correction"
            application.version = 6
        replacement_fields = {
            "expected_version": "6",
            "form_data": __import__("json").dumps(form),
            "keep_attachment_ids": "[]",
        }

        def fail_resubmit_commit(_session):
            raise RuntimeError("fictional resubmit rollback")

        event.listen(Session, "before_commit", fail_resubmit_commit)
        try:
            rolled_back = client.post(
                f"/api/v1/applications/{created_id}/resubmit",
                data=replacement_fields,
                files=[("files", ("rollback-replacement.pdf", PDF, "application/pdf"))],
            )
        finally:
            event.remove(Session, "before_commit", fail_resubmit_commit)
        assert rolled_back.status_code == 500
        with Session(postgresql_engine) as db:
            assert db.scalar(select(Application.version).where(Application.id == created_id)) == 6
            current_before = db.scalar(
                select(ApplicationAttachment).where(
                    ApplicationAttachment.application_id == created_id,
                    ApplicationAttachment.is_current.is_(True),
                )
            )
        assert current_before.id == int(attachment["id"])

        commit_ack_loss[0] = True
        try:
            uncertain_resubmit = client.post(
                f"/api/v1/applications/{created_id}/resubmit",
                data=replacement_fields,
                files=[("files", ("replacement.pdf", PDF, "application/pdf"))],
            )
        finally:
            commit_ack_loss[0] = False
        assert uncertain_resubmit.status_code == 500
        with Session(postgresql_engine) as db:
            assert db.scalar(select(Application.version).where(Application.id == created_id)) == 7
            current_after = db.scalar(
                select(ApplicationAttachment).where(
                    ApplicationAttachment.application_id == created_id,
                    ApplicationAttachment.is_current.is_(True),
                )
            )
            latest_history = db.scalar(
                select(ApplicationHistory.to_status)
                .where(ApplicationHistory.application_id == created_id)
                .order_by(ApplicationHistory.id.desc())
                .limit(1)
            )
        assert current_after.id != current_before.id
        assert latest_history == "resubmitted"
        assert (tmp_path / "private-files" / current_after.storage_key).read_bytes() == PDF
        assert (
            client.get(f"/api/v1/applications/attachments/{current_after.id}/download").content
            == PDF
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
        stored_files = [
            path
            for path in (tmp_path / "private-files").iterdir()
            if path.is_file() and not path.name.startswith(".")
        ]
        assert len(stored_files) == 2
        with Session(postgresql_engine) as db:
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(Application)
                    .where(Application.student_id == student_id)
                )
                == 1
            )

        commit_ack_loss[0] = True
        try:
            uncertain = client.post(
                "/api/v1/applications",
                data={"form_data": __import__("json").dumps(form)},
                files=[("files", ("committed.pdf", PDF, "application/pdf"))],
            )
        finally:
            commit_ack_loss[0] = False
        assert uncertain.status_code == 500
        with Session(postgresql_engine) as db:
            uncertain_id = db.scalar(
                select(Application.id)
                .where(Application.student_id == student_id)
                .order_by(Application.id.desc())
            )
            uncertain_attachment = db.scalar(
                select(ApplicationAttachment).where(
                    ApplicationAttachment.application_id == uncertain_id
                )
            )
            assert uncertain_attachment is not None
            assert (
                db.scalar(
                    select(ApplicationHistory.id).where(
                        ApplicationHistory.application_id == uncertain_id
                    )
                )
                is not None
            )
        assert (tmp_path / "private-files" / uncertain_attachment.storage_key).read_bytes() == PDF
        assert (
            client.get(
                f"/api/v1/applications/attachments/{uncertain_attachment.id}/download"
            ).content
            == PDF
        )

        attachment_queries = []

        def count_attachment_queries(_connection, _cursor, statement, _parameters, _context, _many):
            if "application_attachments" in statement.lower():
                attachment_queries.append(statement)

        event.listen(postgresql_engine, "before_cursor_execute", count_attachment_queries)
        try:
            listed = client.get("/api/v1/applications?limit=50")
        finally:
            event.remove(postgresql_engine, "before_cursor_execute", count_attachment_queries)
        assert listed.status_code == 200
        assert len(attachment_queries) == 1

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
            db.execute(delete(Application).where(Application.student_id == student_id))
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


def test_download_authorization_uses_real_tokens_and_hides_attachment_existence(
    real_auth, monkeypatch, tmp_path
):
    from sqlalchemy.orm import Session
    from test_auth_integration import PASSWORD, PASSWORD_HASHER

    from app.applications import router as router_module
    from app.models import AuthSession, RefreshToken

    client, engine, _student_user_ids, student_logins, student_ids = real_auth
    app = client.app
    app.include_router(router_module.router)
    suffix = uuid4().hex
    with Session(engine) as db:
        faculty_id = db.scalar(
            select(Program.faculty_id)
            .join(StudyGroup, StudyGroup.program_id == Program.id)
            .join(Student, Student.group_id == StudyGroup.id)
            .where(Student.id == student_ids[0])
        )
        office = OrgUnit(
            name=f"Auth Attachment Office {suffix}", type="dean_office", parent_id=faculty_id
        )
        foreign_faculty = OrgUnit(name=f"Foreign Faculty {suffix}", type="faculty")
        db.add_all([office, foreign_faculty])
        db.flush()
        foreign_office = OrgUnit(
            name=f"Foreign Office {suffix}", type="dean_office", parent_id=foreign_faculty.id
        )
        db.add(foreign_office)
        db.flush()
        service = db.scalar(select(ServiceType).where(ServiceType.code == "academic_leave"))
        assert service is not None
        staff_users = [
            User(
                login=f"attachment-staff-{suffix}-{index}",
                password_hash=PASSWORD_HASHER.hash(PASSWORD),
                full_name=f"Attachment Staff {index}",
                role="staff",
                is_active=True,
            )
            for index in range(2)
        ]
        no_permission = User(
            login=f"attachment-no-permission-{suffix}",
            password_hash=PASSWORD_HASHER.hash(PASSWORD),
            full_name="Attachment Staff Without Permission",
            role="staff",
            is_active=True,
        )
        administrator = User(
            login=f"attachment-admin-{suffix}",
            password_hash=PASSWORD_HASHER.hash(PASSWORD),
            full_name="Attachment Administrator",
            role="admin",
            is_active=True,
        )
        db.add_all([*staff_users, no_permission, administrator])
        db.flush()
        profiles = [
            StaffProfile(user_id=staff_users[0].id, org_unit_id=office.id),
            StaffProfile(user_id=staff_users[1].id, org_unit_id=foreign_office.id),
            StaffProfile(user_id=no_permission.id, org_unit_id=office.id),
        ]
        db.add_all(profiles)
        db.flush()
        db.add_all(
            [
                StaffPermission(
                    staff_profile_id=profiles[0].id,
                    permission_code="applications.review",
                    scope_org_unit_id=office.id,
                ),
                StaffPermission(
                    staff_profile_id=profiles[1].id,
                    permission_code="applications.review",
                    scope_org_unit_id=foreign_office.id,
                ),
            ]
        )
        student_applications = [
            Application(
                student_id=student_ids[0],
                service_type_id=service.id,
                review_status="submitted",
                document_status="not_required",
                form_data={"basis": "medical"},
                assigned_org_unit_id=office.id,
                version=1,
            ),
            Application(
                student_id=student_ids[0],
                service_type_id=service.id,
                review_status="submitted",
                document_status="not_required",
                form_data={"basis": "medical"},
                assigned_org_unit_id=foreign_office.id,
                version=1,
            ),
        ]
        db.add_all(student_applications)
        db.flush()
        attachment_keys = [f"{uuid4().hex}.pdf" for _ in range(3)]
        owned, stale, foreign = [
            ApplicationAttachment(
                application_id=student_applications[1 if index == 2 else 0].id,
                storage_key=attachment_keys[index],
                original_filename=f"proof-{index}.pdf",
                mime_type="application/pdf",
                size_bytes=429,
                is_current=index != 1,
            )
            for index in range(3)
        ]
        db.add_all([owned, stale, foreign])
        db.flush()
        ids = [owned.id, stale.id, foreign.id]
        app_ids = [item.id for item in student_applications]
        staff_ids = [item.id for item in staff_users] + [no_permission.id, administrator.id]
        staff_logins = [item.login for item in staff_users] + [
            no_permission.login,
            administrator.login,
        ]
        office_ids = [office.id, foreign_office.id, foreign_faculty.id]
        db.commit()

    class TestSettings:
        attachment_storage_path = str(tmp_path / "private-files")

    monkeypatch.setattr(router_module, "get_settings", lambda: TestSettings())
    storage = tmp_path / "private-files"
    storage.mkdir(mode=0o700)
    pdf = Path(__file__).with_name("fixtures").joinpath("minimal.pdf").read_bytes()
    for key in attachment_keys:
        (storage / key).write_bytes(pdf)

    def access(login):
        response = client.login(json={"login": login, "password": PASSWORD})
        assert response.status_code == 200, response.text
        return response.json()["access_token"]

    tokens = [access(login) for login in student_logins + staff_logins]
    owner, stranger, scoped, foreign_scope, no_grant, admin = tokens
    try:

        def download(token, attachment_id, *, staff=False):
            prefix = (
                "/api/v1/staff/applications/attachments"
                if staff
                else "/api/v1/applications/attachments"
            )
            return client.request("GET", f"{prefix}/{attachment_id}/download", access=token)

        assert download(owner, ids[0]).status_code == 200
        assert download(stranger, ids[0]).status_code == 404
        assert download(scoped, ids[0], staff=True).status_code == 200
        assert download(scoped, ids[1], staff=True).status_code == 404
        assert download(foreign_scope, ids[0], staff=True).status_code == 404
        assert download(no_grant, ids[0], staff=True).status_code == 404
        assert download(admin, ids[0], staff=True).status_code == 404
        unknown_id = max(ids) + 999
        assert download(foreign_scope, unknown_id, staff=True).status_code == 404
        assert download(no_grant, unknown_id, staff=True).status_code == 404
        assert download(admin, unknown_id, staff=True).status_code == 404
        assert download(scoped, unknown_id, staff=True).status_code == 404
    finally:
        with Session(engine) as db, db.begin():
            db.execute(delete(ApplicationAttachment).where(ApplicationAttachment.id.in_(ids)))
            db.execute(delete(Application).where(Application.id.in_(app_ids)))
            profile_ids = select(StaffProfile.id).where(StaffProfile.user_id.in_(staff_ids))
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id.in_(profile_ids))
            )
            db.execute(delete(StaffProfile).where(StaffProfile.user_id.in_(staff_ids)))
            sessions = select(AuthSession.id).where(AuthSession.user_id.in_(staff_ids))
            db.execute(delete(RefreshToken).where(RefreshToken.session_id.in_(sessions)))
            db.execute(delete(AuthSession).where(AuthSession.user_id.in_(staff_ids)))
            db.execute(delete(User).where(User.id.in_(staff_ids)))
            db.execute(delete(OrgUnit).where(OrgUnit.id.in_([office_ids[0], office_ids[1]])))
            db.execute(delete(OrgUnit).where(OrgUnit.id == office_ids[2]))
        shutil.rmtree(storage, ignore_errors=True)
