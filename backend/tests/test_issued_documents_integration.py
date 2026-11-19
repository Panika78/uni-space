"""PostgreSQL/API/filesystem acceptance for issued documents and approval ordering."""

from __future__ import annotations

import io
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from pypdf import PdfReader
from sqlalchemy import delete, event, func, select
from sqlalchemy.orm import Session

from app.auth.security import create_access_token
from app.core.config import get_settings
from app.models import (
    AcademicTerm,
    Application,
    ApplicationAttachment,
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
    Notification,
    OrgUnit,
    RefreshToken,
    ServiceType,
    StaffPermission,
    StaffProfile,
    Student,
    User,
)


def _render_empty(_snapshot):
    return b""


def _render_bad_header(_snapshot):
    return b"not a PDF"


def _render_bad_xref(snapshot):
    from app.documents import pdf

    return re.sub(rb"startxref\s+\d+", b"startxref\n999999999", pdf.render_pdf(snapshot))


def _render_truncated(snapshot):
    from app.documents import pdf

    content = pdf.render_pdf(snapshot)
    return content[: len(content) // 2]


def _render_hung(_snapshot):
    time.sleep(30)
    return b""


def _render_failure(_snapshot):
    raise RuntimeError("injected render failure")


def _issue_then_pause_before_commit(database_url, application_id, owner_id, root, marker):
    """Subprocess target: pause the API process after file publication, before COMMIT."""
    from types import SimpleNamespace

    from sqlalchemy import create_engine

    from app.documents import issuer as issuer_module
    from app.models import IssuedDocument as IssuedDocumentModel

    engine = create_engine(database_url)
    issuer_module.get_settings = lambda: SimpleNamespace(attachment_storage_path=root)
    issuer_module.SessionLocal = lambda: Session(engine, expire_on_commit=False)
    original_commit = Session.commit

    def paused_commit(session):
        if any(
            isinstance(instance, IssuedDocumentModel)
            for instance in [*session.new, *session.identity_map.values()]
        ):
            Path(marker).write_text("published", encoding="utf-8")
            while True:
                time.sleep(60)
        return original_commit(session)

    Session.commit = paused_commit
    try:
        issuer_module.issue_document(application_id, actor_kind="owner", actor_id=owner_id)
    except BaseException as exc:
        Path(marker + ".error").write_text(repr(exc), encoding="utf-8")
        raise


@pytest.mark.parametrize(
    "renderer", [_render_empty, _render_bad_header, _render_bad_xref, _render_truncated]
)
def test_invalid_renderer_output_stays_failed_without_publication(
    issue_context, monkeypatch, renderer
):
    from app.documents import issuer as issuer_module

    context = issue_context
    original_operation = issuer_module._run_issued_filesystem_operation
    renderer_for_test = renderer

    def invalid_pdf_operation(operation, *args, renderer=None):
        return original_operation(
            operation,
            *args,
            renderer=renderer_for_test if operation == "render_publish" else renderer,
        )

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", invalid_pdf_operation)

    token = _login(context)
    response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=token,
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
    assert response.json()["document"] is None
    with Session(context["engine"]) as db:
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )
        assert db.scalar(
            select(Notification.id).where(Notification.user_id == context["student_users"][0])
        ) is None
    assert list((context["root"] / "issued_documents").glob("*.pdf")) == []
    _cleanup_application(context, identifier)


def test_hung_render_is_killed_and_retry_can_complete(issue_context, monkeypatch):
    from app.documents import issuer as issuer_module

    context = issue_context
    original_timeout = issuer_module.ISSUANCE_OPERATION_TIMEOUT_SECONDS
    monkeypatch.setattr(issuer_module, "ISSUANCE_OPERATION_TIMEOUT_SECONDS", 10)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Вымышленное место"},
            version=1,
        )
        db.add(application)
        db.flush()
        identifier = application.id
    timed_out = issuer_module.issue_document(
        identifier,
        actor_kind="owner",
        actor_id=context["student_users"][0],
        render_pdf_fn=_render_hung,
    )
    assert timed_out.document_status == "failed"
    with Session(context["engine"]) as db:
        assert (
            db.scalar(select(Application.document_status).where(Application.id == identifier))
            == "failed"
        )
    token = _login(context)
    monkeypatch.setattr(issuer_module, "ISSUANCE_OPERATION_TIMEOUT_SECONDS", original_timeout)
    retry = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/retry", access=token
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["document_status"] == "ready"
    _cleanup_application(context, identifier)


@pytest.mark.parametrize("failure", ["prepare_root", "coordination_lock"])
@pytest.mark.parametrize("service_code", ["study_certificate", "accounting_certificate"])
def test_storage_preflight_failure_preserves_committed_business_response(
    issue_context, monkeypatch, failure, service_code
):
    from app.applications import storage as attachment_storage
    from app.documents import issuer as issuer_module

    context = issue_context
    student_token = _login(context)
    staff_token = None
    if service_code == "accounting_certificate":
        suffix = uuid4().hex
        with Session(context["engine"]) as db, db.begin():
            accounting = db.scalar(
                select(OrgUnit).where(OrgUnit.type == "accounting").order_by(OrgUnit.id).limit(1)
            )
            if accounting is None:
                accounting = OrgUnit(name=f"Fictional Accounting {suffix}", type="accounting")
                db.add(accounting)
                db.flush()
            service = db.scalar(select(ServiceType).where(ServiceType.code == service_code))
            service.responsible_org_unit_id = accounting.id
            staff = User(
                login=f"preflight-staff-{suffix}",
                password_hash="fixture",
                full_name="Fictional Reviewer",
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

    original_operation = issuer_module._run_issued_filesystem_operation
    original_lock = attachment_storage.coordination_lock

    def fail_operation(operation, *args, renderer=None):
        if failure == "prepare_root" and operation == "prepare_root":
            raise OSError("injected storage unavailable")
        return original_operation(operation, *args, renderer=renderer)

    def fail_lock(*_args, **_kwargs):
        raise TimeoutError("injected lock timeout")

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", fail_operation)
    if failure == "coordination_lock":
        monkeypatch.setattr(attachment_storage, "coordination_lock", fail_lock)

    created = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=student_token,
        json={
            "service_code": service_code,
            "form_data": (
                {"place_of_submission": "Демонстрация"}
                if service_code == "study_certificate"
                else {"purpose": "Демонстрация"}
            ),
        },
    )
    assert created.status_code == 201, created.text
    identifier = int(created.json()["id"])
    assert created.headers["location"].endswith(f"/applications/{identifier}")
    if service_code == "accounting_certificate":
        assert created.json()["review_status"] == "submitted"
        assert (
            context["client"]
            .request(
                "POST",
                f"/api/v1/staff/applications/{identifier}/review",
                access=staff_token,
                json={"expected_version": 1, "action": "start_review"},
            )
            .status_code
            == 200
        )
        response = context["client"].request(
            "POST",
            f"/api/v1/staff/applications/{identifier}/review",
            access=staff_token,
            json={"expected_version": 2, "action": "approve"},
        )
    else:
        response = created
    assert response.status_code == (200 if service_code == "accounting_certificate" else 201)
    assert (response.json()["review_status"], response.json()["document_status"]) == (
        "approved",
        "failed",
    )
    with Session(context["engine"]) as db:
        app_row = db.get(Application, identifier)
        version = app_row.version
        history_count = len(
            db.scalars(
                select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
            ).all()
        )
        assert app_row.review_status == "approved" and app_row.document_status == "failed"
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", original_operation)
    monkeypatch.setattr(attachment_storage, "coordination_lock", original_lock)
    retry_path = (
        f"/api/v1/staff/applications/{identifier}/document/retry"
        if service_code == "accounting_certificate"
        else f"/api/v1/applications/{identifier}/document/retry"
    )
    retry = context["client"].request(
        "POST",
        retry_path,
        access=staff_token if service_code == "accounting_certificate" else student_token,
    )
    assert retry.status_code == 200 and retry.json()["document_status"] == "ready"
    with Session(context["engine"]) as db:
        assert db.get(Application, identifier).version == version + 1
        assert (
            len(
                db.scalars(
                    select(ApplicationHistory).where(
                        ApplicationHistory.application_id == identifier
                    )
                ).all()
            )
            == history_count
        )
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is not None
        )
    _cleanup_application(context, identifier)


