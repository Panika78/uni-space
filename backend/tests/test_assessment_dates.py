"""Teacher date API on real PostgreSQL, including failure atomicity."""

from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select
from test_teaching_integration import journal  # noqa: F401

from app.models import Assessment, AssessmentGroup, AuditEvent, Lesson, LessonGroup, Subgroup

pytestmark = pytest.mark.integration


@pytest.fixture
def dates_context(journal):  # noqa: F811
    s = journal
    s.work = s.assignment(s.courses[0])
    s.other = s.assignment(
        s.courses[0], group=1, assessment=s.db.get(Assessment, s.work.assessment_id)
    )
    s.result(s.work, 7)
    s.lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=datetime(2026, 9, 1, 22, tzinfo=UTC),
        ends_at=datetime(2026, 9, 1, 23, tzinfo=UTC),
        kind="lab",
    )
    subgroup = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    s.students[0].subgroup_id = subgroup.id
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[0].id, subgroup_id=subgroup.id)
    # Persist the fixture savepoint so endpoint rollback preserves its data.
    s.db.commit()

    def patch(items=None, teacher=0, **kwargs):
        path = (
            f"/api/v1/teaching/courses/{s.courses[0].id}/assessments/{s.work.assessment_id}/dates"
        )
        return s.client.patch(
            path,
            json={"items": items or [item(s.work)]},
            headers={"Authorization": f"Bearer {s.teacher_tokens[teacher]}"},
            **kwargs,
        )

    s.patch = patch
    return s


def item(row, planned_date="2026-09-02", lesson_id=None):
    return dict(
        assessment_group_id=str(row.id),
        planned_date=planned_date,
        lesson_id=str(lesson_id) if lesson_id else None,
    )


def events(s):
    return s.db.scalars(
        select(AuditEvent)
        .where(AuditEvent.entity_type == "assessment_group")
        .order_by(AuditEvent.id)
    ).all()


def test_group_dates_confirmation_audit_noop_and_student_regression(dates_context):
    s = dates_context
    from app.schedule.router import router as schedule_router

    s.app.include_router(schedule_router)

    def schedule():
        return s.client.get(
            "/api/v1/schedule",
            params={"date_from": "2026-09-01", "date_to": "2026-09-03"},
            headers={"Authorization": f"Bearer {s.tokens[0]}"},
        )

    schedule_before = schedule()
    assert schedule_before.status_code == 200, schedule_before.text
    assert len(schedule_before.json()["items"]) == 1
    before = s.request().json()
    s.work.date_needs_confirmation = True
    s.db.commit()
    request = [item(s.work, lesson_id=s.lesson.id)]
    response = s.patch(request)
    assert response.status_code == 200, response.text
    assert response.json()["items"] == [{**request[0], "date_needs_confirmation": False}]
    assert s.db.get(AssessmentGroup, s.other.id).planned_date is None
    audit = events(s)
    assert len(audit) == 1
    assert audit[0].entity_id == s.work.id
    assert audit[0].actor_user_id == s.teacher_users[0].id
    assert audit[0].before_data == dict(
        planned_date=None, lesson_id=None, date_needs_confirmation=True
    )
    assert audit[0].after_data == dict(
        planned_date="2026-09-02", lesson_id=s.lesson.id, date_needs_confirmation=False
    )
    assert s.patch(request).status_code == 200
    assert len(events(s)) == 1
    assert s.request().json() == before
    assert schedule().json() == schedule_before.json()
    assert s.get(f"assessments/{s.work.id}/results").json()["items"][0]["score"] == 7
    assert s.db.get(Assessment, s.work.assessment_id).max_score == 10
    assert s.db.get(Lesson, s.lesson.id).version == 1
    assert s.get("assessments").json()["items"][0]["planned_date"] == "2026-09-02"
    assert s.patch([item(s.work, None)]).status_code == 200
    assert s.db.get(AssessmentGroup, s.work.id).lesson_id is None
    assert not s.db.get(AssessmentGroup, s.work.id).date_needs_confirmation


@pytest.mark.parametrize("bad", ["other", "missing", "wrong_work", "bad_lesson"])
def test_batch_rejects_whole_action_without_partial_audit(dates_context, bad):
    from app.models import TeachingAssignment

    s = dates_context
    if bad == "other":
        invalid = item(s.other)
    elif bad == "missing":
        invalid = dict(item(s.work), assessment_group_id="9223372036854775807")
    elif bad == "wrong_work":
        wrong = s.assignment(s.courses[0])
        s.db.commit()
        invalid = item(wrong)
    else:
        invalid = item(s.other, lesson_id=s.lesson.id)
        s.add(
            TeachingAssignment,
            teacher_id=s.teachers[0].id,
            course_offering_id=s.courses[0].id,
            group_id=s.groups[1].id,
        )
        s.db.commit()
    response = s.patch([item(s.work), invalid])
    assert response.status_code == 404, response.text
    assert s.db.get(AssessmentGroup, s.work.id).planned_date is None
    assert not events(s)


