from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError
from test_academics_integration import academics as academics_fixture

from app.auth.security import create_access_token
from app.models import (
    Assessment,
    AssessmentResult,
    AuditEvent,
    AuthSession,
    Lesson,
    LessonGroup,
    OrgUnit,
    StaffPermission,
    StaffProfile,
    Subgroup,
    Teacher,
    TeachingAssignment,
    User,
)
from app.teaching.router import router

pytestmark = pytest.mark.integration


@pytest.fixture
def journal(db_session):
    s = academics_fixture.__wrapped__(db_session)
    s.app.include_router(router)
    s.courses = [s.offering(), s.offering(assigned=s.groups[:1])]
    s.teachers, s.teacher_users, s.teacher_tokens = [], [], []
    for _ in range(3):
        user = s.add(
            User,
            login=uuid4().hex,
            password_hash="unused",
            full_name="Teacher",
            role="teacher",
            is_active=True,
        )
        teacher = s.add(Teacher, full_name="Teacher", user_id=user.id)
        session = s.add(
            AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
        )
        s.teachers.append(teacher)
        s.teacher_users.append(user)
        s.teacher_tokens.append(create_access_token(session, s.settings)["access_token"])
    s.grants = []
    for t, c, g in [(0, 0, 0), (1, 0, 1), (0, 1, 0), (1, 1, 0)]:
        s.grants.append(
            s.add(
                TeachingAssignment,
                teacher_id=s.teachers[t].id,
                course_offering_id=s.courses[c].id,
                group_id=s.groups[g].id,
            )
        )

    def request(suffix="students", teacher=0, course=0, group=0, **params):
        path = "/api/v1/teaching/" + (
            "assignments"
            if suffix == "assignments"
            else f"courses/{s.courses[course].id}/groups/{s.groups[group].id}/{suffix}"
        )
        return s.client.get(
            path, params=params, headers={"Authorization": f"Bearer {s.teacher_tokens[teacher]}"}
        )

    s.get = request
    return s


def create_staff(s, *, unit_type="dean_office", permission=True):
    unit = s.add(OrgUnit, name=f"Вымышленное подразделение {uuid4().hex}", type=unit_type)
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Вымышленный сотрудник",
        role="staff",
        is_active=True,
    )
    profile = s.add(StaffProfile, user_id=user.id, org_unit_id=unit.id)
    if permission:
        s.add(StaffPermission, staff_profile_id=profile.id, permission_code="grades.edit")
    session = s.add(AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
    return user, {
        "Authorization": "Bearer " + create_access_token(session, s.settings)["access_token"]
    }


def test_assignment_integrity(journal):
    s = journal
    for course, group, teacher in [
        (s.courses[0].id, s.groups[0].id, s.teachers[0].id),
        (s.courses[1].id, s.groups[1].id, s.teachers[0].id),
        (9223372036854775807, s.groups[0].id, s.teachers[0].id),
        (s.courses[0].id, 9223372036854775807, s.teachers[0].id),
        (s.courses[0].id, s.groups[0].id, 9223372036854775807),
    ]:
        with pytest.raises(IntegrityError), s.db.begin_nested():
            s.add(TeachingAssignment, course_offering_id=course, group_id=group, teacher_id=teacher)


def test_scope_roles_revocation_and_filters(journal):
    s = journal
    assert len(s.get("assignments").json()["items"]) == 2
    assert len(s.get("assignments", teacher=1).json()["items"]) == 2
    assert s.get("assignments", teacher=2).json()["items"] == []
    for teacher, group in [(0, 1), (1, 0), (2, 0)]:
        for suffix in [
            "students",
            "assessments",
            "lessons",
            "assessments/999/results",
            "lessons/999/students",
        ]:
            assert s.get(suffix, teacher=teacher, group=group).status_code == 404
    assert s.get("assignments", group_id=str(s.groups[1].id)).json()["items"] == []
    assert s.get(student_id=str(s.students[1].id)).json()["items"] == []
    assert s.client.get("/api/v1/teaching/assignments").status_code == 401
    assert (
        s.client.get(
            "/api/v1/teaching/assignments", headers={"Authorization": f"Bearer {s.tokens[0]}"}
        ).status_code
        == 403
    )
    s.teacher_users[0].is_active = False
    s.db.flush()
    assert s.get().status_code == 401
    s.teacher_users[0].is_active = True
    s.db.delete(s.grants[0])
    s.db.flush()
    assert s.get().status_code == 404
    assert len(s.get("assignments").json()["items"]) == 1
    assert s.get(course=1).status_code == s.get(course=1, teacher=1).status_code == 200


def test_score_write_range_noop_update_delete_and_transfer(journal):
    s = journal
    work = s.assignment(s.courses[0])
    endpoint = (
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )
    headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}
    assert (
        s.client.put(
            endpoint,
            json={"score": 1},
            headers={"Authorization": f"Bearer {s.teacher_tokens[1]}"},
        ).status_code
        == 404
    )

    def write(score):
        return s.client.put(endpoint, json={"score": score}, headers=headers)

    created = write(0)
    assert created.status_code == 200 and created.json()["score"] == 0
    result_id = int(created.json()["result_id"])
    result = s.db.get(AssessmentResult, result_id)
    graded_at, grader = result.graded_at, result.graded_by_user_id
    assert grader == s.teacher_users[0].id
    event_count = s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count()
    assert event_count == 1
    assert write(5).status_code == 200
    assert result.graded_at != graded_at and result.graded_by_user_id == s.teacher_users[0].id
    updated_at = result.graded_at
    updated_by = result.graded_by_user_id
    assert write(5).status_code == 200
    assert result.graded_at == updated_at and result.graded_by_user_id == updated_by
    assert result.graded_by_user_id == grader
    assert s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count() == 2
    for invalid in (-1, 1.5, 11):
        assert write(invalid).status_code == 422
    assert write(None).status_code == 200
    assert s.db.get(AssessmentResult, result_id) is None
    actions = [
        event.action
        for event in s.db.query(AuditEvent).filter_by(entity_type="assessment_result").all()
    ]
    assert actions == ["create", "update", "delete"]
    created_event, updated_event, deleted_event = (
        s.db.query(AuditEvent)
        .filter_by(entity_type="assessment_result")
        .order_by(AuditEvent.id)
        .all()
    )
    assert created_event.actor_user_id == updated_event.actor_user_id == deleted_event.actor_user_id
    assert created_event.after_data["score"] == 0
    assert updated_event.before_data["score"] == 0 and updated_event.after_data["score"] == 5
    assert deleted_event.before_data["score"] == 5 and deleted_event.after_data is None
    historical = write(3)
    assert historical.status_code == 200
    historical_id = int(historical.json()["result_id"])
    s.students[0].group_id = s.groups[1].id
    s.db.flush()
    assert write(2).status_code == write(None).status_code == 404
    assert s.db.get(AssessmentResult, historical_id).score == 3


