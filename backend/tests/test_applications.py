import json
from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, event, func, inspect, select, text
from sqlalchemy.orm import Session

from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import (
    AcademicTerm,
    Application,
    ApplicationHistory,
    AuthSession,
    CourseGroup,
    CourseOffering,
    Discipline,
    OrgUnit,
    Program,
    RefreshToken,
    ServiceType,
    Student,
    StudyGroup,
    User,
)


@pytest.mark.integration
def test_application_http_routes_use_real_bearer_authentication(postgresql_engine):
    """Exercise login, Bearer validation, role checks, and ownership without auth overrides."""
    from app.auth.security import PASSWORD_HASHER
    from app.main import app

    suffix = uuid4().hex
    password = "Task013-real-auth-test-password"
    session = Session(postgresql_engine, expire_on_commit=False)
    faculty = OrgUnit(name=f"Auth faculty {suffix}", type="faculty")
    session.add(faculty)
    session.flush()
    program = Program(
        code=suffix,
        name=suffix,
        direction_code=suffix,
        direction_name=suffix,
        faculty_id=faculty.id,
    )
    session.add(program)
    session.flush()
    group = StudyGroup(name=suffix, program_id=program.id, course_number=1)
    students = [
        User(
            login=f"task013-{suffix}-{index}",
            password_hash=PASSWORD_HASHER.hash(password),
            full_name=f"Task 013 Student {index}",
            role="student",
            is_active=True,
        )
        for index in range(2)
    ]
    teacher = User(
        login=f"task013-teacher-{suffix}",
        password_hash=PASSWORD_HASHER.hash(password),
        full_name="Task 013 Teacher",
        role="teacher",
        is_active=True,
    )
    session.add_all([group, *students, teacher])
    session.flush()
    student_rows = [
        Student(user_id=user.id, group_id=group.id, academic_status="enrolled") for user in students
    ]
    session.add_all(student_rows)
    session.commit()

    origin = {"Origin": "http://localhost:5173"}
    created_ids = []
    try:
        with TestClient(app) as anonymous:
            for path, method, payload in (
                ("/api/v1/services", "get", None),
                ("/api/v1/applications", "get", None),
                ("/api/v1/applications/1", "get", None),
                (
                    "/api/v1/applications",
                    "post",
                    {
                        "service_code": "study_certificate",
                        "form_data": {"place_of_submission": "X"},
                    },
                ),
            ):
                assert (
                    getattr(anonymous, method)(
                        path, **({"json": payload} if payload else {})
                    ).status_code
                    == 401
                )
                assert (
                    getattr(anonymous, method)(
                        path,
                        headers={"Authorization": "Bearer invalid"},
                        **({"json": payload} if payload else {}),
                    ).status_code
                    == 401
                )
            assert anonymous.get("/api/v1/services?unexpected=1").status_code == 401

        for index, user in enumerate(students):
            with TestClient(app) as client:
                login = client.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": user.login, "password": password},
                )
                assert login.status_code == 200
                token = login.json()["access_token"]
                catalog_headers = {"Authorization": f"Bearer {token}"}
                catalog = client.get("/api/v1/services", headers=catalog_headers)
                assert catalog.status_code == 200
                assert {item["code"] for item in catalog.json()["items"]} == {
                    "study_certificate",
                    "academic_transcript",
                    "academic_leave",
                    "accounting_certificate",
                }
                for query, field in (
                    ("unexpected=1", "unexpected"),
                    ("student_id=999", "student_id"),
                    ("unexpected=1&unexpected=2", "unexpected"),
                ):
                    rejected = client.get(f"/api/v1/services?{query}", headers=catalog_headers)
                    assert rejected.status_code == 422, query
                    assert rejected.json()["error"] == {
                        "code": "validation_error",
                        "message": "Проверьте введённые данные",
                        "details": [{"field": field, "code": "invalid_value"}],
                    }
                response = client.post(
                    "/api/v1/applications",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "service_code": "study_certificate",
                        "form_data": {"place_of_submission": f"Заявление {user.login} — 東京"},
                    },
                )
                assert response.status_code == 201
                created_ids.append(int(response.json()["id"]))
                assert (
                    response.headers["location"] == f"/api/v1/applications/{response.json()['id']}"
                )

                for payload in (
                    {
                        "service_code": "study_certificate",
                        "form_data": {"place_of_submission": "X"},
                        "student_id": str(student_rows[0].id),
                        "review_status": "approved",
                        "document_status": "ready",
                        "feedback": "forged",
                        "version": 99,
                        "created_at": "2020-01-01T00:00:00Z",
                        "updated_at": "2020-01-01T00:00:00Z",
                        "assigned_org_unit_id": 1,
                        "reviewer_user_id": 1,
                    },
                ):
                    rejected = client.post(
                        "/api/v1/applications",
                        headers={"Authorization": f"Bearer {token}"},
                        json=payload,
                    )
                    assert rejected.status_code == 422

                if index == 0:
                    student_headers = {"Authorization": f"Bearer {token}"}
                    existing_count = session.scalar(
                        select(func.count()).where(Application.student_id == student_rows[0].id)
                    )
                    for surrogate in ("\ud800", "\udc00"):
                        body = json.dumps(
                            {
                                "service_code": "study_certificate",
                                "form_data": {"place_of_submission": surrogate},
                            },
                            ensure_ascii=True,
                        )
                        rejected = client.post(
                            "/api/v1/applications",
                            content=body,
                            headers={
                                **student_headers,
                                "Content-Type": "application/json",
                            },
                        )
                        assert rejected.status_code == 422
                        assert rejected.json()["error"]["details"] == [
                            {
                                "field": "form_data.place_of_submission",
                                "code": "invalid_value",
                            }
                        ]
                        session.expire_all()
                        assert (
                            session.scalar(
                                select(func.count()).where(
                                    Application.student_id == student_rows[0].id
                                )
                            )
                            == existing_count
                        )

                    valid_pair_body = json.dumps(
                        {
                            "service_code": "study_certificate",
                            "form_data": {"place_of_submission": "\ud83d\ude00"},
                        },
                        ensure_ascii=True,
                    )
                    valid_pair = client.post(
                        "/api/v1/applications",
                        content=valid_pair_body,
                        headers={
                            **student_headers,
                            "Content-Type": "application/json",
                        },
                    )
                    assert valid_pair.status_code == 201
                    assert valid_pair.json()["form_data"]["place_of_submission"] == "😀"
                    assert valid_pair.headers["location"] == (
                        f"/api/v1/applications/{valid_pair.json()['id']}"
                    )
                    created_ids.append(int(valid_pair.json()["id"]))
                    session.expire_all()
                    assert (
                        session.scalar(
                            select(func.count()).where(Application.student_id == student_rows[0].id)
                        )
                        == existing_count + 1
                    )

        # Re-login with a fresh session and verify persistence and cross-student isolation.
        for index, user in enumerate(students):
            with TestClient(app) as reader:
                login = reader.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": user.login, "password": password},
                )
                headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
                page = reader.get("/api/v1/applications", headers=headers)
                assert page.status_code == 200
                expected = created_ids[:2] if index == 0 else created_ids[2:]
                assert {item["id"] for item in page.json()["items"]} == {str(i) for i in expected}
                for application_id in expected:
                    assert (
                        reader.get(
                            f"/api/v1/applications/{application_id}", headers=headers
                        ).status_code
                        == 200
                    )
                foreign_id = created_ids[2] if index == 0 else created_ids[0]
                foreign = reader.get(f"/api/v1/applications/{foreign_id}", headers=headers)
                missing = reader.get("/api/v1/applications/9223372036854775807", headers=headers)
                assert foreign.status_code == missing.status_code == 404
                assert foreign.json() == missing.json()
                assert (
                    reader.post("/api/v1/auth/logout", headers={**origin, **headers}).status_code
                    == 200
                )
                assert reader.get("/api/v1/applications", headers=headers).status_code == 401

        with TestClient(app) as teacher_client:
            teacher_login = teacher_client.post(
                "/api/v1/auth/login",
                headers=origin,
                json={"login": teacher.login, "password": password},
            )
            assert teacher_login.status_code == 200
            teacher_headers = {"Authorization": f"Bearer {teacher_login.json()['access_token']}"}
            for path in ("/api/v1/services", "/api/v1/applications", "/api/v1/applications/1"):
                assert teacher_client.get(path, headers=teacher_headers).status_code == 403
            assert (
                teacher_client.get(
                    "/api/v1/services?unexpected=1", headers=teacher_headers
                ).status_code
                == 403
            )
            assert (
                teacher_client.post(
                    "/api/v1/applications",
                    headers=teacher_headers,
                    json={
                        "service_code": "study_certificate",
                        "form_data": {"place_of_submission": "X"},
                    },
                ).status_code
                == 403
            )

        session.expire_all()
        rows = [session.get(Application, app_id) for app_id in created_ids]
        assert [row.student_id for row in rows] == [
            student_rows[0].id,
            student_rows[0].id,
            student_rows[1].id,
        ]
        assert [row.form_data["place_of_submission"] for row in rows] == [
            f"Заявление {students[0].login} — 東京",
            "😀",
            f"Заявление {students[1].login} — 東京",
        ]
    finally:
        if created_ids:
            session.query(Application).filter(Application.id.in_(created_ids)).delete(
                synchronize_session=False
            )
        user_ids = [user.id for user in students] + [teacher.id]
        session.execute(
            delete(RefreshToken).where(
                RefreshToken.session_id.in_(
                    select(AuthSession.id).where(AuthSession.user_id.in_(user_ids))
                )
            )
        )
        session.execute(delete(AuthSession).where(AuthSession.user_id.in_(user_ids)))
        session.query(Student).filter(Student.user_id.in_([user.id for user in students])).delete(
            synchronize_session=False
        )
        session.query(User).filter(
            User.id.in_([user.id for user in students] + [teacher.id])
        ).delete(synchronize_session=False)
        session.query(StudyGroup).filter_by(id=group.id).delete(synchronize_session=False)
        session.query(Program).filter_by(id=program.id).delete(synchronize_session=False)
        session.query(OrgUnit).filter_by(id=faculty.id).delete(synchronize_session=False)
        session.commit()
        session.close()


