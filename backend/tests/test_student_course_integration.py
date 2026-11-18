from datetime import UTC, datetime, time, timedelta

import pytest
from sqlalchemy import event
from test_teaching_integration import journal as journal_fixture

from app.attendance.router import router as attendance_router
from app.final_results import router as final_results_router
from app.models import Assessment, Attendance, FinalResult, Lesson, LessonGroup, Subgroup
from app.models.teaching import TeachingAssignment
from app.schedule.router import router as schedule_router
from app.schedule.service import MOSCOW

pytestmark = pytest.mark.integration


@pytest.fixture
def course(db_session):
    s = journal_fixture.__wrapped__(db_session, datetime.now(UTC) - timedelta(days=95))
    s.app.include_router(schedule_router)
    s.app.include_router(attendance_router)
    s.app.include_router(final_results_router)
    s.today = datetime.now(MOSCOW).date()
    s.term.starts_on = s.today - timedelta(days=90)
    s.term.ends_on = s.today + timedelta(days=30)
    s.courses[1].discipline_id = s.courses[0].discipline_id
    s.db.flush()
    s.path = f"/api/v1/academics/courses/{s.courses[0].id}"
    s.headers = lambda student=0: {"Authorization": f"Bearer {s.tokens[student]}"}
    s.teacher_headers = {"Authorization": f"Bearer {s.teacher_tokens[0]}"}

    def read(suffix="", student=0, **params):
        return s.client.get(s.path + suffix, headers=s.headers(student), params=params)

    def lesson(days, *, course_index=0, groups=(0,), subgroup=None, previous=None):
        starts = datetime.combine(s.today + timedelta(days=days), time(9), MOSCOW)
        item = s.add(
            Lesson,
            course_offering_id=s.courses[course_index].id,
            teacher_id=s.teachers[2].id,
            starts_at=starts,
            ends_at=starts + timedelta(hours=1),
            kind="seminar",
            previous_lesson_id=previous.id if previous else None,
        )
        for group in groups:
            s.add(LessonGroup, lesson_id=item.id, group_id=s.groups[group].id, subgroup_id=subgroup)
        return item

    def schedule(day=-1, student=0):
        day = s.today + timedelta(days=day)
        response = s.client.get(
            "/api/v1/schedule",
            headers=s.headers(student),
            params={"date_from": day.isoformat(), "date_to": day.isoformat()},
        )
        assert response.status_code == 200, response.text
        return {row["id"]: row for row in response.json()["items"]}

    s.read, s.lesson, s.schedule = read, lesson, schedule
    return s


