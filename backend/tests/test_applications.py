import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, event, func, inspect, select, text
from sqlalchemy.orm import Session

from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import (
    Application,
    AuthSession,
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
                assert [item["code"] for item in catalog.json()["items"]] == ["study_certificate"]
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
def test_application_submission_is_owned_and_returns_location_and_server_state(db_session):
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
        assert body["review_status"] == "submitted"
        assert body["document_status"] == "pending"
        assert body["feedback"] is None
        assert db_session.get(Application, int(body["id"])).student_id == student.id
        assert db_session.get(Application, int(body["id"])).version == 1

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
        assert [item["code"] for item in catalog.json()["items"]] == ["study_certificate"]

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
def test_application_routes_work_with_minimal_postgresql_role(postgresql_engine):
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
        connection.execute(text(f"GRANT SELECT, INSERT ON applications TO {role}"))
        connection.execute(text(f"GRANT USAGE ON SEQUENCE applications_id_seq TO {role}"))

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

        def get_api_session():
            with Session(api_engine) as api_session:
                yield api_session

        app.dependency_overrides[get_db_session] = get_api_session
        app.dependency_overrides[get_current_student] = lambda: student
        client = TestClient(app)
        catalog = client.get("/api/v1/services")
        assert catalog.status_code == 200
        assert catalog.json()["items"][0]["code"] == "study_certificate"
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