def test_form_data_trims_text_and_rejects_blank_or_oversized_values():
    from app.applications.schemas import ApplicationFormData

    assert (
        ApplicationFormData(place_of_submission="  Приёмная\nкомиссия  ").place_of_submission
        == "Приёмная\nкомиссия"
    )
    assert ApplicationFormData(place_of_submission=" x ").place_of_submission == "x"
    assert len(ApplicationFormData(place_of_submission="я" * 300).place_of_submission) == 300
    assert len(ApplicationFormData(place_of_submission="А" * 299 + "😀").place_of_submission) == 300
    for value in [" \n ", "x" * 301, 3, None]:
        with pytest.raises(ValueError):
            ApplicationFormData(place_of_submission=value)
    with pytest.raises(ValueError):
        ApplicationFormData(place_of_submission="valid\x00text")


@pytest.mark.integration
def test_application_submission_is_owned_and_returns_location_and_server_state(
    db_session, monkeypatch, tmp_path
):
    from contextlib import nullcontext

    from app.applications import router as applications_router
    from app.core.config import get_settings
    from app.documents import issuer

    settings = get_settings().model_copy(update={"attachment_storage_path": str(tmp_path)})
    monkeypatch.setattr(applications_router, "get_settings", lambda: settings)
    monkeypatch.setattr(applications_router, "SessionLocal", lambda: nullcontext(db_session))
    monkeypatch.setattr(issuer, "get_settings", lambda: settings)
    monkeypatch.setattr(issuer, "SessionLocal", lambda: nullcontext(db_session))
    from app.main import app

    suffix = "task013-test"
    faculty = OrgUnit(name=f"Faculty {suffix}", type="faculty")
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
    user = User(
        login=suffix, password_hash="fixture", full_name=suffix, role="student", is_active=True
    )
    db_session.add_all([group, user])
    db_session.flush()
    student = Student(user_id=user.id, group_id=group.id, academic_status="enrolled")
    db_session.add(student)
    db_session.flush()
    service = db_session.scalar(select(ServiceType).where(ServiceType.code == "study_certificate"))
    assert service is not None

    app.dependency_overrides[get_db_session] = lambda: db_session
    current_student = [student]
    app.dependency_overrides[get_current_student] = lambda: current_student[0]
    try:
        db_session.add(
            ServiceType(
                code="future_service",
                title="Unsupported service",
                processing_mode="manual",
                produces_document=False,
            )
        )
        db_session.flush()
        response = TestClient(app).post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "  Отдел\n№ 2 — 東京  "},
            },
        )
        assert response.status_code == 201
        body = response.json()
        assert response.headers["location"] == f"/api/v1/applications/{body['id']}"
        assert body["form_data"]["place_of_submission"] == "Отдел\n№ 2 — 東京"
        assert body["review_status"] == "approved"
        assert body["document_status"] == "ready"
        assert body["feedback"] is None
        assert db_session.get(Application, int(body["id"])).student_id == student.id
        assert db_session.get(Application, int(body["id"])).version == 3

        accepted_unicode_limit = TestClient(app).post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "А" * 299 + "😀"},
            },
        )
        assert accepted_unicode_limit.status_code == 201
        assert len(accepted_unicode_limit.json()["form_data"]["place_of_submission"]) == 300
        for rejected_value in ("А" * 300 + "😀", "valid\x00text"):
            rejected = TestClient(app).post(
                "/api/v1/applications",
                json={
                    "service_code": "study_certificate",
                    "form_data": {"place_of_submission": rejected_value},
                },
            )
            assert rejected.status_code == 422
            assert rejected.json()["error"]["code"] == "validation_error"
            assert rejected.json()["error"]["details"] == [
                {"field": "form_data.place_of_submission", "code": "invalid_value"}
            ]

        catalog = TestClient(app).get("/api/v1/services")
        assert catalog.status_code == 200
        assert {item["code"] for item in catalog.json()["items"]} == {
            "study_certificate",
            "academic_transcript",
            "academic_leave",
            "accounting_certificate",
        }

        forged = TestClient(app).post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "X"},
                "student_id": "999",
                "review_status": "approved",
            },
        )
        assert forged.status_code == 422
        nested_extra = TestClient(app).post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "X", "is_admin": True},
            },
        )
        assert nested_extra.status_code == 422

        def fail_before_commit(_session):
            raise RuntimeError("test transaction failure")

        event.listen(db_session, "before_commit", fail_before_commit)
        failed_commit = TestClient(app).post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "Rollback me"},
            },
        )
        event.remove(db_session, "before_commit", fail_before_commit)
        assert failed_commit.status_code == 500
        assert db_session.query(Application).filter_by(student_id=student.id).count() == 2

        second_user = User(
            login=f"{suffix}-second",
            password_hash="fixture",
            full_name=f"Second {suffix}",
            role="student",
            is_active=True,
        )
        db_session.add(second_user)
        db_session.flush()
        second_student = Student(
            user_id=second_user.id,
            group_id=group.id,
            academic_status="enrolled",
        )
        db_session.add(second_student)
        db_session.flush()
        current_student[0] = second_student
        second_response = TestClient(app).post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "Second student"},
            },
        )
        assert second_response.status_code == 201
        assert (
            db_session.get(Application, int(second_response.json()["id"])).student_id
            == second_student.id
        )
        assert db_session.query(Application).filter_by(student_id=student.id).count() == 2
        assert db_session.query(Application).filter_by(student_id=second_student.id).count() == 1
        current_student[0] = student

        again = TestClient(app).post(
            "/api/v1/applications",
            json={"service_code": "not-a-service", "form_data": {"place_of_submission": "X"}},
        )
        assert again.status_code == 422
        assert db_session.query(Application).filter_by(student_id=student.id).count() == 2
    finally:
        app.dependency_overrides.pop(get_db_session, None)
        app.dependency_overrides.pop(get_current_student, None)