def test_storage_preflight_failure_does_not_overwrite_concurrent_ready(issue_context, monkeypatch):
    from app.documents import issuer as issuer_module

    context = issue_context
    with Session(context["engine"], expire_on_commit=False) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Демо"},
            version=2,
        )
        db.add(application)
        db.flush()
        identifier = application.id

    original_operation = issuer_module._run_issued_filesystem_operation
    original_record_failure = issuer_module._record_preflight_failure
    first_thread_id = None
    preflight_failed = threading.Event()
    continue_failure_record = threading.Event()

    def fail_only_first_prepare(operation, *args, renderer=None):
        if operation == "prepare_root" and threading.get_ident() == first_thread_id:
            raise OSError("injected preflight failure")
        return original_operation(operation, *args, renderer=renderer)

    def pause_failure_record(application_id, *, actor_kind, actor_id):
        preflight_failed.set()
        assert continue_failure_record.wait(timeout=10)
        return original_record_failure(application_id, actor_kind=actor_kind, actor_id=actor_id)

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", fail_only_first_prepare)
    monkeypatch.setattr(issuer_module, "_record_preflight_failure", pause_failure_record)

    def failing_attempt():
        nonlocal first_thread_id
        first_thread_id = threading.get_ident()
        return issuer_module.issue_document(
            identifier,
            actor_kind="owner",
            actor_id=context["student_users"][0],
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(failing_attempt)
        assert preflight_failed.wait(timeout=10)
        winner = issuer_module.issue_document(
            identifier,
            actor_kind="owner",
            actor_id=context["student_users"][0],
        )
        assert winner.document_status == "ready" and winner.document is not None
        continue_failure_record.set()
        loser = first.result(timeout=10)
    assert loser.document_status == "ready" and loser.document is not None
    with Session(context["engine"]) as db:
        application = db.get(Application, identifier)
        assert application.document_status == "ready" and application.version == 3
        assert db.scalar(
            select(IssuedDocument.id).where(IssuedDocument.application_id == identifier)
        )
    _cleanup_application(context, identifier)


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
        with Session(engine) as db, db.begin():
            application_ids = select(Application.id).where(Application.student_id.in_(student_ids))
            db.execute(
                delete(IssuedDocument).where(IssuedDocument.application_id.in_(application_ids))
            )
            db.execute(
                delete(ApplicationAttachment).where(
                    ApplicationAttachment.application_id.in_(application_ids)
                )
            )
            db.execute(
                delete(ApplicationHistory).where(
                    ApplicationHistory.application_id.in_(application_ids)
                )
            )
            db.execute(delete(Application).where(Application.id.in_(application_ids)))
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


@pytest.mark.parametrize(
    ("review_status", "document_status", "service_code", "expected_status"),
    [
        ("submitted", "pending", "study_certificate", 409),
        ("in_review", "pending", "study_certificate", 409),
        ("rejected", "pending", "study_certificate", 409),
        ("approved", "pending", "study_certificate", 503),
        ("approved", "failed", "study_certificate", 503),
        ("approved", "ready", "study_certificate", 200),
        ("submitted", "not_required", "academic_leave", 409),
    ],
)
def test_retry_state_and_service_are_checked_before_storage_lock(
    issue_context, monkeypatch, review_status, document_status, service_code, expected_status
):
    from fastapi import HTTPException

    from app.applications import storage as attachment_storage
    from app.documents import issuer as issuer_module

    context = issue_context
    lock_attempts = []

    def unavailable_lock(*_args, **_kwargs):
        lock_attempts.append(True)
        raise TimeoutError("storage lock unavailable")

    monkeypatch.setattr(attachment_storage, "coordination_lock", unavailable_lock)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == service_code))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status=review_status,
            document_status=document_status,
            form_data=(
                {"place_of_submission": "Демо"} if service_code == "study_certificate" else {}
            ),
            version=1,
        )
        db.add(application)
        db.flush()
        identifier = application.id
        if document_status == "ready":
            from app.documents import pdf as pdf_module

            snapshot = {
                "service_code": "study_certificate",
                "document_number": "US-DEMO-123456789ABC",
                "issued_at": "2026-11-17T10:00:00+03:00",
                "full_name": "ФИО студента",
                "group": "Демо 1",
                "program": "Программа",
                "direction": "Демо",
                "academic_status": "enrolled",
                "place_of_submission": "Демонстрационное место",
            }
            from app.documents import storage as document_storage

            root = document_storage.issued_root(context["root"])
            key = document_storage.create_key()
            document_storage.publish_bytes(root, key, pdf_module.render_pdf(snapshot))
            db.add(
                IssuedDocument(
                    application_id=identifier,
                    storage_key=key,
                    filename="study_certificate.pdf",
                    snapshot_data=snapshot,
                )
            )

    if expected_status == 200:
        result = issuer_module.issue_document(
            identifier, actor_kind="owner", actor_id=context["student_users"][0]
        )
        assert result.document_status == "ready" and result.document is not None
        assert lock_attempts == []
    else:
        with pytest.raises(HTTPException) as exc:
            issuer_module.issue_document(
                identifier, actor_kind="owner", actor_id=context["student_users"][0]
            )
        assert exc.value.status_code == expected_status
        assert bool(lock_attempts) == (expected_status == 503)
    _cleanup_application(context, identifier)


