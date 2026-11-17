"""PostgreSQL/API/filesystem acceptance for issued documents and approval ordering."""

from __future__ import annotations

import io
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from pypdf import PdfReader
from sqlalchemy import delete, event, select
from sqlalchemy.orm import Session

from app.auth.security import create_access_token
from app.core.config import get_settings
from app.models import (
    AcademicTerm,
    Application,
    ApplicationHistory,
    Assessment,
    AssessmentGroup,
    AssessmentResult,
    AuthSession,
    CourseGroup,
    CourseOffering,
    Discipline,
    FinalResult,
    IssuedDocument,
    OrgUnit,
    RefreshToken,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    User,
)

pytestmark = pytest.mark.integration
PASSWORD = "fictional-issued-document-password"


@pytest.fixture
def issue_context(postgresql_engine, monkeypatch, tmp_path):
    from test_auth_integration import auth as auth_fixture

    from app.applications import router as application_router
    from app.applications import router as router_module
    from app.documents import issuer as issuer_module

    auth_generator = auth_fixture.__wrapped__(postgresql_engine, monkeypatch)
    client, engine, student_users, logins, student_ids = next(auth_generator)
    client.app.include_router(application_router.router)

    class TestSettings:
        attachment_storage_path = str(tmp_path / "private-volume")

    monkeypatch.setattr(router_module, "get_settings", lambda: TestSettings())
    monkeypatch.setattr(issuer_module, "get_settings", lambda: TestSettings())
    monkeypatch.setattr(
        issuer_module,
        "SessionLocal",
        lambda: Session(postgresql_engine, expire_on_commit=False),
    )
    try:
        yield {
            "client": client,
            "engine": engine,
            "student_users": student_users,
            "logins": logins,
            "student_ids": student_ids,
            "root": Path(TestSettings.attachment_storage_path),
        }
    finally:
        auth_generator.close()


def _login(context, index=0):
    response = context["client"].login(
        json={"login": context["logins"][index], "password": "fictional-auth-password"}
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def _cleanup_application(context, application_id):
    with Session(context["engine"]) as db, db.begin():
        db.execute(delete(IssuedDocument).where(IssuedDocument.application_id == application_id))
        db.execute(delete(Application).where(Application.id == application_id))


def test_automatic_certificate_is_approved_before_pdf_and_bytes_never_change(
    issue_context,
):
    context = issue_context
    owner_token = _login(context)
    response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=owner_token,
        json={
            "service_code": "study_certificate",
            "form_data": {"place_of_submission": "Вымышленная организация"},
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    identifier = int(body["id"])
    assert response.headers["location"].endswith(f"/applications/{identifier}")
    assert (body["review_status"], body["document_status"]) == ("approved", "ready")
    assert body["document"] and "storage_key" not in body["document"]

    path = f"/api/v1/applications/{identifier}/document"
    first = context["client"].request("GET", path, access=owner_token)
    assert first.status_code == 200
    assert first.headers["content-type"] == "application/pdf"
    assert first.headers["cache-control"] == "no-store"
    assert first.headers["x-content-type-options"] == "nosniff"
    assert PdfReader(__import__("io").BytesIO(first.content), strict=True).pages
    stranger = _login(context, 1)
    assert context["client"].request("GET", path, access=stranger).status_code == 404

    with Session(context["engine"]) as db, db.begin():
        app_row = db.get(Application, identifier)
        owner = db.get(User, context["student_users"][0])
        owner.full_name = "Изменённое вымышленное имя после выдачи"
        version = app_row.version
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        document_id, issued_at = document.id, document.issued_at

    retry = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/retry", access=owner_token
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["document"]["id"] == str(document_id)
    second = context["client"].request("GET", path, access=owner_token)
    assert second.content == first.content
    with Session(context["engine"]) as db:
        app_row = db.get(Application, identifier)
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
        ).all()
        assert app_row.version == version
        assert document.id == document_id and document.issued_at == issued_at
        assert len(history) == 2
        assert history[1].from_status == "submitted"
        assert history[1].to_status == "approved" and history[1].actor_user_id is None
    _cleanup_application(context, identifier)


def test_render_failure_keeps_approval_and_concurrent_retries_issue_once(
    issue_context, monkeypatch
):
    from app.documents import issuer as issuer_module

    context = issue_context
    owner_token = _login(context)
    original_render = issuer_module.pdf.render_pdf
    fail_once = [True]

    def render(snapshot):
        if fail_once[0]:
            fail_once[0] = False
            raise RuntimeError("injected render failure")
        return original_render(snapshot)

    monkeypatch.setattr(issuer_module.pdf, "render_pdf", render)
    response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=owner_token,
        json={
            "service_code": "study_certificate",
            "form_data": {"place_of_submission": "Вымышленное место"},
        },
    )
    assert response.status_code == 201, response.text
    identifier = int(response.json()["id"])
    assert (response.json()["review_status"], response.json()["document_status"]) == (
        "approved",
        "failed",
    )
    with Session(context["engine"]) as db:
        assert (
            db.scalar(select(Application.review_status).where(Application.id == identifier))
            == "approved"
        )
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )

    def retry():
        return context["client"].request(
            "POST", f"/api/v1/applications/{identifier}/document/retry", access=owner_token
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: retry(), range(4)))
    assert all(result.status_code == 200 for result in results)
    ids = {result.json()["document"]["id"] for result in results}
    assert len(ids) == 1
    with Session(context["engine"]) as db:
        assert (
            len(
                db.scalars(
                    select(IssuedDocument.id).where(IssuedDocument.application_id == identifier)
                ).all()
            )
            == 1
        )
        assert (
            db.scalar(select(Application.document_status).where(Application.id == identifier))
            == "ready"
        )
        assert (
            len(
                db.scalars(
                    select(ApplicationHistory.id).where(
                        ApplicationHistory.application_id == identifier
                    )
                ).all()
            )
            == 2
        )
    _cleanup_application(context, identifier)


