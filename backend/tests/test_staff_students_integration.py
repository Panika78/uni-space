from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.auth.security import create_access_token
from app.core.config import Settings
from app.core.errors import install_exception_handlers
from app.core.middleware import ApiHeadersMiddleware
from app.dependencies.database import get_db_session
from app.models import (
    AuditEvent,
    AuthSession,
    OrgUnit,
    Program,
    StaffPermission,
    StaffProfile,
    Student,
    StudyGroup,
    User,
)
from app.permissions import PermissionCode
from app.staff_students import router

pytestmark = pytest.mark.integration


@pytest.fixture
def staff_students(db_session):
    db = db_session
    faculty = OrgUnit(name="Факультет вымышленный", type="faculty")
    db.add(faculty)
    db.flush()
    program = Program(
        code="fixture",
        name="Тестовая программа",
        direction_code="00",
        direction_name="Вымышленное направление",
        faculty_id=faculty.id,
    )
    other_faculty = OrgUnit(name="Другой факультет", type="faculty")
    db.add_all([program, other_faculty])
    db.flush()
    other_program = Program(
        code="other",
        name="Другая программа",
        direction_code="01",
        direction_name="Другое",
        faculty_id=other_faculty.id,
    )
    db.add(other_program)
    db.flush()
    groups = [
        StudyGroup(name="ИВТ-21", program_id=program.id, course_number=2),
        StudyGroup(name="ИВТ-31", program_id=program.id, course_number=3),
        StudyGroup(name="ФИЛ-11", program_id=other_program.id, course_number=1),
    ]
    db.add_all(groups)
    db.flush()
    names = ["Елена Тестовая", "Ёлкина Тестовая", "Жуков Тестовый"]
    students = []
    for index, name in enumerate(names):
        user = User(
            login=f"student-{uuid4().hex}",
            password_hash="unusable",
            full_name=name,
            role="student",
            is_active=True,
        )
        db.add(user)
        db.flush()
        student = Student(
            user_id=user.id, group_id=groups[index % 2].id, academic_status="enrolled"
        )
        db.add(student)
        db.flush()
        students.append(student)

    dean = OrgUnit(name="Деканат фиктивный", type="dean_office")
    db.add(dean)
    db.flush()

    def create_actor(role="staff"):
        actor = User(
            login=f"actor-{uuid4().hex}",
            password_hash="unusable",
            full_name="Вымышленный сотрудник",
            role=role,
            is_active=True,
        )
        db.add(actor)
        db.flush()
        profile = None
        if role == "staff":
            profile = StaffProfile(user_id=actor.id, org_unit_id=dean.id)
            db.add(profile)
            db.flush()
        session = AuthSession(user_id=actor.id, expires_at=datetime.now(UTC) + timedelta(hours=1))
        db.add(session)
        db.flush()
        settings = Settings(
            _env_file=None,
            app_env="test",
            jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        )
        token = create_access_token(session, settings)["access_token"]
        return actor, profile, token

    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)
    app.dependency_overrides[get_db_session] = lambda: db
    client = TestClient(app, raise_server_exceptions=False)
    reader, reader_profile, reader_token = create_actor()
    editor, editor_profile, editor_token = create_actor()
    admin, _, admin_token = create_actor("admin")
    db.add(
        StaffPermission(
            staff_profile_id=reader_profile.id,
            permission_code=PermissionCode.STUDENTS_READ,
            scope_org_unit_id=None,
        )
    )
    db.add(
        StaffPermission(
            staff_profile_id=editor_profile.id,
            permission_code=PermissionCode.STUDENTS_STATUS_EDIT,
            scope_org_unit_id=None,
        )
    )
    db.flush()
    return locals()


def request(s, method, path, token=None, **kwargs):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return s["client"].request(method, "/api/v1/staff/students" + path, headers=headers, **kwargs)


def test_independent_permissions_and_minimal_status_write_response(staff_students):
    s = staff_students
    assert request(s, "GET", "", s["editor_token"]).status_code == 403
    assert request(s, "GET", "", s["reader_token"]).status_code == 200
    assert (
        request(
            s,
            "PUT",
            f"/{s['students'][0].id}/academic-status",
            s["reader_token"],
            json={"academic_status": "expelled", "reason": "correction"},
        ).status_code
        == 403
    )
    changed = request(
        s,
        "PUT",
        f"/{s['students'][0].id}/academic-status",
        s["editor_token"],
        json={"academic_status": "academic_leave", "reason": "administrative_change"},
    )
    assert changed.status_code == 200
    assert changed.json() == {"academic_status": "academic_leave"}
    assert s["db"].get(User, s["students"][0].user_id).is_active is True
    assert request(s, "GET", "", s["admin_token"]).status_code == 403
    assert (
        request(
            s,
            "PUT",
            f"/{s['students'][0].id}/academic-status",
            s["admin_token"],
            json={"academic_status": "expelled", "reason": "correction"},
        ).status_code
        == 403
    )