def test_download_handles_missing_and_unavailable_storage_without_chmod(issue_context, monkeypatch):
    from app.documents import storage as issued_storage

    context = issue_context
    token = _login(context)
    created = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=token,
        json={
            "service_code": "study_certificate",
            "form_data": {"place_of_submission": "Тест доступности"},
        },
    )
    identifier = int(created.json()["id"])
    path = f"/api/v1/applications/{identifier}/document"
    with Session(context["engine"]) as db:
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        file_path = context["root"] / "issued_documents" / document.storage_key
        original_bytes = file_path.read_bytes()
    file_path.unlink()
    assert context["client"].request("GET", path, access=token).status_code == 503
    issued_storage.publish_bytes(
        context["root"] / "issued_documents", file_path.name, original_bytes
    )
    file_path.write_bytes(b"%PDF-broken xref")
    assert context["client"].request("GET", path, access=token).status_code == 503
    file_path.write_bytes(original_bytes)

    original_root = issued_storage.existing_issued_root

    def inaccessible(_attachment_root):
        raise PermissionError("injected directory access error")

    monkeypatch.setattr(issued_storage, "existing_issued_root", inaccessible)
    assert context["client"].request("GET", path, access=token).status_code == 503
    monkeypatch.setattr(issued_storage, "existing_issued_root", original_root)

    def chmod_must_not_run(*_args, **_kwargs):
        raise OSError("GET must not change storage permissions")

    monkeypatch.setattr(Path, "chmod", chmod_must_not_run)
    downloaded = context["client"].request("GET", path, access=token)
    assert downloaded.status_code == 200
    assert downloaded.content == original_bytes
    _cleanup_application(context, identifier)


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


def test_document_retry_and_download_reject_foreign_blocked_and_revoked_owners(issue_context):
    context = issue_context
    owner_token = _login(context)
    created = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=owner_token,
        json={
            "service_code": "study_certificate",
            "form_data": {"place_of_submission": "Вымышленное место"},
        },
    )
    identifier = int(created.json()["id"])
    get_path = f"/api/v1/applications/{identifier}/document"
    retry_path = f"/api/v1/applications/{identifier}/document/retry"
    stranger = _login(context, 1)
    assert context["client"].request("GET", get_path, access=stranger).status_code == 404
    assert context["client"].request("POST", retry_path, access=stranger).status_code == 404

    with Session(context["engine"]) as db, db.begin():
        session = db.scalar(
            select(AuthSession)
            .where(AuthSession.user_id == context["student_users"][0])
            .order_by(AuthSession.id.desc())
        )
        session.revoked_at = datetime.now(UTC)
    assert context["client"].request("GET", get_path, access=owner_token).status_code == 401

    active_token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        owner = db.get(User, context["student_users"][0])
        owner.is_active = False
    assert context["client"].request("POST", retry_path, access=active_token).status_code == 401
    with Session(context["engine"]) as db, db.begin():
        db.get(User, context["student_users"][0]).is_active = True
    _cleanup_application(context, identifier)


def test_render_failure_keeps_approval_and_concurrent_retries_issue_once(
    issue_context, monkeypatch
):
    from app.documents import issuer as issuer_module

    context = issue_context
    owner_token = _login(context)
    original_operation = issuer_module._run_issued_filesystem_operation

    def failing_operation(operation, *args, renderer=None):
        return original_operation(
            operation,
            *args,
            renderer=_render_failure if operation == "render_publish" else renderer,
        )

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", failing_operation)
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
    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", original_operation)

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
        assert db.scalar(
            select(func.count(Notification.id)).where(
                Notification.user_id == context["student_users"][0],
                Notification.type == "document_ready",
            )
        ) == 1
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


def test_concurrent_retries_from_pending_issue_once(issue_context):
    context = issue_context
    token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Демонстрационная справка"},
            version=3,
        )
        db.add(application)
        db.flush()
        identifier = application.id

    def retry():
        return context["client"].request(
            "POST", f"/api/v1/applications/{identifier}/document/retry", access=token
        )

    with ThreadPoolExecutor(max_workers=3) as pool:
        responses = list(pool.map(lambda _: retry(), range(3)))
    assert [response.status_code for response in responses] == [200, 200, 200]
    assert len({response.json()["document"]["id"] for response in responses}) == 1
    assert all(response.json()["document_status"] == "ready" for response in responses)
    with Session(context["engine"]) as db:
        row = db.get(Application, identifier)
        docs = db.scalars(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        ).all()
        events = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
        ).all()
        assert (row.review_status, row.document_status, row.version) == ("approved", "ready", 4)
        assert len(docs) == 1 and len(events) == 0
        assert (context["root"] / "issued_documents" / docs[0].storage_key).is_file()
    _cleanup_application(context, identifier)