def read_pages(s, suffix, **params):
    items = []
    seen_cursors = set()
    response = s.read(suffix, **params)
    assert response.status_code == 200, response.text
    first_cursor = response.json()["next_cursor"]
    while True:
        page = response.json()
        items.extend(page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            return items, first_cursor
        assert cursor not in seen_cursors
        seen_cursors.add(cursor)
        response = s.read(suffix, cursor=cursor, **params)
        assert response.status_code == 200, response.text


def test_passport_matches_academics_and_hides_other_group_teachers(course):
    s = course
    primary, other = s.courses
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[2].id,
        group_id=s.groups[0].id,
        course_offering_id=primary.id,
    )
    work = s.assignment(primary, maximum=0)
    s.result(work, 0)
    s.assignment(primary)
    s.result(s.assignment(other), 9)
    s.add(
        FinalResult,
        course_offering_id=primary.id,
        student_id=s.students[0].id,
        grade_value=4,
        retake_location="Тестовая аудитория",
    )
    passport = s.read()
    assert passport.status_code == 200, passport.text
    assert passport.headers["cache-control"] == "no-store"
    assert passport.headers["x-academic-term-id"] == str(s.term.id)
    data = passport.json()
    assert {teacher["id"] for teacher in data["teachers"]} == {
        str(s.teachers[0].id),
        str(s.teachers[2].id),
    }
    assert {teacher["id"] for teacher in s.read(student=1).json()["teachers"]} == {
        str(s.teachers[1].id)
    }
    academics = s.client.get("/api/v1/academics", headers=s.headers()).json()
    items = {item["course_offering_id"]: item for item in academics["items"]}
    assert {key: data[key] for key in items[str(primary.id)]} == items[str(primary.id)]
    assert data["assessment_count"] == 2 and data["graded_assessment_count"] == 1
    assert data["final_result"]["grade_value"] == 4
    assert items[str(other.id)]["discipline"] == data["discipline"]
    assert items[str(other.id)]["total_score"] == 9
    for suffix in ("", "/lessons", "/assessments"):
        hidden = s.client.get(f"/api/v1/academics/courses/{other.id}{suffix}", headers=s.headers(1))
        missing = s.client.get(
            f"/api/v1/academics/courses/9223372036854775807{suffix}", headers=s.headers(1)
        )
        assert hidden.status_code == missing.status_code == 404
        assert hidden.json() == missing.json()
        assert s.client.get(s.path + suffix).status_code == 401
        assert s.client.get(s.path + suffix, headers=s.teacher_headers).status_code == 403
        assert s.read(suffix, student_id=s.students[1].id).status_code == 422
        assert (
            s.client.get(
                f"/api/v1/academics/courses/9223372036854775808{suffix}", headers=s.headers()
            ).status_code
            == 422
        )
    s.term.ends_on = s.today - timedelta(days=1)
    s.db.flush()
    assert (
        s.read().status_code
        == s.read("/lessons").status_code
        == s.read("/assessments").status_code
        == 404
    )


def test_semester_pagination_subgroups_and_membership_change(course):
    s = course
    subgroup_a, subgroup_b = [
        s.add(Subgroup, group_id=s.groups[0].id, name=name) for name in ("А", "Б")
    ]
    s.students[0].subgroup_id = subgroup_a.id
    s.students[2].subgroup_id = subgroup_b.id
    s.db.flush()
    shared = s.lesson(-80, groups=(0, 1))
    only_a = s.lesson(-79, subgroup=subgroup_a.id)
    only_b = s.lesson(-79, subgroup=subgroup_b.id)
    unexpected = s.lesson(-91)
    s.lesson(-78, course_index=1)
    semester = [shared, only_a, *(s.lesson(days) for days in range(-49, 1, 2))]
    semester.append(s.lesson(-5))  # Tie on a start time.
    assignments = []
    for index in range(25):
        assignment = s.assignment(s.courses[0], maximum=index)
        if index % 3:
            assignment.planned_date = s.today + timedelta(days=index % 4)
        if index % 2:
            s.db.get(Assessment, assignment.assessment_id).type = "laboratory"
        assignments.append(assignment)
    # A grouped work remains visible to both subgroups even if the lesson is not.
    assignments[0].lesson_id = only_a.id
    foreign = s.assignment(s.courses[0], group=1, maximum=99)
    s.result(assignments[0], 0)
    s.result(foreign, 98, student=1)
    s.db.flush()
    for suffix in ("/lessons", "/assessments"):
        statements = []

        def record(*args, statements=statements):
            statements.append(args[2])

        event.listen(s.db.bind, "before_cursor_execute", record)
        try:
            assert s.read(suffix, limit=1).status_code == 200
            small = len(statements)
            statements.clear()
            assert s.read(suffix, limit=20).status_code == 200
            assert len(statements) == small
        finally:
            event.remove(s.db.bind, "before_cursor_execute", record)

    lessons, cursor = read_pages(s, "/lessons", limit=9)
    assert [item["id"] for item in lessons] == [
        str(lesson.id) for lesson in sorted(semester, key=lambda item: (item.starts_at, item.id))
    ]
    assert str(unexpected.id) not in {item["id"] for item in lessons}
    assert [row["id"] for row in s.read("/lessons", student=1).json()["items"]] == [str(shared.id)]
    assert str(only_b.id) in {row["id"] for row in s.read("/lessons", student=2).json()["items"]}
    assert s.read("/lessons", limit=10, cursor=cursor).status_code == 422
    assert s.read("/lessons", student=2, limit=9, cursor=cursor).status_code == 422
    assert s.read("/assessments", limit=9, cursor=cursor).status_code == 422
    assert s.read("/lessons", cursor="invalid").status_code == 422
    assert s.client.get(s.path + "/lessons?limit=1&limit=2", headers=s.headers()).status_code == 422

    works, work_cursor = read_pages(s, "/assessments", limit=9)
    assert len(works) == 25
    assert len({work["assessment_group_id"] for work in works}) == 25
    observed_keys = [
        (
            work["type"],
            work["planned_date"] is None,
            work["planned_date"] or "",
            int(work["assessment_group_id"]),
        )
        for work in works
    ]
    assert observed_keys == sorted(observed_keys)
    zero = next(work for work in works if work["assessment_group_id"] == str(assignments[0].id))
    assert zero["score"] == zero["max_score"] == 0 and zero["graded_at"]
    assert any(work["score"] is None and work["graded_at"] is None for work in works)
    assert s.read("/assessments", student=1).json()["items"][0]["score"] == 98
    assert str(assignments[0].id) in {
        row["assessment_group_id"]
        for row in s.read("/assessments", student=2, limit=100).json()["items"]
    }

    # Invalidated boundaries can be restarted from page one.
    boundary = s.db.get(type(assignments[0]), int(works[8]["assessment_group_id"]))
    boundary.planned_date = s.today + timedelta(days=20)
    s.db.flush()
    assert s.read("/assessments", limit=9, cursor=work_cursor).status_code == 422

    s.students[0].group_id = s.groups[1].id
    s.students[0].subgroup_id = None
    s.db.flush()
    assert s.read("/lessons", limit=9, cursor=cursor).status_code == 422
    assert s.read().headers["x-student-scope"] == f"{s.groups[1].id}:0:2"
    assert s.read("/assessments").json()["items"][0]["score"] is None
    assert (
        s.client.get(
            f"/api/v1/academics/courses/{s.courses[1].id}", headers=s.headers()
        ).status_code
        == 404
    )


