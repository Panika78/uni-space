from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError
from test_academics_integration import academics as academics_fixture

from app.auth.security import create_access_token
from app.models import AuthSession, Lesson, LessonGroup, Subgroup, Teacher, TeachingAssignment, User
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
