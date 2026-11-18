import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_application_workflow_acl import runtime_engine  # noqa: F401
from test_teaching_integration import create_staff
from test_teaching_integration import journal as journal_fixture

from app.auth.security import create_access_token
from app.dependencies.database import get_db_session
from app.models import (
    AuditEvent,
    CourseGroup,
    Notification,
    OrgUnit,
    Program,
    StaffPermission,
    StaffProfile,
    StudyGroup,
    TeacherAnnouncement,
    TeachingAssignment,
    User,
)
from app.models.accounts import AuthSession

pytestmark = pytest.mark.integration


@pytest.fixture
def journal(db_session):
    return journal_fixture.__wrapped__(db_session)


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def publish(s, group, *, teacher=0, course=0, headers=None, **values):
    return s.client.post(
        f"/api/v1/teaching/courses/{s.courses[course].id}/announcements",
        json={"group_id": group, "title": "Тест", "body": "Текст", **values},
        headers=auth(s.teacher_tokens[teacher]) if headers is None else headers,
    )


def student_feed(s, *, student=0, course=0, **params):
    return s.client.get(
        f"/api/v1/academics/courses/{s.courses[course].id}/announcements",
        headers=auth(s.tokens[student]),
        params=params,
    )


def test_publish_and_read_current_audience(journal):
    s = journal
    first, second = [str(group.id) for group in s.groups]
    s.courses[1].discipline_id = s.courses[0].discipline_id
    s.courses[1].term_id = s.add(
        type(s.term),
        name="Другой семестр",
        starts_on=s.term.starts_on + timedelta(days=365),
        ends_on=s.term.ends_on + timedelta(days=365),
    ).id
    s.db.flush()

    assert publish(s, second).status_code == 403
    assert publish(s, None).status_code == 403
    assert publish(s, second, course=1).status_code == 422
    assert s.get("announcements", group=1).status_code == 404
    assert s.get("announcements").headers["X-Can-Publish-To-All-Groups"] == "false"
    body = "  Первая строка\n\n<img src=x onerror=alert(1)> **текст** 🦉\r\n"
    result = publish(s, first, title="  Объявление 🦉  ", body=body, is_important=True)
    assert result.status_code == 201, result.text
    address = result.json()
    assert address["title"] == "Объявление 🦉"
    assert address["teacher"] == {"id": str(s.teachers[0].id), "full_name": "Teacher"}
    assert address["body"] == body
    assert "\n" not in address["excerpt"]
    assert address["is_important"] is True
    assert student_feed(s).json()["items"] == [address]
    assert student_feed(s, student=1).json()["items"] == []
    assert student_feed(s, course=1).json()["items"] == []
    assert student_feed(s, student=1, course=1).status_code == 404

    faculty = s.add(OrgUnit, name="Второй вымышленный факультет", type="faculty")
    program = s.add(
        Program,
        code="second",
        name="Вторая программа",
        direction_code="00",
        direction_name="Учебное направление",
        faculty_id=faculty.id,
    )
    s.groups[1].program_id = program.id
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[0].id,
        course_offering_id=s.courses[0].id,
        group_id=s.groups[1].id,
    )
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[1].id,
        course_offering_id=s.courses[0].id,
        group_id=s.groups[0].id,
    )
    assert s.get("announcements").headers["X-Can-Publish-To-All-Groups"] == "true"
    common = publish(s, None, title="Общее").json()
    other_author = publish(s, first, teacher=1).json()
    assert common["group_id"] is None and common["is_important"] is False
    assert student_feed(s).json()["items"] == [other_author, common, address]
    assert student_feed(s, student=1).json()["items"] == [common]
    assert student_feed(s, course=1).json()["items"] == []
    assert s.get("announcements", teacher=1).json()["items"] == [other_author, common, address]

    new_group = s.add(StudyGroup, name="Новая группа", program_id=program.id, course_number=1)
    s.add(CourseGroup, course_offering_id=s.courses[0].id, group_id=new_group.id)
    s.students[0].group_id = new_group.id
    s.db.delete(s.grants[0])
    s.db.flush()
    assert publish(s, first).status_code == 403
    assert publish(s, None).status_code == 403
    assert s.get("announcements").status_code == 404
    assert student_feed(s, student=2).json()["items"] == [other_author, common, address]
    assert student_feed(s).json()["items"] == [common]
    assert s.db.scalar(select(func.count(Notification.id))) == 0

    event = s.db.scalar(
        select(AuditEvent).where(
            AuditEvent.entity_type == "teacher_announcement",
            AuditEvent.entity_id == int(address["id"]),
        )
    )
    assert event.action == "create" and event.actor_user_id == s.teacher_users[0].id
    assert event.before_data is None
    assert event.after_data == {
        "course_offering_id": s.courses[0].id,
        "teacher_id": s.teachers[0].id,
        "group_id": int(first),
        "is_important": True,
        "title": address["title"],
    }