def test_api_process_crash_after_publish_recovers_orphan_and_retry(
    issue_context, tmp_path, monkeypatch
):
    import multiprocessing

    from app.documents.storage import cleanup_orphans, issued_root
    from scripts import cleanup_issued_documents

    context = issue_context
    token = _login(context)
    existing_response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=token,
        json={
            "service_code": "study_certificate",
            "form_data": {"place_of_submission": "Документ, который должен сохраниться"},
        },
    )
    assert existing_response.status_code == 201
    existing_id = int(existing_response.json()["id"])
    with Session(context["engine"]) as db:
        existing_document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == existing_id)
        )
        existing_key = existing_document.storage_key
        existing_bytes = (context["root"] / "issued_documents" / existing_key).read_bytes()

    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Crash recovery demonstration"},
            version=2,
        )
        db.add(application)
        db.flush()
        identifier = application.id
        db.add(
            ApplicationHistory(
                application_id=identifier,
                actor_user_id=None,
                from_status="submitted",
                to_status="approved",
                comment=None,
            )
        )

    marker = tmp_path / "published-before-commit"
    database_url = context["engine"].url.render_as_string(hide_password=False)
    process = multiprocessing.get_context("fork").Process(
        target=_issue_then_pause_before_commit,
        args=(
            database_url,
            identifier,
            context["student_users"][0],
            str(context["root"]),
            str(marker),
        ),
    )
    process.start()
    deadline = time.monotonic() + 20
    while not marker.exists() and process.is_alive() and time.monotonic() < deadline:
        time.sleep(0.05)
    error_path = Path(str(marker) + ".error")
    error_detail = error_path.read_text() if error_path.exists() else None
    assert marker.exists(), (
        "API process did not reach post-publication/pre-commit barrier; "
        f"exit={process.exitcode}, error={error_detail}"
    )
    process.kill()
    process.join(timeout=10)
    assert process.exitcode is not None and process.exitcode != 0

    pdf_root = issued_root(context["root"])
    crash_orphans = [path for path in pdf_root.glob("*.pdf") if path.name != existing_key]
    assert len(crash_orphans) == 1
    with Session(context["engine"]) as db:
        crashed = db.get(Application, identifier)
        assert (crashed.review_status, crashed.document_status) == ("approved", "pending")
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )
        history_count = len(
            db.scalars(
                select(ApplicationHistory.id).where(ApplicationHistory.application_id == identifier)
            ).all()
        )
    monkeypatch.setattr(
        cleanup_issued_documents,
        "SessionLocal",
        lambda: Session(context["engine"], expire_on_commit=False),
    )
    assert (
        cleanup_orphans(
            context["root"], cleanup_issued_documents.referenced_keys, older_than_seconds=0
        )
        == 1
    )
    assert not crash_orphans[0].exists()
    assert (pdf_root / existing_key).read_bytes() == existing_bytes

    recovered = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/retry", access=token
    )
    assert recovered.status_code == 200 and recovered.json()["document_status"] == "ready"
    with Session(context["engine"]) as db:
        assert (
            db.scalar(select(Application.document_status).where(Application.id == identifier))
            == "ready"
        )
        assert (
            len(
                db.scalars(
                    select(IssuedDocument.id).where(IssuedDocument.application_id == identifier)
                ).all()
            )
            == 1
        )
        assert (
            len(
                db.scalars(
                    select(ApplicationHistory.id).where(
                        ApplicationHistory.application_id == identifier
                    )
                ).all()
            )
            == history_count
        )
    assert (pdf_root / existing_key).read_bytes() == existing_bytes
    _cleanup_application(context, identifier)
    _cleanup_application(context, existing_id)


@pytest.mark.parametrize("read_path", ["list", "detail"])
def test_application_reads_remain_consistent_during_document_issuance(issue_context, read_path):
    from app.documents import issuer as issuer_module

    context = issue_context
    token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Согласованный снимок"},
            version=5,
        )
        db.add(application)
        db.flush()
        identifier = application.id

    query_reached = threading.Event()
    release_query = threading.Event()
    claimed = threading.Event()

    def pause_after_snapshot(_connection, _cursor, statement, _parameters, _context, _many):
        if (
            "LEFT OUTER JOIN issued_documents" in statement
            and not claimed.is_set()
            and threading.current_thread() is not threading.main_thread()
        ):
            claimed.set()
            query_reached.set()
            assert release_query.wait(timeout=10)

    event.listen(context["engine"], "after_cursor_execute", pause_after_snapshot)
    path = "/api/v1/applications" if read_path == "list" else f"/api/v1/applications/{identifier}"
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            read = pool.submit(context["client"].request, "GET", path, access=token)
            assert query_reached.wait(timeout=10), read.result(timeout=1).text
            issued = issuer_module.issue_document(
                identifier, actor_kind="owner", actor_id=context["student_users"][0]
            )
            assert issued.document_status == "ready"
            release_query.set()
            response = read.result(timeout=10)
    finally:
        release_query.set()
        event.remove(context["engine"], "after_cursor_execute", pause_after_snapshot)
    assert response.status_code == 200, response.text
    if read_path == "list":
        item = next(item for item in response.json()["items"] if item["id"] == str(identifier))
    else:
        item = response.json()
    assert (item["review_status"], item["document_status"], item["version"], item["document"]) == (
        "approved",
        "pending",
        5,
        None,
    )
    subsequent = context["client"].request("GET", path, access=token)
    if read_path == "list":
        item = next(item for item in subsequent.json()["items"] if item["id"] == str(identifier))
    else:
        item = subsequent.json()
    assert item["document_status"] == "ready" and item["document"] is not None
    _cleanup_application(context, identifier)


def test_preflight_failure_rechecks_staff_scope_after_permission_revocation(
    issue_context, monkeypatch
):
    from app.documents import issuer as issuer_module

    context = issue_context
    engine = context["engine"]
    suffix = uuid4().hex
    with Session(engine) as db, db.begin():
        accounting = db.scalar(
            select(OrgUnit).where(OrgUnit.type == "accounting").order_by(OrgUnit.id).limit(1)
        )
        accounting_created = accounting is None
        if accounting is None:
            accounting = OrgUnit(name=f"Fictional Accounting {suffix}", type="accounting")
            db.add(accounting)
            db.flush()
        service = db.scalar(select(ServiceType).where(ServiceType.code == "accounting_certificate"))
        service_id = service.id
        previous_scope = service.responsible_org_unit_id
        accounting_id = accounting.id
        service.responsible_org_unit_id = accounting.id
        staff = User(
            login=f"revoked-preflight-{suffix}",
            password_hash="fixture",
            full_name="Fictional Accounting Reviewer",
            role="staff",
            is_active=True,
        )
        db.add(staff)
        db.flush()
        profile = StaffProfile(user_id=staff.id, org_unit_id=accounting.id)
        db.add(profile)
        db.flush()
        permission = StaffPermission(
            staff_profile_id=profile.id,
            permission_code="applications.review",
            scope_org_unit_id=accounting.id,
        )
        db.add(permission)
        session = AuthSession(
            user_id=staff.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add(session)
        db.flush()
        staff_id, profile_id, permission_id, session_id = (
            staff.id,
            profile.id,
            permission.id,
            session.id,
        )
        staff_token = create_access_token(session, get_settings())["access_token"]
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"purpose": "Демонстрационная проверка доступа"},
            version=8,
        )
        db.add(application)
        db.flush()
        application_id = application.id
        db.add(
            ApplicationHistory(
                application_id=application_id,
                actor_user_id=staff_id,
                from_status="in_review",
                to_status="approved",
                comment=None,
            )
        )

    original_preflight = issuer_module._preflight
    original_operation = issuer_module._run_issued_filesystem_operation
    preflight_complete = threading.Event()
    continue_request = threading.Event()

    def pause_after_preflight(application_id, *, actor_kind, actor_id):
        state = original_preflight(application_id, actor_kind=actor_kind, actor_id=actor_id)
        preflight_complete.set()
        assert continue_request.wait(timeout=10)
        return state

    def fail_storage_prepare(operation, *args, renderer=None):
        if operation == "prepare_root":
            raise OSError("injected storage failure after authorization")
        return original_operation(operation, *args, renderer=renderer)

    monkeypatch.setattr(issuer_module, "_preflight", pause_after_preflight)
    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", fail_storage_prepare)
    with ThreadPoolExecutor(max_workers=1) as executor:
        request = executor.submit(
            context["client"].request,
            "POST",
            f"/api/v1/staff/applications/{application_id}/document/retry",
            access=staff_token,
        )
        assert preflight_complete.wait(timeout=10)
        with Session(engine) as db, db.begin():
            db.execute(delete(StaffPermission).where(StaffPermission.id == permission_id))
        continue_request.set()
        response = request.result(timeout=10)

    assert response.status_code == 404
    with Session(engine) as db:
        application = db.get(Application, application_id)
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == application_id)
        ).all()
        assert (application.review_status, application.document_status, application.version) == (
            "approved",
            "pending",
            8,
        )
        assert len(history) == 1 and history[0].actor_user_id == staff_id
        assert (
            db.scalar(
                select(IssuedDocument.id).where(IssuedDocument.application_id == application_id)
            )
            is None
        )
    assert list((context["root"] / "issued_documents").glob("*.pdf")) == []

    _cleanup_application(context, application_id)
    with Session(engine) as db, db.begin():
        db.execute(delete(AuthSession).where(AuthSession.id == session_id))
        db.execute(delete(StaffProfile).where(StaffProfile.id == profile_id))
        db.execute(delete(User).where(User.id == staff_id))
        db.get(ServiceType, service_id).responsible_org_unit_id = previous_scope
        if accounting_created:
            db.delete(db.get(OrgUnit, accounting_id))