def test_explicit_process_approves_existing_automatic_application_once(issue_context):
    context = issue_context
    token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        existing = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="submitted",
            document_status="pending",
            form_data={"place_of_submission": "Сохранённое демонстрационное место"},
            version=1,
        )
        db.add(existing)
        db.flush()
        identifier = existing.id
        db.add(
            ApplicationHistory(
                application_id=identifier,
                actor_user_id=context["student_users"][0],
                from_status=None,
                to_status="submitted",
            )
        )

    path = f"/api/v1/applications/{identifier}/document/process"
    result = context["client"].request("POST", path, access=token)
    assert result.status_code == 200, result.text
    assert result.json()["id"] == str(identifier)
    assert result.json()["document_status"] == "ready"
    again = context["client"].request("POST", path, access=token)
    assert again.status_code == 200, again.text
    assert again.json()["document"]["id"] == result.json()["document"]["id"]
    with Session(context["engine"]) as db:
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
        ).all()
        assert len(history) == 2
        assert history[-1].from_status == "submitted"
        assert history[-1].to_status == "approved" and history[-1].actor_user_id is None
    _cleanup_application(context, identifier)


def test_transcript_uses_server_saved_period_scores_and_manual_final(issue_context):
    context = issue_context
    engine = context["engine"]
    suffix = uuid4().hex
    starts_on, ends_on = datetime(2026, 1, 1).date(), datetime(2026, 12, 31).date()
    with Session(engine) as db:
        student = db.get(Student, context["student_ids"][0])
        term = AcademicTerm(
            name=f"Фиксированный период {suffix}", starts_on=starts_on, ends_on=ends_on
        )
        discipline = Discipline(code=suffix, name="Вымышленная дисциплина")
        db.add_all([term, discipline])
        db.flush()
        offering = CourseOffering(
            discipline_id=discipline.id, term_id=term.id, attestation_type="exam"
        )
        db.add(offering)
        db.flush()
        db.add(CourseGroup(course_offering_id=offering.id, group_id=student.group_id))
        assessment = Assessment(
            course_offering_id=offering.id,
            title="Демонстрационная работа",
            type="practical",
            max_score=20,
        )
        db.add(assessment)
        db.flush()
        assignment = AssessmentGroup(
            assessment_id=assessment.id,
            group_id=student.group_id,
            planned_date=starts_on,
        )
        db.add(assignment)
        db.flush()
        db.add(
            AssessmentResult(
                assessment_group_id=assignment.id,
                student_id=student.id,
                score=0,
                graded_by_user_id=None,
                graded_at=datetime.now(UTC),
            )
        )
        db.add(
            FinalResult(
                course_offering_id=offering.id,
                student_id=student.id,
                grade_value=4,
                passed=None,
            )
        )
        term_id = term.id
        offering_id = offering.id
        assessment_id = assessment.id
        assignment_id = assignment.id
        discipline_id = discipline.id
        db.commit()

    token = _login(context)
    response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=token,
        json={"service_code": "academic_transcript", "form_data": {}},
    )
    assert response.status_code == 201, response.text
    identifier = int(response.json()["id"])
    assert response.json()["review_status"] == "approved"
    assert response.json()["document_status"] == "ready"
    assert response.json()["form_data"]["academic_term_id"] == str(term_id)
    downloaded = context["client"].request(
        "GET", f"/api/v1/applications/{identifier}/document", access=token
    )
    text = "\n".join(
        page.extract_text() or "" for page in PdfReader(io.BytesIO(downloaded.content)).pages
    )
    assert f"Фиксированный период {suffix}" in text
    assert "Вымышленная дисциплина" in text
    assert "0 / 20" in text
    assert "Итоговая оценка" in text and "4" in text
    with Session(engine) as db:
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        assert document.snapshot_data["term"]["id"] == str(term_id)
        assert document.snapshot_data["subjects"][0]["assessments"][0]["score"] == 0
        assert document.snapshot_data["subjects"][0]["final_result"] == 4
    _cleanup_application(context, identifier)
    with Session(engine) as db, db.begin():
        db.execute(
            delete(AssessmentResult).where(AssessmentResult.assessment_group_id == assignment_id)
        )
        db.execute(delete(FinalResult).where(FinalResult.course_offering_id == offering_id))
        db.execute(delete(AssessmentGroup).where(AssessmentGroup.id == assignment_id))
        db.execute(delete(Assessment).where(Assessment.id == assessment_id))
        db.execute(delete(CourseGroup).where(CourseGroup.course_offering_id == offering_id))
        db.execute(delete(CourseOffering).where(CourseOffering.id == offering_id))
        db.execute(delete(Discipline).where(Discipline.id == discipline_id))
        db.execute(delete(AcademicTerm).where(AcademicTerm.id == term_id))