@pytest.mark.integration
def test_service_catalog_seed_is_unique_and_application_indexes_exist(db_session):
    assert db_session.query(ServiceType).filter_by(code="study_certificate").count() == 1
    indexes = {index["name"] for index in inspect(db_session.bind).get_indexes("applications")}
    assert "ix_applications_student_id_created_at" in indexes
    assert "ix_applications_assigned_org_unit_id_review_status" in indexes


@pytest.mark.integration
def test_application_routes_work_with_minimal_postgresql_role(
    postgresql_engine, monkeypatch, tmp_path
):
    from app.main import app

    role = "uni_space_api"
    password = "test-only-task013-limited-role"
    suffix = f"task013-limited-role-{uuid4().hex}"
    with postgresql_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        role_exists = connection.execute(
            text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:role)"),
            {"role": role},
        ).scalar_one()
        if role_exists:
            connection.execute(text(f"DROP OWNED BY {role}"))
            connection.execute(text(f"DROP ROLE {role}"))
        connection.execute(
            text(
                f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                f"PASSWORD '{password}'"
            )
        )
        connection.execute(text(f"GRANT CONNECT ON DATABASE uni_space_test TO {role}"))
        connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
        connection.execute(text(f"GRANT SELECT ON service_types TO {role}"))
        connection.execute(text(f"GRANT SELECT ON application_attachments TO {role}"))
        connection.execute(text(f"GRANT SELECT ON issued_documents, users, students TO {role}"))
        connection.execute(
            text(f"GRANT SELECT ON academic_terms, org_units, programs, study_groups TO {role}")
        )
        connection.execute(text(f"GRANT SELECT ON course_offerings, course_groups TO {role}"))
        connection.execute(text(f"GRANT SELECT, INSERT ON applications TO {role}"))
        connection.execute(
            text(
                f"GRANT UPDATE (review_status, document_status, updated_at, version) "
                f"ON applications TO {role}"
            )
        )
        connection.execute(text(f"GRANT USAGE ON SEQUENCE applications_id_seq TO {role}"))
        connection.execute(
            text(
                f"GRANT INSERT (application_id, storage_key, filename, snapshot_data) "
                f"ON issued_documents TO {role}"
            )
        )
        connection.execute(text(f"GRANT USAGE ON SEQUENCE issued_documents_id_seq TO {role}"))
        connection.execute(text(f"GRANT SELECT, INSERT ON application_history TO {role}"))
        connection.execute(text(f"GRANT USAGE ON SEQUENCE application_history_id_seq TO {role}"))

    admin = Session(postgresql_engine, expire_on_commit=False)
    api_engine = None
    student = user = group = program = faculty = None
    try:
        faculty = OrgUnit(name=suffix, type="faculty")
        admin.add(faculty)
        admin.flush()
        program = Program(
            code=suffix,
            name=suffix,
            direction_code=suffix,
            direction_name=suffix,
            faculty_id=faculty.id,
        )
        admin.add(program)
        admin.flush()
        group = StudyGroup(name=suffix, program_id=program.id, course_number=1)
        user = User(
            login=suffix,
            password_hash="fixture",
            full_name=suffix,
            role="student",
            is_active=True,
        )
        admin.add_all([group, user])
        admin.flush()
        student = Student(user_id=user.id, group_id=group.id, academic_status="enrolled")
        admin.add(student)
        admin.commit()

        api_url = postgresql_engine.url.set(username=role, password=password)
        api_engine = create_engine(api_url)
        from app.applications import router as applications_router
        from app.core.config import get_settings
        from app.documents import issuer

        settings = get_settings().model_copy(update={"attachment_storage_path": str(tmp_path)})
        monkeypatch.setattr(applications_router, "get_settings", lambda: settings)
        monkeypatch.setattr(issuer, "get_settings", lambda: settings)
        monkeypatch.setattr(applications_router, "SessionLocal", lambda: Session(api_engine))
        monkeypatch.setattr(issuer, "SessionLocal", lambda: Session(api_engine))

        def get_api_session():
            with Session(api_engine) as api_session:
                yield api_session

        app.dependency_overrides[get_db_session] = get_api_session
        app.dependency_overrides[get_current_student] = lambda: student
        client = TestClient(app)
        catalog = client.get("/api/v1/services")
        assert catalog.status_code == 200
        assert "study_certificate" in {item["code"] for item in catalog.json()["items"]}
        response = client.post(
            "/api/v1/applications",
            json={
                "service_code": "study_certificate",
                "form_data": {"place_of_submission": "Registry"},
            },
        )
        assert response.status_code == 201
        assert response.headers["location"] == f"/api/v1/applications/{response.json()['id']}"
        assert client.get("/api/v1/applications").json()["items"] == [response.json()]
        assert client.get(response.headers["location"]).json() == response.json()
        with postgresql_engine.connect() as connection:
            assert not connection.execute(
                text("SELECT has_table_privilege(:role, 'applications', 'UPDATE')"),
                {"role": role},
            ).scalar_one()
            assert not connection.execute(
                text("SELECT has_table_privilege(:role, 'applications', 'DELETE')"),
                {"role": role},
            ).scalar_one()
    finally:
        app.dependency_overrides.pop(get_db_session, None)
        app.dependency_overrides.pop(get_current_student, None)
        if api_engine is not None:
            api_engine.dispose()
        if student is not None:
            admin.execute(delete(Application).where(Application.student_id == student.id))
            admin.delete(student)
            admin.flush()
            admin.delete(user)
            admin.delete(group)
            admin.flush()
            admin.delete(program)
            admin.flush()
            admin.delete(faculty)
            admin.commit()
        else:
            admin.rollback()
        admin.close()
        with postgresql_engine.connect().execution_options(
            isolation_level="AUTOCOMMIT"
        ) as connection:
            connection.execute(text(f"DROP OWNED BY {role}"))
            connection.execute(text(f"DROP ROLE IF EXISTS {role}"))