def test_explicit_process_approves_existing_automatic_application_once(issue_context, monkeypatch):
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
    with Session(context["engine"]) as db:
        before = db.get(Application, identifier)
        version = before.version
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        document_id, issued_at, storage_key = document.id, document.issued_at, document.storage_key
        pdf_bytes = (context["root"] / "issued_documents" / storage_key).read_bytes()
    from app.documents import issuer as issuer_module

    def fail_if_reissued(*_args, **_kwargs):
        raise AssertionError("ready process must not invoke the issuer")

    monkeypatch.setattr(issuer_module, "issue_document", fail_if_reissued)
    again = context["client"].request("POST", path, access=token)
    assert again.status_code == 200, again.text
    assert again.json()["document"]["id"] == result.json()["document"]["id"]
    with Session(context["engine"]) as db:
        after = db.get(Application, identifier)
        document = db.scalar(
            select(IssuedDocument).where(IssuedDocument.application_id == identifier)
        )
        assert after.version == version
        assert document.id == document_id and document.issued_at == issued_at
        assert (
            context["root"] / "issued_documents" / document.storage_key
        ).read_bytes() == pdf_bytes
    with Session(context["engine"]) as db:
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
        ).all()
        assert len(history) == 2
        assert history[-1].from_status == "submitted"
        assert history[-1].to_status == "approved" and history[-1].actor_user_id is None
    _cleanup_application(context, identifier)


@pytest.mark.parametrize(
    ("review_status", "document_status"),
    [
        ("approved", "pending"),
        ("approved", "failed"),
        ("rejected", "pending"),
        ("in_review", "pending"),
    ],
)
def test_explicit_process_rejects_nonlegacy_states(issue_context, review_status, document_status):
    context = issue_context
    token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status=review_status,
            document_status=document_status,
            form_data={"place_of_submission": "Демонстрация"},
            version=7,
        )
        db.add(application)
        db.flush()
        identifier = application.id
        db.add(ApplicationHistory(application_id=identifier, to_status=review_status))
    response = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/process", access=token
    )
    assert response.status_code == 409
    with Session(context["engine"]) as db:
        application = db.get(Application, identifier)
        assert (application.review_status, application.document_status, application.version) == (
            review_status,
            document_status,
            7,
        )
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )
    _cleanup_application(context, identifier)