def test_accounting_pdf_starts_only_after_scoped_staff_approval(issue_context):
    context = issue_context
    engine = context["engine"]
    suffix = uuid4().hex
    with Session(engine) as db:
        accounting = OrgUnit(name=f"Fictional Accounting {suffix}", type="accounting")
        db.add(accounting)
        db.flush()
        service = db.scalar(select(ServiceType).where(ServiceType.code == "accounting_certificate"))
        service.responsible_org_unit_id = accounting.id
        service_id = service.id
        staff = User(
            login=f"issued-staff-{suffix}",
            password_hash="not-used",
            full_name="Fictional Accounting Reviewer",
            role="staff",
            is_active=True,
        )
        db.add(staff)
        db.flush()
        profile = StaffProfile(user_id=staff.id, org_unit_id=accounting.id)
        db.add(profile)
        db.flush()
        db.add(
            StaffPermission(
                staff_profile_id=profile.id,
                permission_code="applications.review",
                scope_org_unit_id=accounting.id,
            )
        )
        session = AuthSession(
            user_id=staff.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add(session)
        db.flush()
        staff_token = create_access_token(session, get_settings())["access_token"]
        staff_id, profile_id, accounting_id = staff.id, profile.id, accounting.id
        staff_session_id = session.id
        db.commit()

    student_token = _login(context)
    created = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=student_token,
        json={"service_code": "accounting_certificate", "form_data": {"purpose": "Демонстрация"}},
    )
    assert created.status_code == 201, created.text
    identifier = int(created.json()["id"])
    assert created.json()["review_status"] == "submitted"
    assert created.json()["document_status"] == "pending"
    with Session(engine) as db:
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )

    in_review = context["client"].request(
        "POST",
        f"/api/v1/staff/applications/{identifier}/review",
        access=staff_token,
        json={"expected_version": 1, "action": "start_review"},
    )
    assert in_review.status_code == 200, in_review.text
    approved = context["client"].request(
        "POST",
        f"/api/v1/staff/applications/{identifier}/review",
        access=staff_token,
        json={"expected_version": 2, "action": "approve"},
    )
    assert approved.status_code == 200, approved.text
    assert (approved.json()["review_status"], approved.json()["document_status"]) == (
        "approved",
        "ready",
    )
    assert approved.json()["document"]
    with Session(engine) as db:
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
        ).all()
        assert history[-1].actor_user_id == staff_id
        assert db.scalar(
            select(IssuedDocument.id).where(IssuedDocument.application_id == identifier)
        )
    _cleanup_application(context, identifier)
    with Session(engine) as db, db.begin():
        db.execute(delete(RefreshToken).where(RefreshToken.session_id == staff_session_id))
        db.execute(delete(AuthSession).where(AuthSession.id == staff_session_id))
        db.execute(delete(StaffPermission).where(StaffPermission.staff_profile_id == profile_id))
        db.delete(db.get(StaffProfile, profile_id))
        db.delete(db.get(User, staff_id))
        db.get(ServiceType, service_id).responsible_org_unit_id = None
        db.delete(db.get(OrgUnit, accounting_id))