def test_staff_search_filters_and_russian_ё_order_with_cursor(staff_students):
    s = staff_students
    # Add enough rows to prove the keyset continuation remains unique and bounded.
    for index in range(24):
        user = User(
            login=f"page-{uuid4().hex}",
            password_hash="unusable",
            full_name=f"Студент {index:02}",
            role="student",
            is_active=True,
        )
        s["db"].add(user)
        s["db"].flush()
        s["db"].add(
            Student(user_id=user.id, group_id=s["groups"][0].id, academic_status="enrolled")
        )
    s["db"].flush()
    first = request(s, "GET", "", s["reader_token"], params={"q": "Тест", "limit": 2})
    assert first.status_code == 200
    assert [row["full_name"] for row in first.json()["items"]] == [
        "Елена Тестовая",
        "Ёлкина Тестовая",
    ]
    second = request(
        s,
        "GET",
        "",
        s["reader_token"],
        params={"q": "Тест", "limit": 2, "cursor": first.json()["next_cursor"]},
    )
    assert second.status_code == 200, second.text
    assert [row["full_name"] for row in second.json()["items"]] == ["Жуков Тестовый"]
    row = request(
        s,
        "GET",
        "",
        s["reader_token"],
        params={
            "faculty_id": str(s["faculty"].id),
            "program_id": str(s["program"].id),
            "course_number": 2,
            "q": "ИВТ-21",
        },
    )
    assert row.status_code == 200
    assert len(row.json()["items"]) == 20
    assert row.json()["next_cursor"] is not None
    assert set(row.json()["items"][0]) == {
        "id",
        "full_name",
        "group",
        "course_number",
        "program",
        "faculty",
        "academic_status",
    }
    assert request(s, "GET", "", s["reader_token"], params={"limit": 101}).status_code == 422
    assert (
        request(s, "GET", "", s["reader_token"], params={"faculty_id": "9" * 20}).status_code == 422
    )
    assert request(s, "GET", f"/{s['students'][0].id}", s["editor_token"]).status_code == 403


@pytest.mark.parametrize("status", ["academic_leave", "expelled", "graduated"])
def test_all_academic_status_values_and_corrections_are_audited(staff_students, status):
    s = staff_students
    student = s["students"][0]
    before_status = "academic_leave" if status == "enrolled" else "enrolled"
    student.academic_status = before_status
    s["db"].flush()
    response = request(
        s,
        "PUT",
        f"/{student.id}/academic-status",
        s["editor_token"],
        json={"academic_status": status, "reason": "correction"},
    )
    assert response.status_code == 200
    assert student.academic_status == status
    event = s["db"].scalar(
        select(AuditEvent).where(
            AuditEvent.entity_type == "student", AuditEvent.entity_id == student.id
        )
    )
    assert event.action == "set_academic_status"
    assert event.reason == "correction"
    assert event.before_data == {"academic_status": before_status}
    assert event.after_data == {"academic_status": status}


def test_noop_does_not_create_audit_and_foreign_id_is_not_visible(staff_students):
    s = staff_students
    student = s["students"][0]
    response = request(
        s,
        "PUT",
        f"/{student.id}/academic-status",
        s["editor_token"],
        json={"academic_status": "enrolled", "reason": "administrative_change"},
    )
    assert response.status_code == 200
    assert (
        s["db"].scalar(
            select(AuditEvent).where(
                AuditEvent.entity_type == "student", AuditEvent.entity_id == student.id
            )
        )
        is None
    )
    assert (
        request(
            s,
            "PUT",
            "/9223372036854775807/academic-status",
            s["editor_token"],
            json={"academic_status": "expelled", "reason": "correction"},
        ).status_code
        == 404
    )
    assert request(s, "GET", "/9223372036854775807", s["reader_token"]).status_code == 404