@pytest.mark.integration
def test_mvp2_service_forms_fix_server_term_and_responsible_units(
    db_session, monkeypatch, tmp_path
):
    from contextlib import nullcontext

    from app.applications import router as applications_router
    from app.core.config import get_settings
    from app.documents import issuer

    settings = get_settings().model_copy(update={"attachment_storage_path": str(tmp_path)})
    monkeypatch.setattr(applications_router, "get_settings", lambda: settings)
    monkeypatch.setattr(applications_router, "SessionLocal", lambda: nullcontext(db_session))
    monkeypatch.setattr(issuer, "get_settings", lambda: settings)
    monkeypatch.setattr(issuer, "SessionLocal", lambda: nullcontext(db_session))
    from fastapi.testclient import TestClient

    from app.applications.service import resolve_dean_office, validate_and_store_form
    from app.dependencies.auth import get_current_student
    from app.dependencies.database import get_db_session
    from app.main import app

    today = datetime.now(ZoneInfo("Europe/Moscow")).date()
    faculty = OrgUnit(name=f"MVP2 forms faculty {uuid4().hex}", type="faculty")
    db_session.add(faculty)
    db_session.flush()
    program = Program(
        code=f"mvp2-{uuid4().hex}",
        name="Forms program",
        direction_code="00.00.00",
        direction_name="Forms",
        faculty_id=faculty.id,
    )
    db_session.add(program)
    db_session.flush()
    group = StudyGroup(
        name=f"MVP2 forms group {uuid4().hex}", program_id=program.id, course_number=1
    )
    user = User(
        login=f"mvp2-forms-{uuid4().hex}",
        password_hash="fixture",
        full_name="Fictional",
        role="student",
        is_active=True,
    )
    db_session.add_all([group, user])
    db_session.flush()
    student = Student(user_id=user.id, group_id=group.id, academic_status="enrolled")
    db_session.add(student)
    dean = OrgUnit(name=f"MVP2 forms dean {uuid4().hex}", type="dean_office", parent_id=faculty.id)
    accounting = OrgUnit(name=f"MVP2 forms accounting {uuid4().hex}", type="accounting")
    db_session.add_all([dean, accounting])
    db_session.flush()
    transcript_service = db_session.scalar(
        select(ServiceType).where(ServiceType.code == "academic_transcript")
    )
    accounting_service = db_session.scalar(
        select(ServiceType).where(ServiceType.code == "accounting_certificate")
    )
    leave_service = db_session.scalar(
        select(ServiceType).where(ServiceType.code == "academic_leave")
    )
    assert transcript_service and accounting_service and leave_service
    accounting_service.responsible_org_unit_id = accounting.id
    assert resolve_dean_office(db_session, student).id == dean.id

    app.dependency_overrides[get_db_session] = lambda: db_session
    active_student = [student]
    app.dependency_overrides[get_current_student] = lambda: active_student[0]
    client = TestClient(app)
    before = db_session.scalar(select(func.count()).select_from(Application))
    try:
        no_term = client.post(
            "/api/v1/applications", json={"service_code": "academic_transcript", "form_data": {}}
        )
        assert no_term.status_code == 409
        spoofed = client.post(
            "/api/v1/applications",
            json={"service_code": "academic_transcript", "form_data": {"academic_term_id": "1"}},
        )
        assert spoofed.status_code == 422
        assert db_session.scalar(select(func.count()).select_from(Application)) == before

        # A global current term is not available until the student's group is linked to it.
        first_term = AcademicTerm(
            name="Current forms term",
            starts_on=today - timedelta(days=1),
            ends_on=today + timedelta(days=1),
        )
        db_session.add(first_term)
        db_session.flush()
        empty_catalog = client.get("/api/v1/services")
        assert (
            next(
                item
                for item in empty_catalog.json()["items"]
                if item["code"] == "academic_transcript"
            )["action_available"]
            is False
        )
        discipline = Discipline(name=f"Forms {uuid4().hex}")
        db_session.add(discipline)
        db_session.flush()
        offering = CourseOffering(
            discipline_id=discipline.id, term_id=first_term.id, attestation_type="exam"
        )
        db_session.add(offering)
        db_session.flush()
        db_session.add(CourseGroup(course_offering_id=offering.id, group_id=group.id))
        db_session.flush()
        available_catalog = client.get("/api/v1/services")
        assert (
            next(
                item
                for item in available_catalog.json()["items"]
                if item["code"] == "academic_transcript"
            )["action_available"]
            is True
        )
        other_term = AcademicTerm(
            name="Another student's current term",
            starts_on=today - timedelta(days=2),
            ends_on=today + timedelta(days=2),
        )
        other_group = StudyGroup(
            name=f"MVP2 other group {uuid4().hex}", program_id=program.id, course_number=1
        )
        other_user = User(
            login=f"mvp2-other-{uuid4().hex}",
            password_hash="fixture",
            full_name="Other fictional student",
            role="student",
            is_active=True,
        )
        db_session.add_all([other_term, other_group, other_user])
        db_session.flush()
        other_student = Student(
            user_id=other_user.id, group_id=other_group.id, academic_status="enrolled"
        )
        other_offering = CourseOffering(
            discipline_id=discipline.id, term_id=other_term.id, attestation_type="exam"
        )
        db_session.add_all([other_student, other_offering])
        db_session.flush()
        db_session.add(CourseGroup(course_offering_id=other_offering.id, group_id=other_group.id))
        db_session.flush()
        active_student[0] = other_student
        other_transcript = client.post(
            "/api/v1/applications",
            json={"service_code": "academic_transcript", "form_data": {}},
        )
        assert other_transcript.status_code == 201, other_transcript.text
        assert other_transcript.json()["form_data"]["academic_term_id"] == str(other_term.id)
        active_student[0] = student
        ambiguous_term = AcademicTerm(
            name="Ambiguous current forms term",
            starts_on=today,
            ends_on=today + timedelta(days=2),
        )
        db_session.add(ambiguous_term)
        db_session.flush()
        second_offering = CourseOffering(
            discipline_id=discipline.id,
            term_id=ambiguous_term.id,
            attestation_type="exam",
        )
        db_session.add(second_offering)
        db_session.flush()
        db_session.add(CourseGroup(course_offering_id=second_offering.id, group_id=group.id))
        db_session.flush()
        ambiguous = client.post(
            "/api/v1/applications",
            json={"service_code": "academic_transcript", "form_data": {}},
        )
        assert ambiguous.status_code == 409
        assert ambiguous.json()["error"]["code"] == "academic_term_ambiguous"
        db_session.delete(db_session.get(CourseGroup, (second_offering.id, group.id)))
        db_session.flush()
        transcript = client.post(
            "/api/v1/applications", json={"service_code": "academic_transcript", "form_data": {}}
        )
        assert transcript.status_code == 201, transcript.text
        saved_form = transcript.json()["form_data"]
        assert saved_form["academic_term_name"] == "Current forms term"
        assert saved_form["starts_on"] == (today - timedelta(days=1)).isoformat()
        saved_application = db_session.get(Application, int(transcript.json()["id"]))
        assert saved_application.form_data == saved_form
        assert saved_application.document_status == "ready"
        saved_term = db_session.get(AcademicTerm, int(saved_form["academic_term_id"]))
        saved_term.starts_on = today - timedelta(days=3)
        saved_term.ends_on = today - timedelta(days=2)
        preserved, _ = validate_and_store_form(
            db_session, transcript_service, {}, student=student, existing=saved_form
        )
        assert preserved == saved_form
        saved_application.review_status = "needs_correction"
        saved_application.feedback = "Please confirm details"
        saved_application.version = 2
        db_session.add(
            ApplicationHistory(
                application_id=saved_application.id,
                actor_user_id=student.user_id,
                from_status="in_review",
                to_status="needs_correction",
                comment="Please confirm details",
            )
        )
        db_session.commit()
        db_session.refresh(saved_application)
        history_count = db_session.scalar(
            select(func.count())
            .select_from(ApplicationHistory)
            .where(ApplicationHistory.application_id == saved_application.id)
        )
        automatic_resubmit = client.post(
            f"/api/v1/applications/{saved_application.id}/resubmit",
            json={"expected_version": 2, "form_data": {}},
        )
        assert automatic_resubmit.status_code == 409
        assert automatic_resubmit.json()["error"]["code"] == "invalid_transition"
        assert saved_application.form_data == saved_form
        assert (
            db_session.scalar(
                select(func.count())
                .select_from(ApplicationHistory)
                .where(ApplicationHistory.application_id == saved_application.id)
            )
            == history_count
        )
        assert saved_application.version == 2

        accounting_response = client.post(
            "/api/v1/applications",
            json={"service_code": "accounting_certificate", "form_data": {"purpose": "For study"}},
        )
        assert accounting_response.status_code == 201, accounting_response.text
        accounting_application = db_session.get(Application, int(accounting_response.json()["id"]))
        assert accounting_application.assigned_org_unit_id == accounting.id
        assert accounting_application.document_status == "pending"
        accounting_application.review_status = "needs_correction"
        accounting_application.feedback = "Please clarify purpose"
        accounting_application.version = 2
        db_session.add(
            ApplicationHistory(
                application_id=accounting_application.id,
                actor_user_id=student.user_id,
                from_status="in_review",
                to_status="needs_correction",
                comment="Please clarify purpose",
            )
        )
        db_session.commit()
        db_session.refresh(accounting_application)
        accounting_history_count = db_session.scalar(
            select(func.count())
            .select_from(ApplicationHistory)
            .where(ApplicationHistory.application_id == accounting_application.id)
        )
        malformed_resubmit = client.post(
            f"/api/v1/applications/{accounting_application.id}/resubmit",
            json={
                "expected_version": 2,
                "form_data": {"purpose": "Updated", "assigned_org_unit_id": accounting.id},
            },
        )
        assert malformed_resubmit.status_code == 422
        assert accounting_application.form_data == {"purpose": "For study"}
        assert (
            db_session.scalar(
                select(func.count())
                .select_from(ApplicationHistory)
                .where(ApplicationHistory.application_id == accounting_application.id)
            )
            == accounting_history_count
        )
        resubmitted = client.post(
            f"/api/v1/applications/{accounting_application.id}/resubmit",
            json={"expected_version": 2, "form_data": {"purpose": "Updated purpose"}},
        )
        assert resubmitted.status_code == 200, resubmitted.text
        assert resubmitted.json()["id"] == accounting_response.json()["id"]
        assert resubmitted.json()["version"] == 3
        assert resubmitted.json()["form_data"] == {"purpose": "Updated purpose"}
        assert (
            db_session.scalar(
                select(func.count())
                .select_from(ApplicationHistory)
                .where(ApplicationHistory.application_id == accounting_application.id)
            )
            == accounting_history_count + 1
        )
        stale_accounting_resubmit = client.post(
            f"/api/v1/applications/{accounting_application.id}/resubmit",
            json={"expected_version": 2, "form_data": {"purpose": "Late update"}},
        )
        assert stale_accounting_resubmit.status_code == 409
        assert stale_accounting_resubmit.json()["error"]["code"] == "version_conflict"
        assert accounting_application.form_data == {"purpose": "Updated purpose"}
        assert (
            db_session.scalar(
                select(func.count())
                .select_from(ApplicationHistory)
                .where(ApplicationHistory.application_id == accounting_application.id)
            )
            == accounting_history_count + 1
        )

        duplicate_dean = OrgUnit(
            name=f"MVP2 forms second dean {uuid4().hex}", type="dean_office", parent_id=faculty.id
        )
        db_session.add(duplicate_dean)
        db_session.flush()
        assert resolve_dean_office(db_session, student) is None

        leave_response = client.post(
            "/api/v1/applications",
            json={
                "service_code": "academic_leave",
                "form_data": {
                    "basis": "medical",
                    "starts_on": today.isoformat(),
                    "ends_on": today.isoformat(),
                },
            },
        )
        assert leave_response.status_code == 409
        assert leave_response.json()["error"]["code"] == "responsible_unit_unavailable"
        assert db_session.scalar(select(func.count()).select_from(Application)) == before + 3
    finally:
        app.dependency_overrides.pop(get_db_session, None)
        app.dependency_overrides.pop(get_current_student, None)