def test_explicit_process_rejects_foreign_and_non_document_applications(issue_context):
    context = issue_context
    owner_token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="submitted",
            document_status="pending",
            form_data={"place_of_submission": "Демонстрация"},
            version=1,
        )
        db.add(application)
        db.flush()
        identifier = application.id
    foreign = context["client"].request(
        "POST",
        f"/api/v1/applications/{identifier}/document/process",
        access=_login(context, 1),
    )
    assert foreign.status_code == 404
    with Session(context["engine"]) as db, db.begin():
        db.execute(delete(Application).where(Application.id == identifier))
        service = db.scalar(select(ServiceType).where(ServiceType.code == "academic_leave"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="submitted",
            document_status="not_required",
            form_data={"basis": "other", "starts_on": "2026-12-01", "ends_on": "2026-12-02"},
            version=1,
        )
        db.add(application)
        db.flush()
        identifier = application.id
    response = context["client"].request(
        "POST",
        f"/api/v1/applications/{identifier}/document/process",
        access=owner_token,
    )
    assert response.status_code == 409
    _cleanup_application(context, identifier)


@pytest.mark.parametrize(
    "academic_term_id",
    ["abc", None, "-1", "0", "999999999999999999999", "9223372036854775808", 42, [], "999999999"],
)
def test_legacy_transcript_with_invalid_saved_period_is_unchanged(issue_context, academic_term_id):
    context = issue_context
    token = _login(context)
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "academic_transcript"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="submitted",
            document_status="pending",
            form_data={
                "academic_term_id": academic_term_id,
                "academic_term_name": "Сохранённый период",
                "starts_on": "2026-01-01",
                "ends_on": "2026-12-31",
            },
            version=3,
        )
        db.add(application)
        db.flush()
        identifier = application.id
        db.add(
            ApplicationHistory(
                application_id=identifier,
                from_status=None,
                to_status="submitted",
            )
        )
    response = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/process", access=token
    )
    assert response.status_code == 409, response.text
    with Session(context["engine"]) as db:
        application = db.get(Application, identifier)
        assert (application.review_status, application.document_status, application.version) == (
            "submitted",
            "pending",
            3,
        )
        assert (
            len(
                db.scalars(
                    select(ApplicationHistory).where(
                        ApplicationHistory.application_id == identifier
                    )
                ).all()
            )
            == 1
        )
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )
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
        accounting = db.scalar(
            select(OrgUnit).where(OrgUnit.type == "accounting").order_by(OrgUnit.id).limit(1)
        )
        accounting_created = accounting is None
        if accounting is None:
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

        other_scope = OrgUnit(name=f"Fictional Other Scope {suffix}", type="faculty")
        db.add(other_scope)
        db.flush()
        other_scope_id = other_scope.id
        outside_staff = User(
            login=f"issued-outside-staff-{suffix}",
            password_hash="not-used",
            full_name="Fictional Out-of-scope Reviewer",
            role="staff",
            is_active=True,
        )
        admin = User(
            login=f"issued-admin-{suffix}",
            password_hash="not-used",
            full_name="Fictional Admin without application permission",
            role="admin",
            is_active=True,
        )
        db.add_all([outside_staff, admin])
        db.flush()
        outside_profile = StaffProfile(user_id=outside_staff.id, org_unit_id=other_scope.id)
        db.add(outside_profile)
        db.flush()
        db.add(
            StaffPermission(
                staff_profile_id=outside_profile.id,
                permission_code="applications.review",
                scope_org_unit_id=other_scope.id,
            )
        )
        outside_session = AuthSession(
            user_id=outside_staff.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        admin_session = AuthSession(
            user_id=admin.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add_all([outside_session, admin_session])
        db.flush()
        outside_token = create_access_token(outside_session, get_settings())["access_token"]
        admin_token = create_access_token(admin_session, get_settings())["access_token"]
        outside_staff_id, outside_profile_id = outside_staff.id, outside_profile.id
        admin_id = admin.id
        outside_session_id, admin_session_id = outside_session.id, admin_session.id
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
    document_path = f"/api/v1/staff/applications/{identifier}/document"
    staff_download = context["client"].request("GET", document_path, access=staff_token)
    assert staff_download.status_code == 200
    assert staff_download.headers["content-type"] == "application/pdf"
    staff_retry = context["client"].request(
        "POST", f"/api/v1/staff/applications/{identifier}/document/retry", access=staff_token
    )
    assert staff_retry.status_code == 200
    assert staff_retry.json()["document"] == approved.json()["document"]
    assert staff_retry.json()["version"] == approved.json()["version"]
    assert (
        context["client"].request("GET", document_path, access=staff_token).content
        == staff_download.content
    )
    assert context["client"].request("GET", document_path, access=outside_token).status_code == 404
    assert (
        context["client"]
        .request(
            "POST",
            f"/api/v1/staff/applications/{identifier}/document/retry",
            access=outside_token,
        )
        .status_code
        == 404
    )
    assert context["client"].request("GET", document_path, access=admin_token).status_code == 403
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
        db.execute(
            delete(AuthSession).where(AuthSession.id.in_([outside_session_id, admin_session_id]))
        )
        db.execute(delete(StaffPermission).where(StaffPermission.staff_profile_id == profile_id))
        db.execute(
            delete(StaffPermission).where(StaffPermission.staff_profile_id == outside_profile_id)
        )
        db.delete(db.get(StaffProfile, profile_id))
        db.delete(db.get(StaffProfile, outside_profile_id))
        db.delete(db.get(User, staff_id))
        db.delete(db.get(User, outside_staff_id))
        db.delete(db.get(User, admin_id))
        db.get(ServiceType, service_id).responsible_org_unit_id = None
        if accounting_created:
            db.delete(db.get(OrgUnit, accounting_id))
        db.delete(db.get(OrgUnit, other_scope_id))


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


def test_uncertain_commit_cannot_delete_later_committed_pdf(issue_context, monkeypatch):
    from app.documents import issuer as issuer_module
    from app.documents.storage import cleanup_orphans
    from scripts import cleanup_issued_documents

    context = issue_context
    with Session(context["engine"], expire_on_commit=False) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Демо из interleaving test"},
            version=1,
        )
        db.add(application)
        db.flush()
        application_id = application.id

    original_commit = Session.commit
    original_close = Session.close
    original_read_state = issuer_module._read_state
    original_fs_operation = issuer_module._run_issued_filesystem_operation
    issuing_session = None
    captured_key = None
    stale_read_seen = False

    def issue_session_factory():
        return Session(context["engine"], expire_on_commit=False)

    def lose_commit_response_before_resolution(session):
        nonlocal issuing_session
        if any(
            isinstance(item, IssuedDocument)
            for item in [*session.new, *session.identity_map.values()]
        ):
            issuing_session = session
            raise RuntimeError("simulated client error while COMMIT is unresolved")
        return original_commit(session)

    def keep_uncertain_transaction_open(session):
        if session is issuing_session:
            return None
        return original_close(session)

    def observe_old_mvcc_state(read_application_id):
        nonlocal stale_read_seen
        state = original_read_state(read_application_id)
        if (
            read_application_id == application_id
            and issuing_session is not None
            and not stale_read_seen
        ):
            stale_read_seen = True
            assert (state.document_status, state.document) == ("pending", None)
            # Resolve the same prepared transaction only after the independent
            # SELECT observed the older committed version.
            original_commit(issuing_session)
            original_close(issuing_session)
        return state

    def record_published_key(operation, *args, renderer=None):
        nonlocal captured_key
        if operation == "render_publish":
            captured_key = args[2]
        return original_fs_operation(operation, *args, renderer=renderer)

    monkeypatch.setattr(issuer_module, "SessionLocal", issue_session_factory)
    monkeypatch.setattr(Session, "commit", lose_commit_response_before_resolution)
    monkeypatch.setattr(Session, "close", keep_uncertain_transaction_open)
    monkeypatch.setattr(issuer_module, "_read_state", observe_old_mvcc_state)
    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", record_published_key)

    state = issuer_module.issue_document(
        application_id,
        actor_kind="owner",
        actor_id=context["student_users"][0],
    )
    assert stale_read_seen
    assert state.document_status == "ready" and state.document is not None
    assert captured_key is not None
    pdf_path = context["root"] / "issued_documents" / captured_key
    committed_bytes = pdf_path.read_bytes()
    with Session(context["engine"]) as db:
        application = db.get(Application, application_id)
        documents = db.scalars(
            select(IssuedDocument).where(IssuedDocument.application_id == application_id)
        ).all()
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == application_id)
        ).all()
        version, history_count = application.version, len(history)
        assert application.document_status == "ready"
        assert len(documents) == 1 and documents[0].storage_key == captured_key

    monkeypatch.setattr(
        cleanup_issued_documents,
        "SessionLocal",
        lambda: Session(context["engine"], expire_on_commit=False),
    )
    assert (
        cleanup_orphans(
            context["root"], cleanup_issued_documents.referenced_keys, older_than_seconds=0
        )
        == 0
    )
    assert pdf_path.read_bytes() == committed_bytes

    token = _login(context)
    downloaded = context["client"].request(
        "GET", f"/api/v1/applications/{application_id}/document", access=token
    )
    assert downloaded.status_code == 200
    assert downloaded.content == committed_bytes
    repeated = context["client"].request(
        "POST", f"/api/v1/applications/{application_id}/document/retry", access=token
    )
    assert repeated.status_code == 200 and repeated.json()["document_status"] == "ready"
    assert repeated.json()["document"]["id"] == state.document["id"]
    with Session(context["engine"]) as db:
        application = db.get(Application, application_id)
        documents = db.scalars(
            select(IssuedDocument).where(IssuedDocument.application_id == application_id)
        ).all()
        assert application.version == version
        assert len(documents) == 1 and documents[0].storage_key == captured_key
        assert (
            len(
                db.scalars(
                    select(ApplicationHistory).where(
                        ApplicationHistory.application_id == application_id
                    )
                ).all()
            )
            == history_count
        )
    assert pdf_path.read_bytes() == committed_bytes
    _cleanup_application(context, application_id)