def test_invalid_reason_does_not_change_status(staff_students):
    s = staff_students
    student = s["students"][0]
    response = request(
        s,
        "PUT",
        f"/{student.id}/academic-status",
        s["editor_token"],
        json={"academic_status": "expelled", "reason": "free_text"},
    )
    assert response.status_code == 422
    assert student.academic_status == "enrolled"


def test_revoked_permission_blocks_the_next_request(staff_students):
    s = staff_students
    student = s["students"][0]
    permission = s["db"].scalar(
        select(StaffPermission).where(
            StaffPermission.staff_profile_id == s["editor_profile"].id,
            StaffPermission.permission_code == PermissionCode.STUDENTS_STATUS_EDIT,
        )
    )
    s["db"].delete(permission)
    s["db"].flush()
    denied = request(
        s,
        "PUT",
        f"/{student.id}/academic-status",
        s["editor_token"],
        json={"academic_status": "expelled", "reason": "correction"},
    )
    assert denied.status_code == 403
    assert student.academic_status == "enrolled"

    s["db"].add(
        StaffPermission(
            staff_profile_id=s["editor_profile"].id,
            permission_code=PermissionCode.STUDENTS_STATUS_EDIT,
            scope_org_unit_id=None,
        )
    )
    s["db"].flush()


def test_audit_failure_rolls_back_status_update(postgresql_engine, monkeypatch):
    with Session(postgresql_engine) as db, db.begin():
        dean = OrgUnit(name=f"Dean rollback {uuid4().hex}", type="dean_office")
        faculty = OrgUnit(name=f"Faculty rollback {uuid4().hex}", type="faculty")
        db.add_all([dean, faculty])
        db.flush()
        program = Program(
            code=f"rollback-{uuid4().hex}",
            name="Rollback program",
            direction_code="00",
            direction_name="Rollback direction",
            faculty_id=faculty.id,
        )
        db.add(program)
        db.flush()
        group = StudyGroup(name=f"ROLLBACK-{uuid4().hex}", program_id=program.id, course_number=1)
        student_user = User(
            login=f"rollback-student-{uuid4().hex}",
            password_hash="unusable",
            full_name="Rollback Student",
            role="student",
            is_active=True,
        )
        actor = User(
            login=f"rollback-actor-{uuid4().hex}",
            password_hash="unusable",
            full_name="Rollback Actor",
            role="staff",
            is_active=True,
        )
        db.add_all([group, student_user, actor])
        db.flush()
        student = Student(user_id=student_user.id, group_id=group.id, academic_status="enrolled")
        profile = StaffProfile(user_id=actor.id, org_unit_id=dean.id)
        db.add_all([student, profile])
        db.flush()
        db.add(
            StaffPermission(
                staff_profile_id=profile.id,
                permission_code=PermissionCode.STUDENTS_STATUS_EDIT,
                scope_org_unit_id=None,
            )
        )
        auth_session = AuthSession(
            user_id=actor.id, expires_at=datetime.now(UTC) + timedelta(hours=1)
        )
        db.add(auth_session)
        db.flush()
        token = create_access_token(
            auth_session,
            Settings(
                _env_file=None,
                app_env="test",
                jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            ),
        )["access_token"]
        student_id = student.id
        actor_id = actor.id
        profile_id = profile.id
        student_user_id = student_user.id
        group_id = group.id
        program_id = program.id
        dean_id = dean.id
        faculty_id = faculty.id

    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)

    def session_dependency():
        with Session(postgresql_engine) as db:
            yield db

    app.dependency_overrides[get_db_session] = session_dependency

    def fail_audit(*args, **kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr("app.staff_students.write_audit_event", fail_audit)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.put(
            f"/api/v1/staff/students/{student_id}/academic-status",
            headers={"Authorization": f"Bearer {token}"},
            json={"academic_status": "expelled", "reason": "correction"},
        )
    assert response.status_code == 500
    with Session(postgresql_engine) as db:
        assert db.get(Student, student_id).academic_status == "enrolled"
        assert (
            db.scalar(
                select(AuditEvent).where(
                    AuditEvent.entity_type == "student", AuditEvent.entity_id == student_id
                )
            )
            is None
        )
    with Session(postgresql_engine) as db, db.begin():
        db.execute(delete(AuthSession).where(AuthSession.user_id == actor_id))
        db.execute(delete(StaffPermission).where(StaffPermission.staff_profile_id == profile_id))
        db.execute(delete(Student).where(Student.id == student_id))
        db.execute(delete(StaffProfile).where(StaffProfile.id == profile_id))
        db.execute(delete(User).where(User.id.in_([actor_id, student_user_id])))
        db.execute(delete(StudyGroup).where(StudyGroup.id == group_id))
        db.execute(delete(Program).where(Program.id == program_id))
        db.execute(delete(OrgUnit).where(OrgUnit.id.in_([dean_id, faculty_id])))


def test_concurrent_status_changes_audit_the_locked_before_value(postgresql_engine):
    with Session(postgresql_engine) as db, db.begin():
        dean = OrgUnit(name=f"Dean race {uuid4().hex}", type="dean_office")
        faculty = OrgUnit(name=f"Faculty race {uuid4().hex}", type="faculty")
        db.add_all([dean, faculty])
        db.flush()
        program = Program(
            code=f"race-{uuid4().hex}",
            name="Race program",
            direction_code="00",
            direction_name="Race direction",
            faculty_id=faculty.id,
        )
        db.add(program)
        db.flush()
        group = StudyGroup(name=f"RACE-{uuid4().hex}", program_id=program.id, course_number=1)
        student_user = User(
            login=f"race-student-{uuid4().hex}",
            password_hash="unusable",
            full_name="Race Student",
            role="student",
            is_active=True,
        )
        actor = User(
            login=f"race-actor-{uuid4().hex}",
            password_hash="unusable",
            full_name="Race Actor",
            role="staff",
            is_active=True,
        )
        db.add_all([group, student_user, actor])
        db.flush()
        student = Student(user_id=student_user.id, group_id=group.id, academic_status="enrolled")
        profile = StaffProfile(user_id=actor.id, org_unit_id=dean.id)
        db.add_all([student, profile])
        db.flush()
        db.add(
            StaffPermission(
                staff_profile_id=profile.id,
                permission_code=PermissionCode.STUDENTS_STATUS_EDIT,
                scope_org_unit_id=None,
            )
        )
        auth_session = AuthSession(
            user_id=actor.id, expires_at=datetime.now(UTC) + timedelta(hours=1)
        )
        db.add(auth_session)
        db.flush()
        settings = Settings(
            _env_file=None,
            app_env="test",
            jwt_signing_key="test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        )
        token = create_access_token(auth_session, settings)["access_token"]
        student_id = student.id
        actor_id = actor.id
        profile_id = profile.id
        student_user_id = student_user.id
        group_id = group.id
        program_id = program.id
        dean_id = dean.id
        faculty_id = faculty.id

    app = FastAPI()
    app.add_middleware(ApiHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(router)

    def session_dependency():
        with Session(postgresql_engine) as db:
            yield db

    app.dependency_overrides[get_db_session] = session_dependency

    def update(status):
        with TestClient(app, raise_server_exceptions=False) as client:
            return client.put(
                f"/api/v1/staff/students/{student_id}/academic-status",
                headers={"Authorization": f"Bearer {token}"},
                json={"academic_status": status, "reason": "correction"},
            )

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(update, ["expelled", "graduated"]))
        assert [response.status_code for response in responses] == [200, 200]
        with Session(postgresql_engine) as db:
            events = db.scalars(
                select(AuditEvent)
                .where(AuditEvent.entity_type == "student", AuditEvent.entity_id == student_id)
                .order_by(AuditEvent.id)
            ).all()
            assert len(events) == 2
            assert events[0].before_data == {"academic_status": "enrolled"}
            assert events[1].before_data == events[0].after_data
            assert (
                events[-1].after_data["academic_status"]
                == db.get(Student, student_id).academic_status
            )
    finally:
        with Session(postgresql_engine) as db, db.begin():
            db.execute(
                delete(AuditEvent).where(
                    AuditEvent.entity_type == "student", AuditEvent.entity_id == student_id
                )
            )
            db.execute(delete(AuthSession).where(AuthSession.user_id == actor_id))
            db.execute(
                delete(StaffPermission).where(StaffPermission.staff_profile_id == profile_id)
            )
            db.execute(delete(Student).where(Student.id == student_id))
            db.execute(delete(StaffProfile).where(StaffProfile.id == profile_id))
            db.execute(delete(User).where(User.id.in_([actor_id, student_user_id])))
            db.execute(delete(StudyGroup).where(StudyGroup.id == group_id))
            db.execute(delete(Program).where(Program.id == program_id))
            db.execute(delete(OrgUnit).where(OrgUnit.id.in_([dean_id, faculty_id])))
