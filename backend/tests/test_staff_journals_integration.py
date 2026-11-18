from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select
from test_teaching_attendance_integration import teaching_attendance as attendance_fixture
from test_teaching_integration import create_staff

from app.auth.security import create_access_token
from app.final_results import router as final_router
from app.models import (
    AssessmentResult,
    Attendance,
    AuditEvent,
    AuthSession,
    FinalResult,
    OrgUnit,
    Program,
    StaffPermission,
    StaffProfile,
    StudyGroup,
    Subgroup,
    User,
)
from app.staff_journals import router

pytestmark = pytest.mark.integration
BASE = "/api/v1/staff/journals"


@pytest.fixture
def staff_journal(db_session):
    s = attendance_fixture.__wrapped__(db_session)
    s.app.include_router(router)
    s.app.include_router(final_router)
    s.course = s.courses[0]
    s.work = s.assignment(s.course)
    s.path = f"{BASE}/courses/{s.course.id}/groups/{s.groups[0].id}"
    s.results = f"{s.path}/assessments/{s.work.id}/results"
    return s


def staff(s, *permissions):
    user, headers = create_staff(s, permission=False)
    profile = s.db.scalar(select(StaffProfile).where(StaffProfile.user_id == user.id))
    grants = [
        s.add(StaffPermission, staff_profile_id=profile.id, permission_code=code)
        for code in permissions
    ]
    return user, headers, grants


def test_catalog_and_roster_grants_are_independent(staff_journal):
    s = staff_journal
    catalog = f"{BASE}/catalog"
    assert s.client.get(catalog).status_code == 401
    for token in (s.tokens[0], s.teacher_tokens[0]):
        assert (
            s.client.get(catalog, headers={"Authorization": f"Bearer {token}"}).status_code == 403
        )
    for permissions, can_grade, can_attend in (
        (("grades.edit",), True, False),
        (("attendance.edit",), False, True),
        (("grades.edit", "attendance.edit"), True, True),
        (("students.read",), False, False),
    ):
        _, headers, _ = staff(s, *permissions)
        response = s.client.get(catalog, headers=headers, params={"limit": 1})
        if can_grade or can_attend:
            first = response.json()
            assert response.status_code == 200 and len(first["items"]) == 1
            assert response.headers["cache-control"] == "no-store"
            assert ("attestation_type" in first["items"][0]) is can_grade
            second = s.client.get(
                catalog,
                headers=headers,
                params={
                    "limit": 1,
                    "cursor": first["next_cursor"],
                },
            ).json()
            assert first["items"] != second["items"]
            different_filter = s.client.get(
                catalog, headers=headers, params={"cursor": first["next_cursor"], "q": "семестр"}
            )
            assert different_filter.status_code == 422
            roster = s.client.get(f"{s.path}/students", headers=headers).json()["items"]
            assert roster and set(roster[0]) == {"student_id", "full_name"}
        else:
            assert response.status_code == 403
        for suffix, allowed in (
            ("/assessments", can_grade),
            ("/final-results", can_grade),
            ("/lessons", can_attend),
        ):
            assert s.client.get(s.path + suffix, headers=headers).status_code == (
                200 if allowed else 403
            )

    user, headers, grants = staff(s, "grades.edit")
    s.db.delete(grants[0])
    s.db.flush()
    assert s.client.get(catalog, headers=headers).status_code == 403
    user.is_active = False
    s.db.flush()
    assert s.client.get(catalog, headers=headers).status_code == 401