def test_live_teacher_writes_and_explicit_schedule_links(course):
    s = course
    single, multiple, none, cancelled, old = [s.lesson(days) for days in (-1, -1, -1, -2, -10)]
    first = s.assignment(s.courses[0])
    other = s.assignment(s.courses[0])
    extras = [s.assignment(s.courses[0]) for _ in range(2)]
    for assignment, lesson in [
        (first, single),
        (extras[0], multiple),
        (extras[1], multiple),
        (other, old),
    ]:
        assignment.lesson_id = lesson.id
        assignment.planned_date = lesson.starts_at.astimezone(MOSCOW).date()
    cancelled.status = "cancelled"
    s.db.flush()
    course_id, group_id, student_id = s.courses[0].id, s.groups[0].id, s.students[0].id
    teaching = f"/api/v1/teaching/courses/{course_id}/groups/{group_id}"
    score = f"{teaching}/assessments/{first.id}/results/{student_id}"
    assert s.schedule()[str(single.id)]["linked_assessments"][0]["score"] is None
    assert s.client.put(score, json={"score": 0}, headers=s.teacher_headers).status_code == 200
    for lesson, status in [(single, "absent"), (old, "attended")]:
        endpoint = f"/api/v1/attendance/lessons/{lesson.id}/students/{student_id}"
        response = s.client.put(endpoint, json={"status": status}, headers=s.teacher_headers)
        assert response.status_code == 200, response.text
    old.status = "moved"
    other.date_needs_confirmation = True
    intermediate = s.lesson(-8, previous=old)
    intermediate.status = "moved"
    newest = s.lesson(-6, previous=intermediate)
    s.db.flush()
    assert s.client.put(score, json={"score": 6}, headers=s.teacher_headers).status_code == 200
    schedule = s.schedule()
    assert schedule[str(single.id)]["linked_assessments"] == [
        {"assessment_group_id": str(first.id), "score": 6, "max_score": 10}
    ]
    assert schedule[str(single.id)]["attendance_status"] == "absent"
    assert len(schedule[str(multiple.id)]["linked_assessments"]) == 2
    assert schedule[str(none.id)]["linked_assessments"] == []
    assert schedule[str(none.id)]["attendance_status"] == "unmarked"
    assert s.schedule(-2)[str(cancelled.id)]["linked_assessments"] is None
    assert s.schedule(-10)[str(old.id)]["attendance_status"] is None
    lessons = {row["id"]: row for row in s.read("/lessons").json()["items"]}
    assert lessons[str(old.id)]["attendance_status"] == "attended"
    assert lessons[str(old.id)]["latest_lesson"]["id"] == str(newest.id)
    assert lessons[str(intermediate.id)]["latest_lesson"]["id"] == str(newest.id)
    assert lessons[str(newest.id)]["attendance_status"] == "unmarked"
    assert s.db.get(Attendance, (newest.id, student_id)) is None
    works = {row["assessment_group_id"]: row for row in s.read("/assessments").json()["items"]}
    assert works[str(other.id)]["lesson_id"] == str(old.id)
    assert works[str(other.id)]["date_needs_confirmation"] is True
    assert s.read().json()["total_score"] == 6
    final = s.client.patch(
        f"/api/v1/final-results/courses/{course_id}/students/{student_id}",
        json={"grade_value": 2, "retake_location": "Тестовая аудитория"},
        headers=s.teacher_headers,
    )
    assert final.status_code == 200, final.text
    updated = s.read().json()
    assert updated["final_result"]["grade_value"] == 2
    assert updated["final_result"]["retake_location"] == "Тестовая аудитория"
    assert updated["total_score"] == 6
    new_date = (s.today + timedelta(days=3)).isoformat()
    dates = s.client.patch(
        f"/api/v1/teaching/courses/{course_id}/assessments/{other.assessment_id}/dates",
        json={
            "items": [
                {"assessment_group_id": str(other.id), "planned_date": new_date, "lesson_id": None}
            ]
        },
        headers=s.teacher_headers,
    )
    assert dates.status_code == 200, dates.text
    works = {row["assessment_group_id"]: row for row in s.read("/assessments").json()["items"]}
    assert works[str(other.id)]["planned_date"] == new_date
    assert works[str(other.id)]["date_needs_confirmation"] is False


