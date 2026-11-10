from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, event, inspect, select, text
from sqlalchemy.orm import Session

from app.dependencies.auth import get_current_student
from app.dependencies.database import get_db_session
from app.models import Application, OrgUnit, Program, ServiceType, Student, StudyGroup, User


def test_form_data_trims_text_and_rejects_blank_or_oversized_values():
    from app.applications.schemas import ApplicationFormData

    assert (
        ApplicationFormData(place_of_submission="  Приёмная\nкомиссия  ").place_of_submission
        == "Приёмная\nкомиссия"
    )
    assert ApplicationFormData(place_of_submission=" x ").place_of_submission == "x"
    assert len(ApplicationFormData(place_of_submission="я" * 300).place_of_submission) == 300
    for value in [" \n ", "x" * 301, 3, None]:
        with pytest.raises(ValueError):
            ApplicationFormData(place_of_submission=value)


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
        assert db_session.query(Application).filter_by(student_id=student.id).count() == 1

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
        assert db_session.query(Application).filter_by(student_id=student.id).count() == 1
        assert db_session.query(Application).filter_by(student_id=second_student.id).count() == 1
        current_student[0] = student

        again = TestClient(app).post(
            "/api/v1/applications",
            json={"service_code": "not-a-service", "form_data": {"place_of_submission": "X"}},
        )
        assert again.status_code == 422
        assert db_session.query(Application).filter_by(student_id=student.id).count() == 1
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

    role = "uni_space_api_task013"
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