def test_scores_discover_deleted_pair_after_transfer_and_recreation(staff_journal):
    s = staff_journal
    user, headers, _ = staff(s, "grades.edit")
    student = s.students[0]
    history = f"{s.results}/{student.id}/history"
    write = s.results.replace(BASE, "/api/v1/teaching") + f"/{student.id}"

    def score(value):
        return s.client.put(write, json={"score": value}, headers=headers)

    first = score(0)
    assert first.status_code == 200
    assert score(3).status_code == score(3).status_code == 200
    student.group_id = s.groups[1].id
    s.db.flush()
    assert score(4).status_code == 200
    assert score(None).status_code == 200
    assert score(2).status_code == 422
    assert (
        s.db.scalar(select(AssessmentResult.id).where(AssessmentResult.student_id == student.id))
        is None
    )
    result = s.client.get(s.results, headers=headers, params={"student_id": student.id})
    assert result.status_code == 200, result.text
    [row] = result.json()["items"]
    assert row["history_only"] and not row["can_edit"]
    assert row["result_id"] is row["score"] is None
    student.group_id = s.groups[0].id
    s.db.flush()
    assert score(5).json()["result_id"] != first.json()["result_id"]

    response = s.client.get(history, headers=headers, params={"limit": 2})
    assert response.status_code == 200, response.text
    first_page = response.json()
    rest = s.client.get(
        history, headers=headers, params={"cursor": first_page["next_cursor"]}
    ).json()
    events = first_page["items"] + rest["items"]
    assert [event["action"] for event in events] == [
        "create",
        "delete",
        "update",
        "update",
        "create",
    ]
    assert events[-1]["after"] == {"score": 0} and events[-1]["before"] is None
    assert events[1]["before"] == {"score": 4} and events[1]["after"] is None
    source = s.db.get(AuditEvent, int(events[-1]["event_id"]))
    assert datetime.fromisoformat(events[-1]["created_at"]) == source.created_at
    assert events[-1]["actor_name"] == user.full_name
    assert str(source.actor_user_id) == events[-1]["actor_user_id"] == str(user.id)
    other = f"{s.results}/{s.students[2].id}/history"
    assert s.client.get(other, headers=headers).json()["items"] == []
    assert (
        s.client.get(
            other, headers=headers, params={"cursor": first_page["next_cursor"]}
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    ("kind", "value"),
    [
        ("exam", {"grade_value": 2}),
        ("graded_pass", {"grade_value": 2}),
        ("pass_fail", {"passed": False}),
    ],
)
def test_deleted_final_discoverable_at_course_scope(staff_journal, kind, value):
    s = staff_journal
    _, headers, _ = staff(s, "grades.edit")
    course = s.offering(kind, assigned=s.groups[:1])
    student = s.students[0]
    write = f"/api/v1/final-results/courses/{course.id}/students/{student.id}"
    course_path = f"{BASE}/courses/{course.id}"
    assert (
        s.client.patch(
            write,
            json={**value, "retake_date": "2027-01-10", "retake_location": "А-102"},
            headers=headers,
        ).status_code
        == 200
    )
    student.group_id = s.groups[1].id
    s.db.flush()
    assert (
        s.client.patch(write, json={"retake_location": "Б-201"}, headers=headers).status_code == 200
    )
    assert s.client.delete(write, headers=headers).status_code == 200
    assert s.db.scalar(select(FinalResult.id).where(FinalResult.student_id == student.id)) is None
    response = s.client.get(
        f"{course_path}/historical-final-students", headers=headers, params={"q": "студент"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"] == [
        {"student_id": str(student.id), "full_name": "Вымышленный студент", "history_only": True}
    ]
    history = s.client.get(
        f"{course_path}/students/{student.id}/final-result/history", headers=headers
    )
    assert history.status_code == 200, history.text
    [deleted, updated, created] = history.json()["items"]
    assert deleted["after"] is None and deleted["before"]["retake_location"] == "Б-201"
    assert updated["before"] == created["after"]
    assert created["after"]["retake_date"] == "2027-01-10"


def test_staff_reads_corrects_and_clears_historical_attendance(staff_journal):
    s = staff_journal
    _, headers, _ = staff(s, "attendance.edit")
    student = s.students[0]
    write = f"/api/v1/attendance/lessons/{s.lesson.id}/students/{student.id}"
    read = f"{s.path}/lessons/{s.lesson.id}/attendance"
    assert s.client.put(write, json={"status": "attended"}, headers=headers).status_code == 200
    student.group_id = s.groups[1].id
    s.db.flush()
    s.lesson.status = "cancelled"
    s.db.flush()
    response = s.client.get(read, headers=headers, params={"student_id": student.id})
    assert response.status_code == 200, response.text
    [row] = response.json()["items"]
    assert row["status"] == "attended" and row["can_edit"] and row["is_historical"]
    assert "academic_status" not in row
    assert s.client.put(write, json={"status": "absent"}, headers=headers).status_code == 200
    assert s.client.delete(write, headers=headers).status_code == 200
    assert s.client.put(write, json={"status": "absent"}, headers=headers).status_code == 404
    assert (
        s.client.get(read, headers=headers, params={"student_id": student.id}).json()["items"] == []
    )


def test_global_academic_grants_and_mismatched_ids(staff_journal):
    s = staff_journal
    _, grades, _ = staff(s, "grades.edit")
    _, attendance, _ = staff(s, "attendance.edit")
    faculty = s.add(OrgUnit, name="Другой факультет", type="faculty")
    program = s.add(
        Program,
        code="other",
        name="Иная программа",
        direction_code="00",
        direction_name="Направление",
        faculty_id=faculty.id,
    )
    group = s.add(StudyGroup, name="ДУ-1", program_id=program.id, course_number=1)
    course = s.offering(assigned=[group])
    other_path = f"{BASE}/courses/{course.id}/groups/{group.id}"
    for headers, suffix in ((grades, "/final-results"), (attendance, "/lessons")):
        result = s.client.get(other_path + suffix, headers=headers)
        assert result.status_code == 200, result.text
    assert s.client.get(other_path + "/students", headers=grades).json()["items"] == []
    assert (
        s.client.get(
            f"{BASE}/courses/{course.id}/groups/{s.groups[0].id}/students", headers=grades
        ).status_code
        == 404
    )
    assert (
        s.client.get(
            f"{other_path}/assessments/{s.work.id}/results/{s.students[0].id}/history",
            headers=grades,
        ).status_code
        == 404
    )
    assert (
        s.client.get(
            f"{other_path}/lessons/{s.lesson.id}/attendance", headers=attendance
        ).status_code
        == 404
    )
    assert (
        s.client.get(f"{s.results}/{s.students[0].id}/history", headers=attendance).status_code
        == 403
    )
    assert (
        s.client.get(f"{s.path}/lessons/{s.lesson.id}/attendance", headers=grades).status_code
        == 403
    )
    assert s.client.get(f"{s.path}/students?limit=101", headers=grades).status_code == 422
    admin = s.add(
        User,
        login="test-admin-journal",
        password_hash="unused",
        full_name="Вымышленный администратор",
        role="admin",
        is_active=True,
    )
    session = s.add(AuthSession, user_id=admin.id, expires_at=datetime.now(UTC) + timedelta(days=1))
    token = create_access_token(session, s.settings)["access_token"]
    assert (
        s.client.get(f"{BASE}/catalog", headers={"Authorization": f"Bearer {token}"}).status_code
        == 403
    )


def test_subgroup_change_preserves_provenance_and_legacy_does_not_guess(staff_journal):
    s = staff_journal
    _, headers, _ = staff(s, "attendance.edit")
    student, group = s.students[0], s.groups[0]
    subgroup = s.add(Subgroup, group_id=group.id, name="А")
    next_subgroup = s.add(Subgroup, group_id=group.id, name="Б")
    student.subgroup_id = subgroup.id
    s.db.flush()
    mark = s.add(
        Attendance,
        lesson_id=s.lesson.id,
        student_id=student.id,
        origin_group_id=group.id,
        origin_subgroup_id=subgroup.id,
        membership_version=student.membership_version,
        status="absent",
        marked_by_user_id=s.teacher_users[0].id,
    )
    student.subgroup_id = next_subgroup.id
    s.db.flush()
    read = f"{s.path}/lessons/{s.lesson.id}/attendance"
    response = s.client.get(read, headers=headers, params={"student_id": student.id})
    assert response.status_code == 200, response.text
    [row] = response.json()["items"]
    assert row["status"] == "absent" and row["is_historical"] and row["can_edit"]
    assert row["subgroup_id"] == str(subgroup.id)

    mark.origin_group_id = mark.origin_subgroup_id = mark.membership_version = None
    student.group_id, student.subgroup_id = s.groups[1].id, None
    s.db.flush()
    assert (
        s.client.get(read, headers=headers, params={"student_id": student.id}).json()["items"] == []
    )


def test_history_is_not_read_before_authorization_and_roster_does_not_query_per_student(
    staff_journal,
):
    s = staff_journal
    _, denied, _ = staff(s, "attendance.edit")
    _, granted, _ = staff(s, "grades.edit")
    statements = []

    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    connection = s.db.connection()
    event.listen(connection, "before_cursor_execute", capture)
    try:
        response = s.client.get(f"{s.results}/{s.students[0].id}/history", headers=denied)
        assert response.status_code == 403
        assert not any("staff_journal_events" in sql for sql in statements)
        query_counts = []
        for limit in (1, 100):
            statements.clear()
            response = s.client.get(s.results, headers=granted, params={"limit": limit})
            assert response.status_code == 200, response.text
            query_counts.append(sum(sql.lstrip().startswith("SELECT") for sql in statements))
        assert query_counts[0] == query_counts[1]
    finally:
        event.remove(connection, "before_cursor_execute", capture)