def test_existing_announcement_feed_remains_group_scoped_and_paginated(course):
    s = course
    course_id = s.courses[0].id
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[0].id,
        group_id=s.groups[1].id,
        course_offering_id=course_id,
    )
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[2].id,
        group_id=s.groups[0].id,
        course_offering_id=course_id,
    )
    entries = [(None, 0, "Общее"), (0, 2, "Группа A"), (1, 1, "Группа B")]
    for group, author, title in entries:
        response = s.client.post(
            f"/api/v1/teaching/courses/{course_id}/announcements",
            headers={"Authorization": f"Bearer {s.teacher_tokens[author]}"},
            json={
                "group_id": str(s.groups[group].id) if group is not None else None,
                "title": title,
                "body": "Вымышленный текст",
                "is_important": group is None,
            },
        )
        assert response.status_code == 201, response.text
    first, cursor = read_pages(s, "/announcements", limit=1)
    second, _ = read_pages(s, "/announcements", student=1, limit=1)
    assert [row["title"] for row in first] == ["Группа A", "Общее"]
    assert [row["title"] for row in second] == ["Группа B", "Общее"]
    assert {row["teacher"]["id"] for row in first} == {str(s.teachers[i].id) for i in (0, 2)}
    assert first[-1]["is_important"]
    assert s.read("/announcements", student=1, limit=1, cursor=cursor).status_code == 422
    assert s.read("/announcements").headers["x-announcement-group-id"] == str(s.groups[0].id)
    s.sessions[0].revoked_at = datetime.now(UTC)
    s.db.flush()
    assert s.read("/announcements").status_code == s.read().status_code == 401