def test_issued_pdf_cleanup_aborts_while_commit_holds_application_lock(issue_context, monkeypatch):
    from sqlalchemy.exc import OperationalError

    from app.documents.storage import cleanup_orphans, issued_root
    from scripts import cleanup_issued_documents

    context = issue_context
    with Session(context["engine"]) as db, db.begin():
        service = db.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
        application = Application(
            student_id=context["student_ids"][0],
            service_type_id=service.id,
            review_status="approved",
            document_status="pending",
            form_data={"place_of_submission": "Cleanup race demonstration"},
            version=1,
        )
        db.add(application)
        db.flush()
        application_id = application.id

    monkeypatch.setattr(
        cleanup_issued_documents,
        "SessionLocal",
        lambda: Session(context["engine"], expire_on_commit=False),
    )
    root = issued_root(context["root"])
    key = f"{uuid4().hex}.pdf"
    path = root / key
    path.write_bytes(b"%PDF-1.4 unresolved commit")
    with Session(context["engine"]) as db:
        db.begin()
        application = db.scalar(
            select(Application).where(Application.id == application_id).with_for_update()
        )
        application.document_status = "ready"
        application.version += 1
        db.add(
            IssuedDocument(
                application_id=application_id,
                storage_key=key,
                filename="study_certificate.pdf",
                snapshot_data={"service_code": "study_certificate"},
            )
        )
        db.flush()
        with pytest.raises(OperationalError):
            cleanup_orphans(
                context["root"],
                cleanup_issued_documents.referenced_keys,
                older_than_seconds=0,
            )
        assert path.is_file()
        db.commit()

    assert (
        cleanup_orphans(
            context["root"],
            cleanup_issued_documents.referenced_keys,
            older_than_seconds=0,
        )
        == 0
    )
    assert path.is_file()
    _cleanup_application(context, application_id)


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


def test_filesystem_publication_failure_keeps_approval_and_retry_recovers(
    issue_context, monkeypatch
):
    from app.documents import issuer as issuer_module

    context = issue_context
    original_operation = issuer_module._run_issued_filesystem_operation

    def fail_publication(operation, *args, **kwargs):
        if operation == "render_publish":
            raise OSError("injected PDF publication failure")
        return original_operation(operation, *args, **kwargs)

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", fail_publication)
    token = _login(context)
    response = context["client"].request(
        "POST",
        "/api/v1/applications",
        access=token,
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
        history = db.scalars(
            select(ApplicationHistory).where(ApplicationHistory.application_id == identifier)
        ).all()
        assert len(history) == 2
        assert history[-1].to_status == "approved" and history[-1].actor_user_id is None
        assert (
            db.scalar(select(IssuedDocument.id).where(IssuedDocument.application_id == identifier))
            is None
        )
    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", original_operation)
    retry = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/retry", access=token
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["document_status"] == "ready"
    _cleanup_application(context, identifier)


def test_delete_failure_does_not_mask_failed_state_and_orphan_cleanup_recovers(
    issue_context, monkeypatch
):
    from app.documents import issuer as issuer_module

    context = issue_context
    original_operation = issuer_module._run_issued_filesystem_operation

    def fail_delete(operation, *args, **kwargs):
        if operation == "delete":
            raise OSError("injected delete fault")
        return original_operation(operation, *args, **kwargs)

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", fail_delete)
    raised = [False]

    def fail_insert(_connection, _cursor, statement, _parameters, _context, _many):
        if "insert into issued_documents" in statement.lower() and not raised[0]:
            raised[0] = True
            raise RuntimeError("injected INSERT failure")

    event.listen(context["engine"], "before_cursor_execute", fail_insert)
    token = _login(context)
    try:
        response = context["client"].request(
            "POST",
            "/api/v1/applications",
            access=token,
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "Вымышленное место"},
            },
        )
    finally:
        event.remove(context["engine"], "before_cursor_execute", fail_insert)
    assert response.status_code == 201, response.text
    identifier = int(response.json()["id"])
    assert response.json()["document_status"] == "failed"
    orphan_files = list((context["root"] / "issued_documents").glob("*.pdf"))
    assert len(orphan_files) == 1

    monkeypatch.setattr(issuer_module, "_run_issued_filesystem_operation", original_operation)
    retry = context["client"].request(
        "POST", f"/api/v1/applications/{identifier}/document/retry", access=token
    )
    assert retry.status_code == 200, retry.text
    document_key = retry.json()["document"]["id"]
    with Session(context["engine"]) as db:
        active_key = db.scalar(
            select(IssuedDocument.storage_key).where(IssuedDocument.application_id == identifier)
        )
    os.utime(orphan_files[0], (time.time() - 7200, time.time() - 7200))
    from app.documents.storage import cleanup_orphans

    removed = cleanup_orphans(
        context["root"],
        lambda: _issued_keys(context["engine"]),
        older_than_seconds=3600,
    )
    assert removed == 1
    assert not orphan_files[0].exists()
    assert (context["root"] / "issued_documents" / active_key).is_file()
    assert document_key == retry.json()["document"]["id"]
    _cleanup_application(context, identifier)


def test_cleanup_waits_for_pdf_commit_and_keeps_new_reference(issue_context, monkeypatch):
    from app.applications import storage as attachment_storage
    from app.documents.storage import cleanup_orphans

    context = issue_context
    original_lock = attachment_storage.coordination_lock
    root = context["root"] / "issued_documents"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    waiting_callers = 0
    callers_lock = threading.Lock()
    both_callers_waiting = threading.Event()

    def observed_lock(*args, **kwargs):
        nonlocal waiting_callers
        with callers_lock:
            waiting_callers += 1
            if waiting_callers == 2:
                both_callers_waiting.set()
        return original_lock(*args, **kwargs)

    holder = original_lock(root, timeout_seconds=5)
    holder.__enter__()
    monkeypatch.setattr(attachment_storage, "coordination_lock", observed_lock)
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
        cleanup = pool.submit(
            cleanup_orphans,
            context["root"],
            lambda: {key for key in _issued_keys(context["engine"])},
            older_than_seconds=0,
        )
        try:
            assert both_callers_waiting.wait(timeout=5)
        finally:
            holder.__exit__(None, None, None)
        response = generation.result(timeout=15)
        cleanup.result(timeout=15)
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