def test_staff_can_correct_historical_result_only_with_grant(journal):
    s = journal
    work = s.assignment(s.courses[0])
    result = s.result(work, 3)
    s.students[0].group_id = s.groups[1].id
    dean = s.add(OrgUnit, name="Вымышленный деканат", type="dean_office")
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Вымышленный сотрудник",
        role="staff",
        is_active=True,
    )
    profile = s.add(StaffProfile, user_id=user.id, org_unit_id=dean.id)
    s.add(StaffPermission, staff_profile_id=profile.id, permission_code="grades.edit")
    auth_session = s.add(
        AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    token = create_access_token(auth_session, s.settings)["access_token"]
    endpoint = (
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )
    headers = {"Authorization": f"Bearer {token}"}
    response = s.client.put(endpoint, json={"score": 4}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["score"] == 4
    assert s.client.put(endpoint, json={"score": None}, headers=headers).status_code == 200
    # The staff role cannot create a new result for a former group member.
    assert s.client.put(endpoint, json={"score": 4}, headers=headers).status_code == 422
    assert s.db.get(AssessmentResult, result.id) is None

    admin = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Вымышленный администратор",
        role="admin",
        is_active=True,
    )
    admin_session = s.add(
        AuthSession, user_id=admin.id, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    admin_headers = {
        "Authorization": "Bearer " + create_access_token(admin_session, s.settings)["access_token"]
    }
    assert s.client.put(endpoint, json={"score": 4}, headers=admin_headers).status_code == 403


@pytest.mark.parametrize(("unit_type", "permission"), [("dean_office", False), ("faculty", True)])
def test_staff_without_effective_grades_edit_cannot_write_scores(journal, unit_type, permission):
    s = journal
    work = s.assignment(s.courses[0])
    existing = s.result(work, 3)
    original_time = existing.graded_at
    _, headers = create_staff(s, unit_type=unit_type, permission=permission)
    endpoint = (
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results"
    )
    events_before = s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count()
    # Student 2 is a current member of the work's group and has no result yet.
    create = s.client.put(f"{endpoint}/{s.students[2].id}", json={"score": 1}, headers=headers)
    update = s.client.put(f"{endpoint}/{s.students[0].id}", json={"score": 4}, headers=headers)
    delete = s.client.put(f"{endpoint}/{s.students[0].id}", json={"score": None}, headers=headers)
    assert [create.status_code, update.status_code, delete.status_code] == [403, 403, 403]
    assert s.db.query(AssessmentResult).filter_by(assessment_group_id=work.id).count() == 1
    assert s.db.get(AssessmentResult, existing.id).score == 3
    assert s.db.get(AssessmentResult, existing.id).graded_at == original_time
    assert (
        s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count() == events_before
    )


def test_staff_missing_student_returns_not_found_without_write_or_audit(journal):
    s = journal
    work = s.assignment(s.courses[0])
    _, headers = create_staff(s)
    endpoint = (
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/9223372036854775807"
    )
    events_before = s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count()
    created = s.client.put(endpoint, json={"score": 2}, headers=headers)
    cleared = s.client.put(endpoint, json={"score": None}, headers=headers)
    assert [created.status_code, cleared.status_code] == [404, 404]
    assert created.json()["error"]["code"] == cleared.json()["error"]["code"] == "not_found"
    assert s.db.query(AssessmentResult).filter_by(assessment_group_id=work.id).count() == 0
    assert (
        s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count() == events_before
    )


def test_teacher_written_score_is_in_student_academics_total(journal):
    s = journal
    first = s.assignment(s.courses[0], maximum=10)
    second = s.assignment(s.courses[0], maximum=5)
    endpoint = (
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        f"/assessments/{{}}/results/{s.students[0].id}"
    )
    headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}
    for assignment, score in ((first, 0), (second, 4)):
        response = s.client.put(
            endpoint.format(assignment.id), json={"score": score}, headers=headers
        )
        assert response.status_code == 200, response.text
    academics = s.client.get(
        "/api/v1/academics", headers={"Authorization": f"Bearer {s.tokens[0]}"}
    )
    assert academics.status_code == 200, academics.text
    item = next(
        row
        for row in academics.json()["items"]
        if row["course_offering_id"] == str(s.courses[0].id)
    )
    assert item["total_score"] == 4
    assert item["max_score"] == 15
    assert item["graded_assessment_count"] == 2
    assert item["assessment_count"] == 2


def test_score_and_audit_roll_back_together(journal, monkeypatch):
    from app.teaching import service

    s = journal
    work = s.assignment(s.courses[0])
    endpoint = (
        f"/api/v1/teaching/courses/{s.courses[0].id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )

    def fail_audit(*_args, **_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(service, "write_audit_event", fail_audit)
    response = s.client.put(
        endpoint,
        json={"score": 5},
        headers={"Authorization": f"Bearer {s.teacher_tokens[0]}"},
    )
    assert response.status_code == 500
    assert s.db.query(AssessmentResult).filter_by(assessment_group_id=work.id).count() == 0
    assert s.db.query(AuditEvent).filter_by(entity_type="assessment_result").count() == 0


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_score_update_and_delete_roll_back_when_audit_fails(
    committed_academics, monkeypatch, operation
):
    from sqlalchemy.orm import Session

    from app.core.database import engine as api_engine
    from app.dependencies.database import get_db_session
    from app.teaching import service

    s = committed_academics
    s.app.include_router(router)
    course = s.offering()
    work = s.assignment(course)
    result = s.result(work, 3)
    original_time = result.graded_at
    original_grader = result.graded_by_user_id
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Teacher",
        role="teacher",
        is_active=True,
    )
    teacher = s.add(Teacher, user_id=user.id, full_name=user.full_name)
    auth_session = s.add(
        AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    s.add(
        TeachingAssignment,
        teacher_id=teacher.id,
        course_offering_id=course.id,
        group_id=s.groups[0].id,
    )
    headers = {
        "Authorization": "Bearer " + create_access_token(auth_session, s.settings)["access_token"]
    }
    s.db.commit()
    with Session(api_engine) as verify:
        events_before = verify.query(AuditEvent).filter_by(entity_type="assessment_result").count()

    def get_request_session():
        with Session(api_engine) as db:
            yield db

    s.app.dependency_overrides[get_db_session] = get_request_session
    endpoint = (
        f"/api/v1/teaching/courses/{course.id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )

    def fail_audit(*_args, **_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(service, "write_audit_event", fail_audit)
    response = s.client.put(
        endpoint,
        json={"score": None if operation == "delete" else 4},
        headers=headers,
    )
    assert response.status_code == 500
    with Session(api_engine) as verify:
        stored = verify.get(AssessmentResult, result.id)
        assert stored.score == 3
        assert stored.graded_at == original_time
        assert stored.graded_by_user_id == original_grader
        assert (
            verify.query(AuditEvent).filter_by(entity_type="assessment_result").count()
            == events_before
        )


def test_roster_results_subgroups_history_and_pagination(journal):
    s = journal
    s.users[0].full_name = "Яков Вымышленный"
    s.users[2].full_name = "Анна Вымышленная"
    subgroup = s.add(Subgroup, group_id=s.groups[0].id, name="Первая")
    s.students[0].subgroup_id = subgroup.id
    lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        teacher_id=s.teachers[2].id,
        starts_at=datetime(2026, 9, 1, tzinfo=UTC),
        ends_at=datetime(2026, 9, 1, 1, tzinfo=UTC),
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id, subgroup_id=subgroup.id)
    s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[1].id)
    work = s.assignment(s.courses[0])
    work.lesson_id = lesson.id
    result = s.result(work, 0)
    other = s.assignment(s.courses[0], group=1)
    s.result(other, 8, student=1)
    s.db.flush()
    first = s.get(limit=1).json()
    assert first["items"][0]["id"] == str(s.students[2].id)
    second = s.get(limit=1, cursor=first["next_cursor"]).json()
    assert second["items"][0]["id"] == str(s.students[0].id)
    assert second["next_cursor"] is None
    assert len(s.get("assessments").json()["items"]) == 1
    rows = s.get(f"assessments/{work.id}/results").json()["items"]
    assert [r["score"] for r in rows] == [None, 0]
    assert rows[1]["result_id"] == str(result.id)
    assert s.get(f"assessments/{other.id}/results").status_code == 404
    assert s.get("assessments", assessment_group_id=str(other.id)).json()["items"] == []
    assert len(s.get("lessons").json()["items"]) == 1
    participants = s.get(f"lessons/{lesson.id}/students").json()["items"]
    assert [r["id"] for r in participants] == [str(s.students[0].id)]
    assert s.get("lessons", status="cancelled").json()["items"] == []
    assert s.get(f"lessons/{lesson.id}/students", course=1).status_code == 404
    s.students[0].subgroup_id = None
    s.students[0].group_id = s.groups[1].id
    s.db.flush()
    assert len(s.get().json()["items"]) == 1
    historical = s.get(f"assessments/{work.id}/results").json()["items"][1]
    assert historical["score"] == 0 and historical["is_current_group_member"] is False
    assert (
        s.get(f"assessments/{work.id}/results", student_id=str(s.students[1].id)).json()["items"]
        == []
    )
    assert s.get(f"lessons/{lesson.id}/students").json()["items"] == []
    for params in [{"unknown": "x"}, {"cursor": "invalid"}, {"limit": 0}]:
        assert s.get(**params).status_code == 422


def test_multiple_faculties_and_stable_filtered_pages(journal):
    from app.models import OrgUnit, Program, StudyGroup

    s = journal
    faculty = s.add(OrgUnit, name="Другой факультет", type="faculty")
    program = s.add(
        Program,
        faculty_id=faculty.id,
        code="other",
        name="Другая программа",
        direction_code="00",
        direction_name="Направление",
    )
    group = s.add(StudyGroup, name="Другая группа", program_id=program.id, course_number=1)
    s.groups.append(group)
    course = s.offering(assigned=[group])
    s.courses.append(course)
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[0].id,
        course_offering_id=course.id,
        group_id=group.id,
    )
    assert s.get(course=2, group=2).status_code == 200
    assert s.get(course=2, group=2, teacher=1).status_code == 404
    all_items, cursor = [], None
    while True:
        page = s.get("assignments", limit=1, **({"cursor": cursor} if cursor else {})).json()
        all_items.extend(page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(all_items) == len({i["id"] for i in all_items}) == 3
    assert len(s.get("assignments", course_offering_id=str(course.id)).json()["items"]) == 1
    assert s.get("assignments", term_id="999999").json()["items"] == []
    assert len(s.get("assignments", term_id=str(s.term.id)).json()["items"]) == 3


def test_children_pagination_filters_and_non_disclosure(journal):
    s = journal
    works = [s.assignment(s.courses[0]) for _ in range(3)]
    lessons = []
    for minute in [0, 0, 1]:
        lesson = s.add(
            Lesson,
            course_offering_id=s.courses[0].id,
            starts_at=datetime(2026, 9, 1, 10, minute, tzinfo=UTC),
            ends_at=datetime(2026, 9, 1, 11, tzinfo=UTC),
            kind="lecture",
        )
        s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id)
        lessons.append(lesson)
    for suffix, expected in [
        ("assessments", [str(w.id) for w in works]),
        ("lessons", [str(lesson.id) for lesson in lessons]),
    ]:
        ids, cursor = [], None
        while True:
            page = s.get(suffix, limit=1, **({"cursor": cursor} if cursor else {})).json()
            ids.extend(i["id"] for i in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        assert ids == expected
    assert len(s.get("lessons", lesson_id=str(lessons[0].id)).json()["items"]) == 1
    assert s.get("lessons", lesson_id="999999").json()["items"] == []
    assert s.get("lessons", starts_before="2026-09-01T10:00:00Z").json()["items"] == []
    assert len(s.get("lessons", starts_from="2026-09-01T10:01:00Z").json()["items"]) == 1
    assert (
        s.get(
            "lessons", starts_from="2026-09-02T00:00:00Z", starts_before="2026-09-01T00:00:00Z"
        ).status_code
        == 422
    )
    for suffix in [f"assessments/{works[0].id}/results", f"lessons/{lessons[0].id}/students"]:
        response = s.get(suffix, teacher=1, group=1)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"
    assert s.get("students").headers["cache-control"] == "no-store"
    for teacher in range(3):
        for role in ["staff", "admin"]:
            # Drop the teacher profile first to keep the composite role FK valid.
            with s.db.begin_nested() as transaction:
                from sqlalchemy import text

                s.db.execute(text("SET CONSTRAINTS ALL DEFERRED"))
                s.teacher_users[teacher].role = role
                s.db.flush()
                assert s.get(teacher=teacher).status_code == 403
                transaction.rollback()


def test_equal_names_results_pages_and_missing_teacher_profile(journal):
    s = journal
    work = s.assignment(s.courses[0])
    s.result(work, 0)
    first = s.get(f"assessments/{work.id}/results", limit=1).json()
    second = s.get(f"assessments/{work.id}/results", limit=1, cursor=first["next_cursor"]).json()
    assert [first["items"][0]["student_id"], second["items"][0]["student_id"]] == [
        str(s.students[0].id),
        str(s.students[2].id),
    ]
    assert first["items"][0]["score"] == 0
    assert second["items"][0]["score"] is None
    assert second["next_cursor"] is None
    s.teachers[2].user_id = None
    s.db.flush()
    assert s.get("assignments", teacher=2).status_code == 403


def test_lesson_subgroup_union_is_deduplicated_and_excludes_unassigned_students(journal):
    s = journal
    first = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    second = s.add(Subgroup, group_id=s.groups[0].id, name="B")
    s.students[0].subgroup_id = first.id
    lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=datetime(2026, 9, 1, tzinfo=UTC),
        ends_at=datetime(2026, 9, 1, 1, tzinfo=UTC),
        kind="lab",
    )
    for subgroup in [first, second]:
        s.add(LessonGroup, lesson_id=lesson.id, group_id=s.groups[0].id, subgroup_id=subgroup.id)
    assert len(s.get("lessons").json()["items"]) == 1
    path = f"lessons/{lesson.id}/students"
    assert [r["id"] for r in s.get(path).json()["items"]] == [str(s.students[0].id)]
    s.students[2].subgroup_id = second.id
    s.db.flush()
    assert len(s.get(path).json()["items"]) == 2
    assert s.get(path, student_id=str(s.students[1].id)).json()["items"] == []


@pytest.fixture
def committed_academics(postgresql_engine):
    from test_academics_integration import committed_academics as create_committed

    yield from create_committed.__wrapped__(postgresql_engine)


def test_assignment_changes_committed_independently_apply_to_old_jwt(committed_academics):
    from sqlalchemy import delete
    from sqlalchemy.orm import Session

    from app.dependencies.database import get_db_session

    s = committed_academics
    s.app.include_router(router)
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Teacher",
        role="teacher",
        is_active=True,
    )
    teacher = s.add(Teacher, user_id=user.id, full_name=user.full_name)
    session = s.add(AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
    course = s.offering()
    grant = s.add(
        TeachingAssignment,
        teacher_id=teacher.id,
        course_offering_id=course.id,
        group_id=s.groups[0].id,
    )
    headers = {
        "Authorization": "Bearer " + create_access_token(session, s.settings)["access_token"]
    }
    path = f"/api/v1/teaching/courses/{course.id}/groups/{s.groups[0].id}/students"
    engine = s.db.bind
    s.db.commit()

    def get_request_session():
        with Session(engine) as db:
            yield db

    s.app.dependency_overrides[get_db_session] = get_request_session
    assert s.client.get(path, headers=headers).status_code == 200
    with Session(engine) as db, db.begin():
        db.execute(delete(TeachingAssignment).where(TeachingAssignment.id == grant.id))
    assert s.client.get(path, headers=headers).status_code == 404
    with Session(engine) as db, db.begin():
        db.add(
            TeachingAssignment(
                teacher_id=teacher.id, course_offering_id=course.id, group_id=s.groups[0].id
            )
        )
    assert s.client.get(path, headers=headers).status_code == 200
    # Remove the independently inserted grant so the shared fixture can clean up parents.
    with Session(engine) as db, db.begin():
        db.execute(delete(TeachingAssignment).where(TeachingAssignment.teacher_id == teacher.id))
        db.get(User, user.id).is_active = False
    assert s.client.get(path, headers=headers).status_code == 401


def test_concurrent_score_creates_use_one_result_and_one_audit(committed_academics):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.dependencies.database import get_db_session

    s = committed_academics
    s.app.include_router(router)
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Teacher",
        role="teacher",
        is_active=True,
    )
    teacher = s.add(Teacher, user_id=user.id, full_name=user.full_name)
    auth_session = s.add(
        AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    course = s.offering()
    work = s.assignment(course)
    s.add(
        TeachingAssignment,
        teacher_id=teacher.id,
        course_offering_id=course.id,
        group_id=s.groups[0].id,
    )
    headers = {
        "Authorization": "Bearer " + create_access_token(auth_session, s.settings)["access_token"]
    }
    path = (
        f"/api/v1/teaching/courses/{course.id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )
    engine = s.db.bind
    s.db.commit()

    def get_request_session():
        with Session(engine) as db:
            yield db

    s.app.dependency_overrides[get_db_session] = get_request_session
    barrier = Barrier(2)

    def write_score():
        barrier.wait(timeout=5)
        return s.client.put(path, json={"score": 6}, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _index: write_score(), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    with Session(engine) as db:
        stored = db.scalar(
            select(AssessmentResult).where(
                AssessmentResult.assessment_group_id == work.id,
                AssessmentResult.student_id == s.students[0].id,
            )
        )
        assert stored is not None
        result_id = stored.id
        create_events = (
            db.query(AuditEvent)
            .filter_by(entity_type="assessment_result", entity_id=result_id)
            .order_by(AuditEvent.id)
            .all()
        )
        assert len(create_events) == 1
        assert create_events[0].action == "create"
        assert create_events[0].actor_user_id == user.id
        assert create_events[0].before_data is None
        assert create_events[0].after_data == {
            "assessment_group_id": work.id,
            "student_id": s.students[0].id,
            "score": 6,
        }
        assert stored.graded_by_user_id == user.id
        assert stored.graded_at <= create_events[0].created_at

    def run_concurrently(payloads):
        barrier = Barrier(len(payloads))

        def request(payload):
            barrier.wait(timeout=5)
            return s.client.put(path, json=payload, headers=headers)

        with ThreadPoolExecutor(max_workers=len(payloads)) as executor:
            return list(executor.map(request, payloads))

    updates = run_concurrently([{"score": 7}, {"score": 8}])
    assert [response.status_code for response in updates] == [200, 200]
    with Session(engine) as db:
        stored = db.scalar(
            select(AssessmentResult).where(
                AssessmentResult.assessment_group_id == work.id,
                AssessmentResult.student_id == s.students[0].id,
            )
        )
        assert stored.score in {7, 8}
        update_events = (
            db.query(AuditEvent)
            .filter_by(entity_type="assessment_result", entity_id=result_id)
            .order_by(AuditEvent.id)
            .all()
        )
        assert [event.action for event in update_events] == ["create", "update", "update"]
        changes = [
            (event.before_data["score"], event.after_data["score"]) for event in update_events[1:]
        ]
        assert changes in [[(6, 7), (7, 8)], [(6, 8), (8, 7)]]
        assert all(event.actor_user_id == user.id for event in update_events)
        assert stored.score == update_events[-1].after_data["score"]
        assert stored.graded_by_user_id == user.id
        assert stored.graded_at <= update_events[-1].created_at

    deletions = run_concurrently([{"score": None}, {"score": None}])
    assert [response.status_code for response in deletions] == [200, 200]
    with Session(engine) as db:
        assert (
            db.query(AssessmentResult)
            .filter_by(assessment_group_id=work.id, student_id=s.students[0].id)
            .count()
            == 0
        )
        events = (
            db.query(AuditEvent)
            .filter_by(entity_type="assessment_result", entity_id=result_id)
            .order_by(AuditEvent.id)
            .all()
        )
        assert [event.action for event in events] == ["create", "update", "update", "delete"]
        assert events[-1].actor_user_id == user.id
        assert events[-1].before_data["score"] == events[-2].after_data["score"]
        assert events[-1].after_data is None


@pytest.mark.parametrize("first_operation", ["update", "delete"])
def test_concurrent_score_update_and_delete_preserve_last_successful_write_and_audit(
    committed_academics, first_operation
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock

    from sqlalchemy import select, text
    from sqlalchemy.orm import Session
    from test_lesson_participants_integration import require_blocked_writer

    from app.dependencies.database import get_db_session

    s = committed_academics
    s.app.include_router(router)
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Teacher",
        role="teacher",
        is_active=True,
    )
    teacher = s.add(Teacher, user_id=user.id, full_name=user.full_name)
    auth_session = s.add(
        AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    course = s.offering()
    work = s.assignment(course)
    initial = s.result(work, 4)
    initial_id = initial.id
    initial_graded_at = initial.graded_at
    s.add(
        TeachingAssignment,
        teacher_id=teacher.id,
        course_offering_id=course.id,
        group_id=s.groups[0].id,
    )
    headers = {
        "Authorization": "Bearer " + create_access_token(auth_session, s.settings)["access_token"]
    }
    path = (
        f"/api/v1/teaching/courses/{course.id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )
    engine = s.db.bind
    s.db.commit()

    request_pids: list[int | None] = [None, None]
    request_sessions_ready = [Event(), Event()]
    request_index = 0
    request_index_lock = Lock()

    def get_request_session():
        nonlocal request_index
        with request_index_lock:
            index = request_index
            request_index += 1
        with Session(engine) as db:
            request_pids[index] = db.scalar(text("SELECT pg_backend_pid()"))
            request_sessions_ready[index].set()
            yield db

    s.app.dependency_overrides[get_db_session] = get_request_session

    def write(score):
        return s.client.put(path, json={"score": score}, headers=headers)

    first_score, second_score = (7, None) if first_operation == "update" else (None, 7)
    with ThreadPoolExecutor(max_workers=2) as executor, Session(engine) as blocker:
        blocker.begin()
        blocker_pid = blocker.scalar(text("SELECT pg_backend_pid()"))
        assert (
            blocker.scalar(
                select(AssessmentResult.id)
                .where(AssessmentResult.id == initial_id)
                .with_for_update()
            )
            == initial_id
        )

        first_request = executor.submit(write, first_score)
        assert request_sessions_ready[0].wait(5)
        first_pid = request_pids[0]
        assert first_pid is not None
        # The first request has locked the assignment and is waiting on this
        # existing result row. This makes it the deterministic lock winner.
        require_blocked_writer(engine, blocker_pid, first_pid)

        second_request = executor.submit(write, second_score)
        assert request_sessions_ready[1].wait(5)
        second_pid = request_pids[1]
        assert second_pid is not None
        # The second request must now be queued behind the first on the parent
        # assignment row before releasing the blocker.
        require_blocked_writer(engine, first_pid, second_pid)
        blocker.commit()

        first_response = first_request.result(timeout=10)
        second_response = second_request.result(timeout=10)

    assert first_response.status_code == 200, first_response.text
    assert second_response.status_code == 200, second_response.text
    with Session(engine) as db:
        results = db.scalars(
            select(AssessmentResult).where(
                AssessmentResult.assessment_group_id == work.id,
                AssessmentResult.student_id == s.students[0].id,
            )
        ).all()
        all_events = (
            db.query(AuditEvent)
            .filter_by(entity_type="assessment_result")
            .order_by(AuditEvent.id)
            .all()
        )
        events = [
            event
            for event in all_events
            if (event.after_data or event.before_data or {}).get("assessment_group_id") == work.id
            and (event.after_data or event.before_data or {}).get("student_id") == s.students[0].id
        ]

        if first_operation == "update":
            assert first_response.json()["result_id"] == str(initial_id)
            assert first_response.json()["score"] == 7
            update_time = datetime.fromisoformat(
                first_response.json()["graded_at"].replace("Z", "+00:00")
            )
            assert update_time != initial_graded_at
            assert events[0].created_at >= update_time
            assert second_response.json() == {
                "result_id": None,
                "score": None,
                "graded_at": None,
            }
            assert results == []
            assert [event.action for event in events] == ["update", "delete"]
            assert [event.entity_id for event in events] == [initial_id, initial_id]
            assert events[0].before_data == {
                "assessment_group_id": work.id,
                "student_id": s.students[0].id,
                "score": 4,
            }
            assert events[0].after_data == {
                "assessment_group_id": work.id,
                "student_id": s.students[0].id,
                "score": 7,
            }
            assert events[1].before_data == events[0].after_data
            assert events[1].after_data is None
        else:
            assert first_response.json() == {
                "result_id": None,
                "score": None,
                "graded_at": None,
            }
            assert second_response.json()["score"] == 7
            assert second_response.json()["result_id"] != str(initial_id)
            assert len(results) == 1
            assert results[0].id == int(second_response.json()["result_id"])
            assert results[0].id != initial_id
            assert results[0].score == 7
            assert results[0].graded_by_user_id == user.id
            assert results[0].graded_at != initial_graded_at
            assert (
                results[0].graded_at.isoformat()
                == datetime.fromisoformat(
                    second_response.json()["graded_at"].replace("Z", "+00:00")
                ).isoformat()
            )
            assert [event.action for event in events] == ["delete", "create"]
            assert [event.entity_id for event in events] == [initial_id, results[0].id]
            assert events[0].before_data == {
                "assessment_group_id": work.id,
                "student_id": s.students[0].id,
                "score": 4,
            }
            assert events[0].after_data is None
            assert events[1].before_data is None
            assert events[1].after_data == {
                "assessment_group_id": work.id,
                "student_id": s.students[0].id,
                "score": 7,
            }

        assert len(events) == 2
        assert all(event.actor_user_id == user.id for event in events)
        assert events[0].id < events[1].id
        assert events[0].created_at <= events[1].created_at


def test_assessment_lock_timeout_rolls_back_and_request_can_be_retried(committed_academics):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.core.database import API_LOCK_TIMEOUT_MS
    from app.core.database import engine as api_engine
    from app.dependencies.database import get_db_session

    s = committed_academics
    s.app.include_router(router)
    user = s.add(
        User,
        login=uuid4().hex,
        password_hash="unused",
        full_name="Teacher",
        role="teacher",
        is_active=True,
    )
    teacher = s.add(Teacher, user_id=user.id, full_name=user.full_name)
    auth_session = s.add(
        AuthSession, user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    course = s.offering()
    work = s.assignment(course)
    s.add(
        TeachingAssignment,
        teacher_id=teacher.id,
        course_offering_id=course.id,
        group_id=s.groups[0].id,
    )
    headers = {
        "Authorization": "Bearer " + create_access_token(auth_session, s.settings)["access_token"]
    }
    path = (
        f"/api/v1/teaching/courses/{course.id}/groups/{s.groups[0].id}"
        f"/assessments/{work.id}/results/{s.students[0].id}"
    )
    s.db.commit()

    # Use the production dependency itself: it must rollback the session when
    # the translated HTTP 503 escapes the route after PostgreSQL aborts the tx.
    s.app.dependency_overrides.pop(get_db_session, None)
    assert API_LOCK_TIMEOUT_MS == 5_000
    with Session(api_engine) as blocker:
        blocker.begin()
        blocker.scalar(
            select(Assessment.id).where(Assessment.id == work.assessment_id).with_for_update()
        )
        response = s.client.put(path, json={"score": 4}, headers=headers)
        assert response.status_code == 503, response.text
        assert response.json()["error"]["code"] == "temporarily_unavailable"
        assert response.headers["retry-after"] == "1"
        with Session(api_engine) as verify:
            assert (
                verify.query(AssessmentResult).filter_by(assessment_group_id=work.id).count() == 0
            )
            assert (
                verify.query(AuditEvent)
                .filter_by(entity_type="assessment_result", action="create")
                .count()
                == 0
            )
        blocker.rollback()

    retried = s.client.put(path, json={"score": 4}, headers=headers)
    assert retried.status_code == 200, retried.text
    with Session(api_engine) as verify:
        stored = verify.query(AssessmentResult).filter_by(assessment_group_id=work.id).one()
        assert stored.score == 4
        assert (
            verify.query(AuditEvent)
            .filter_by(entity_type="assessment_result", action="create")
            .count()
            == 1
        )