def test_multiple_authorized_groups_have_independent_dates(dates_context):
    from app.models import TeachingAssignment

    s = dates_context
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[0].id,
        course_offering_id=s.courses[0].id,
        group_id=s.groups[1].id,
    )
    s.db.commit()
    response = s.patch([item(s.other, "2026-09-03"), item(s.work)])
    assert response.status_code == 200, response.text
    assert len(events(s)) == 2
    assert s.db.get(AssessmentGroup, s.work.id).planned_date == date(2026, 9, 2)
    assert s.db.get(AssessmentGroup, s.other.id).planned_date == date(2026, 9, 3)


@pytest.mark.parametrize(
    "changes",
    [
        {"planned_date": "2026-09-01"},
        {"planned_date": None},
        {"planned_date": "2026-02-30"},
        {"planned_date": "2026-09-02T00:00:00Z"},
        {"lesson_id": "9223372036854775808"},
        {"lesson_id": 1},
        {"max_score": 100},
        {"date_needs_confirmation": True},
    ],
)
def test_invalid_dates_and_forbidden_fields(dates_context, changes):
    s = dates_context
    response = s.patch([{**item(s.work, lesson_id=s.lesson.id), **changes}])
    assert response.status_code == 422, response.text
    assert not events(s)


@pytest.mark.parametrize("status", ["cancelled", "moved"])
def test_cannot_confirm_stale_link_but_can_explicitly_unlink(dates_context, status):
    s = dates_context
    s.work.lesson_id = s.lesson.id
    s.work.planned_date = date(2026, 9, 2)
    s.work.date_needs_confirmation = True
    s.lesson.status = status
    s.db.commit()
    assert s.patch([item(s.work, lesson_id=s.lesson.id)]).status_code == 422
    assert s.db.get(AssessmentGroup, s.work.id).date_needs_confirmation
    assert not events(s)
    assert s.patch([item(s.work)]).status_code == 200
    assert not s.db.get(AssessmentGroup, s.work.id).date_needs_confirmation


def test_explicit_link_required_and_wrong_offering_hidden(dates_context):
    s = dates_context
    assert s.patch([item(s.work, lesson_id=s.lesson.id)]).status_code == 200
    # Retaining old link with a different date is invalid; omitting lesson_id
    # is also invalid, so clients must explicitly unlink or rebind.
    assert s.patch([item(s.work, "2026-09-03", s.lesson.id)]).status_code == 422
    missing = item(s.work)
    del missing["lesson_id"]
    assert s.patch([missing]).status_code == 422
    other = s.add(
        Lesson,
        course_offering_id=s.courses[1].id,
        starts_at=s.lesson.starts_at,
        ends_at=s.lesson.ends_at,
        kind="lab",
    )
    s.add(LessonGroup, lesson_id=other.id, group_id=s.groups[0].id)
    s.db.commit()
    assert s.patch([item(s.work, lesson_id=other.id)]).status_code == 404
    assert s.patch([item(s.work), item(s.work)]).status_code == 422


def test_revoked_scope_roles_and_audit_failure_rollback(dates_context, monkeypatch):
    s = dates_context
    assert s.patch(teacher=1).status_code == 404
    assert s.patch(teacher=2).status_code == 404
    token = s.teacher_tokens[0]
    s.teacher_tokens[0] = s.tokens[0]
    assert s.patch().status_code == 403
    s.teacher_tokens[0] = token

    def fail(*args, **kwargs):
        raise ValueError("audit failed")

    monkeypatch.setattr("app.teaching.dates.write_audit_event", fail)
    assert s.patch().status_code == 500
    assert s.db.get(AssessmentGroup, s.work.id).planned_date is None
    assert not events(s)
    s.db.delete(s.grants[0])
    s.db.commit()
    assert s.patch().status_code == 404


@pytest.mark.parametrize("sqlstate", ["55P03", "40001", "40P01"])
def test_database_conflict_rolls_back_entire_request(dates_context, monkeypatch, sqlstate):
    from sqlalchemy.exc import OperationalError

    s = dates_context

    class Conflict(Exception):
        pass

    error = Conflict()
    error.sqlstate = sqlstate

    def fail(*args, **kwargs):
        raise OperationalError("conflict", {}, error)

    monkeypatch.setattr("app.teaching.dates.write_audit_event", fail)
    response = s.patch()
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "version_conflict"
    assert s.db.get(AssessmentGroup, s.work.id).planned_date is None
    assert not events(s)


def test_second_group_audit_failure_rolls_back_first_group_and_event(dates_context, monkeypatch):
    from app.audit import write_audit_event
    from app.models import TeachingAssignment

    s = dates_context
    s.add(
        TeachingAssignment,
        teacher_id=s.teachers[0].id,
        course_offering_id=s.courses[0].id,
        group_id=s.groups[1].id,
    )
    s.db.commit()
    calls = []

    def fail_second(*args, **kwargs):
        calls.append(kwargs["entity_id"])
        if len(calls) == 2:
            raise ValueError("second audit failed")
        return write_audit_event(*args, **kwargs)

    monkeypatch.setattr("app.teaching.dates.write_audit_event", fail_second)
    assert s.patch([item(s.work), item(s.other)]).status_code == 500
    assert len(calls) == 2
    assert not events(s)
    assert s.db.get(AssessmentGroup, s.work.id).planned_date is None
    assert s.db.get(AssessmentGroup, s.other.id).planned_date is None