def test_legacy_automatic_application_survives_real_schema_upgrade(
    postgresql_engine, tmp_path, monkeypatch
):
    import os
    import subprocess
    import sys

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine

    from app.applications import router as application_router
    from app.auth.security import create_access_token
    from app.core.config import get_settings
    from app.dependencies.database import get_db_session
    from app.documents import issuer as issuer_module
    from app.models import AcademicTerm, OrgUnit, Program, StudyGroup

    database_name = f"uni_space_legacy_{uuid4().hex[:12]}"
    admin_url = postgresql_engine.url
    admin_engine = create_engine(admin_url)
    with admin_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database_name}"')
    legacy_url = admin_url.set(database=database_name)
    legacy_engine = create_engine(legacy_url)
    backend_directory = Path(__file__).resolve().parents[1]
    child_env = os.environ.copy()
    child_env.update(
        APP_ENV="test",
        DATABASE_URL=legacy_url.render_as_string(hide_password=False),
        JWT_SIGNING_KEY="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )

    def migrate(revision):
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", revision],
            cwd=backend_directory,
            env=child_env,
            check=True,
            capture_output=True,
            text=True,
        )

    try:
        migrate("20261116_09")
        suffix = uuid4().hex
        with Session(legacy_engine) as db, db.begin():
            faculty = OrgUnit(name=f"Legacy faculty {suffix}", type="faculty")
            db.add(faculty)
            db.flush()
            program = Program(
                code=suffix,
                name=f"Legacy program {suffix}",
                direction_code="00.00.00",
                direction_name="Fictional direction",
                faculty_id=faculty.id,
            )
            db.add(program)
            db.flush()
            group = StudyGroup(
                name=f"Legacy group {suffix}", program_id=program.id, course_number=1
            )
            term = AcademicTerm(
                name=f"Legacy term {suffix}",
                starts_on=datetime(2026, 9, 1).date(),
                ends_on=datetime(2027, 1, 31).date(),
            )
            owner = User(
                login=f"legacy-{suffix}",
                password_hash="fixture",
                full_name="Legacy Fictional Student",
                role="student",
                is_active=True,
            )
            db.add_all([group, term, owner])
            db.flush()
            student = Student(user_id=owner.id, group_id=group.id, academic_status="enrolled")
            db.add(student)
            db.flush()
            service = db.scalar(
                select(ServiceType).where(ServiceType.code == "academic_transcript")
            )
            application = Application(
                student_id=student.id,
                service_type_id=service.id,
                review_status="submitted",
                document_status="pending",
                form_data={
                    "academic_term_id": str(term.id),
                    "academic_term_name": term.name,
                    "starts_on": term.starts_on.isoformat(),
                    "ends_on": term.ends_on.isoformat(),
                },
                version=1,
            )
            db.add(application)
            db.flush()
            db.add(
                ApplicationHistory(
                    application_id=application.id,
                    actor_user_id=owner.id,
                    from_status=None,
                    to_status="submitted",
                    comment=None,
                )
            )
            auth_session = AuthSession(
                user_id=owner.id,
                created_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
            db.add(auth_session)
            db.flush()
            owner_token = create_access_token(auth_session, get_settings())["access_token"]
            application_id, owner_id, student_id = application.id, owner.id, student.id
            original_form = application.form_data.copy()
            original_term_id = application.form_data["academic_term_id"]

        # Upgrade the existing database, including its pre-#83 application row.
        migrate("head")
        with legacy_engine.connect() as connection:
            assert (
                connection.exec_driver_sql(
                    "SELECT to_regclass('public.issued_documents')"
                ).scalar_one()
                == "issued_documents"
            )

        class TestSettings:
            attachment_storage_path = str(tmp_path / "legacy-private-volume")

        monkeypatch.setattr(application_router, "get_settings", lambda: TestSettings())
        monkeypatch.setattr(issuer_module, "get_settings", lambda: TestSettings())
        monkeypatch.setattr(
            issuer_module,
            "SessionLocal",
            lambda: Session(legacy_engine, expire_on_commit=False),
        )
        app = FastAPI()
        app.include_router(application_router.router)

        def get_legacy_session():
            with Session(legacy_engine, expire_on_commit=False) as db:
                yield db

        app.dependency_overrides[get_db_session] = get_legacy_session
        try:
            from app.applications import service as workflow

            with Session(legacy_engine) as diagnostic_db:
                diagnostic_app = diagnostic_db.get(Application, application_id)
                diagnostic_student = diagnostic_db.get(Student, student_id)
                diagnostic_service = diagnostic_db.get(ServiceType, diagnostic_app.service_type_id)
                assert (
                    workflow.validate_and_store_form(
                        diagnostic_db,
                        diagnostic_service,
                        diagnostic_app.form_data,
                        student=diagnostic_student,
                        existing=diagnostic_app.form_data,
                    )[0]
                    == original_form
                )
            client = TestClient(app)
            headers = {"Authorization": f"Bearer {owner_token}"}
            processed = client.post(
                f"/api/v1/applications/{application_id}/document/process", headers=headers
            )
            assert processed.status_code == 200, processed.text
            assert (
                processed.json()["id"],
                processed.json()["review_status"],
                processed.json()["document_status"],
            ) == (str(application_id), "approved", "ready")
            document_id = processed.json()["document"]["id"]
            repeated = client.post(
                f"/api/v1/applications/{application_id}/document/process", headers=headers
            )
            assert repeated.status_code == 200
            assert repeated.json()["document"]["id"] == document_id
            with Session(legacy_engine) as db:
                migrated = db.get(Application, application_id)
                history = db.scalars(
                    select(ApplicationHistory)
                    .where(ApplicationHistory.application_id == application_id)
                    .order_by(ApplicationHistory.id)
                ).all()
                docs = db.scalars(
                    select(IssuedDocument).where(IssuedDocument.application_id == application_id)
                ).all()
                assert migrated.form_data == original_form
                assert migrated.form_data["academic_term_id"] == original_term_id
                assert migrated.review_status == "approved" and migrated.document_status == "ready"
                assert len(history) == 2
                assert history[0].to_status == "submitted" and history[0].actor_user_id == owner_id
                assert history[1].from_status == "submitted" and history[1].to_status == "approved"
                assert history[1].actor_user_id is None
                assert len(docs) == 1
                assert (
                    Path(TestSettings.attachment_storage_path)
                    / "issued_documents"
                    / docs[0].storage_key
                ).is_file()
        finally:
            app.dependency_overrides.clear()
    finally:
        legacy_engine.dispose()
        with admin_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            connection.exec_driver_sql(
                f'ALTER DATABASE "{database_name}" WITH ALLOW_CONNECTIONS false'
            )
            connection.exec_driver_sql(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
                (database_name,),
            )
            connection.exec_driver_sql(f'DROP DATABASE "{database_name}"')
        admin_engine.dispose()