def test_validation_and_scoped_cursor(journal):
    s = journal
    first = str(s.groups[0].id)
    endpoint = f"/api/v1/teaching/courses/{s.courses[0].id}/announcements"
    assert publish(s, first, headers={}).status_code == 401
    assert publish(s, first, headers=auth(s.tokens[0])).status_code == 403
    staff, staff_headers = create_staff(s)
    profile = s.db.scalar(select(StaffProfile).where(StaffProfile.user_id == staff.id))
    s.add(StaffPermission, staff_profile_id=profile.id, permission_code="news.publish")
    assert publish(s, first, headers=staff_headers).status_code == 403
    admin = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Администратор",
        role="admin",
        is_active=True,
    )
    session = s.add(AuthSession, user_id=admin.id, expires_at=datetime.now(UTC) + timedelta(days=1))
    assert (
        publish(
            s, first, headers=auth(create_access_token(session, s.settings)["access_token"])
        ).status_code
        == 403
    )
    s.teacher_users[1].is_active = False
    s.db.flush()
    assert publish(s, first, teacher=1).status_code == 401
    assert publish(s, None, course=1, teacher=2).status_code == 403
    s.courses.append(s.offering(assigned=[]))
    assert publish(s, None, course=2).status_code == 422
    for fields in [
        {"group_id": 1},
        {"group_id": "9223372036854775808"},
        {"group_id": "0"},
        {"title": " "},
        {"title": "🦉" * 201},
        {"body": " \n\t"},
        {"body": "🦉" * 20001},
        {"body": "a\x00b"},
        {"body": "a\ud800"},
        {"teacher_id": "1"},
        {"created_at": "2026-11-18"},
        {"excerpt": "text"},
        {"is_important": "false"},
    ]:
        payload = {"title": "Тест", "body": "Текст", "group_id": first, **fields}
        result = s.client.post(
            endpoint,
            headers={**auth(s.teacher_tokens[0]), "Content-Type": "application/json"},
            content=json.dumps(payload),
        )
        assert result.status_code == 422, result.text
    assert (
        s.client.post(
            endpoint, json={"title": "Тест", "body": "Текст"}, headers=auth(s.teacher_tokens[0])
        ).status_code
        == 422
    )
    assert (
        s.client.post(
            endpoint,
            content='{"title":"a","title":"b","body":"c","group_id":null}',
            headers={**auth(s.teacher_tokens[0]), "Content-Type": "application/json"},
        ).status_code
        == 422
    )
    for params in [
        {"limit": 0},
        {"limit": 101},
        {"limit": [1, 2]},
        {"cursor": "broken"},
        {"group_id": first},
    ]:
        assert student_feed(s, **params).status_code == 422
    assert (
        s.client.get(
            "/api/v1/academics/courses/9223372036854775808/announcements",
            headers=auth(s.tokens[0]),
        ).status_code
        == 422
    )
    records = []
    for i in range(3):
        result = publish(s, first, title="🦉" * 200, body="я" * 20_000 if i == 0 else str(i))
        assert result.status_code == 201, result.text
        records.append(result.json()["id"])
    # Exercise equal timestamps, with BIGINT id as the only tie-breaker.
    s.db.execute(text("UPDATE teacher_announcements SET created_at = '2026-11-18 10:00Z'"))
    cursor = None
    found = []
    for _ in records:
        params = {"cursor": cursor} if cursor else {}
        result = student_feed(s, limit=1, **params)
        assert result.status_code == 200, result.text
        found.append(result.json()["items"][0]["id"])
        cursor = result.json()["next_cursor"]
        if cursor:
            assert student_feed(s, student=1, cursor=cursor).status_code == 422
    assert found == records[::-1] and cursor is None


def test_database_constraints_and_audit_rollback(journal, monkeypatch):
    s = journal
    s.db.commit()
    course, group, teacher = s.courses[0].id, s.groups[0].id, s.teachers[0].id
    for values in [
        {"course_offering_id": s.courses[1].id, "group_id": s.groups[1].id},
        {"teacher_id": 9223372036854775807},
        {"title": ""},
    ]:
        baseline = dict(
            course_offering_id=course,
            group_id=group,
            teacher_id=teacher,
            title="Тест",
            body="Текст",
        )
        with pytest.raises(IntegrityError), s.db.begin_nested():
            s.add(TeacherAnnouncement, **(baseline | values))

    from app.teaching import announcements

    original = announcements.write_audit_event

    def fail_after_audit(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Forced error after audit flush")

    monkeypatch.setattr(announcements, "write_audit_event", fail_after_audit)
    assert publish(s, str(group)).status_code == 500
    assert s.db.scalar(select(func.count(TeacherAnnouncement.id))) == 0
    assert s.db.scalar(select(func.count(AuditEvent.id))) == 0


def test_production_role_can_publish_but_cannot_edit_or_read_audit(runtime_engine):  # noqa: F811
    admin, runtime = runtime_engine
    with Session(admin) as setup:
        s = journal_fixture.__wrapped__(setup)
        group = str(s.groups[0].id)
        setup.commit()

        def runtime_session():
            with Session(runtime) as db:
                yield db

        s.app.dependency_overrides[get_db_session] = runtime_session
        result = publish(s, group)
        assert result.status_code == 201, result.text
        assert student_feed(s).json()["items"] == [result.json()]
        with runtime.connect() as connection:
            assert connection.execute(
                text("""
                SELECT current_user,
                       has_table_privilege('teacher_announcements', 'UPDATE'),
                       has_table_privilege('teacher_announcements', 'DELETE'),
                       has_sequence_privilege('teacher_announcements_id_seq', 'USAGE'),
                       has_column_privilege('audit_events', 'after_data', 'SELECT')
            """)
            ).one() == ("uni_space_api", False, False, False, False)