def test_issued_document_commit_ack_loss_is_resolved_without_reissue(issue_context, monkeypatch):
    from app.documents import issuer as issuer_module

    context = issue_context
    original_commit = Session.commit

    def issue_sessions():
        return Session(
            context["engine"],
            expire_on_commit=False,
            info={"lose_issued_commit_ack": True},
        )

    monkeypatch.setattr(issuer_module, "SessionLocal", issue_sessions)

    def commit_then_lose_ack(session):
        lose_ack = session.info.pop("lose_issued_commit_ack", False)
        original_commit(session)
        if lose_ack:
            raise RuntimeError("injected lost commit acknowledgement")

    monkeypatch.setattr(Session, "commit", commit_then_lose_ack)
    token = _login(context)
    response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=token,
        json={
            "service_code": "study_certificate",
            "form_data": {"place_of_submission": "Тест неопределённого COMMIT"},
        },
    )
    assert response.status_code == 201, response.text
    identifier = int(response.json()["id"])
    assert response.json()["document_status"] == "ready"
    with Session(context["engine"]) as db:
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        assert document is not None
        assert (context["root"] / "issued_documents" / document.storage_key).is_file()
        assert (
            len(
                db.scalars(
                    select(IssuedDocument.id).where(IssuedDocument.application_id == identifier)
                ).all()
            )
            == 1
        )
    _cleanup_application(context, identifier)


@pytest.mark.parametrize("failed_statement", ["insert_document", "update_ready"])
def test_sql_publication_failure_keeps_approval_and_removes_uncommitted_pdf(
    issue_context, failed_statement
):
    context = issue_context
    raised = [False]

    def fail_once(_connection, _cursor, statement, _parameters, _context, _many):
        normalized = statement.lower()
        matches = (
            failed_statement == "insert_document" and "insert into issued_documents" in normalized
        ) or (
            failed_statement == "update_ready"
            and "update applications" in normalized
            and "document_status" in normalized
        )
        if matches and not raised[0]:
            raised[0] = True
            raise RuntimeError(f"injected {failed_statement} failure")

    event.listen(context["engine"], "before_cursor_execute", fail_once)
    try:
        token = _login(context)
        response = context["client"].request(
            "POST",
            "/api/v1/applications",
            access=token,
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "Тест SQL-сбоя"},
            },
        )
    finally:
        event.remove(context["engine"], "before_cursor_execute", fail_once)
    assert raised[0]
    assert response.status_code == 201, response.text
    identifier = int(response.json()["id"])
    assert (response.json()["review_status"], response.json()["document_status"]) == (
        "approved",
        "failed",
    )
    with Session(context["engine"]) as db:
        assert (
            db.scalar(select(Application.review_status).where(Application.id == identifier))
            == "approved"
        )
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )
    files = list((context["root"] / "issued_documents").glob("*.pdf"))
    assert files == []
    _cleanup_application(context, identifier)


def test_cleanup_waits_for_pdf_commit_and_keeps_new_reference(issue_context, monkeypatch):
    from app.documents import issuer as issuer_module
    from app.documents.storage import cleanup_orphans

    context = issue_context
    entered_renderer = threading.Event()
    finish_renderer = threading.Event()
    original_render = issuer_module.pdf.render_pdf

    def slow_render(snapshot):
        entered_renderer.set()
        assert finish_renderer.wait(timeout=5)
        return original_render(snapshot)

    monkeypatch.setattr(issuer_module.pdf, "render_pdf", slow_render)
    token = _login(context)

    def create_document():
        return context["client"].request(
            "POST",
            "/api/v1/applications",
            access=token,
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "Параллельная очистка"},
            },
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        generation = pool.submit(create_document)
        assert entered_renderer.wait(timeout=5)
        cleanup = pool.submit(
            cleanup_orphans,
            context["root"],
            lambda: {key for key in _issued_keys(context["engine"])},
            older_than_seconds=0,
        )
        finish_renderer.set()
        response = generation.result(timeout=10)
        cleanup.result(timeout=10)
    assert response.status_code == 201, response.text
    identifier = int(response.json()["id"])
    document_id = response.json()["document"]["id"]
    with Session(context["engine"]) as db:
        document = db.get(IssuedDocument, int(document_id))
        assert document.application_id == identifier
        assert (context["root"] / "issued_documents" / document.storage_key).is_file()
    _cleanup_application(context, identifier)


def _issued_keys(engine):
    with Session(engine) as db:
        return set(db.scalars(select(IssuedDocument.storage_key)))
