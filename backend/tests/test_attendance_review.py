"""Regressions for origin scope, transfer boundaries and fresh SQL membership."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session
from test_academics_migrations import migration_database  # noqa: F401
from test_attendance_integration import attendance as attendance_fixture
from test_attendance_integration import events
from test_attendance_transactions import committed_attendance as create_committed_attendance
from test_attendance_transactions import wait_for_block

from app.attendance import service
from app.dependencies.database import get_db_session
from app.models import Attendance, Lesson, LessonGroup, StaffPermission, Subgroup
from app.student_service import update_student_group

pytestmark = pytest.mark.integration


@pytest.fixture
def attendance(db_session):
    return attendance_fixture.__wrapped__(db_session)


@pytest.fixture
def committed_attendance(migration_database):  # noqa: F811
    yield from create_committed_attendance.__wrapped__(migration_database)


def prepare_shared_lesson(s, transfer):
    a = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    b = s.add(Subgroup, group_id=s.groups[0].id, name="B")
    if transfer == "subgroup":
        update_student_group(s.db, s.students[0].id, s.groups[0].id, a.id)
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[1].id)
    # The initial distribution is established before the lesson starts.
    s.lesson.starts_at = datetime.now(UTC)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    s.db.flush()
    return a, b


def transfer_student(s, transfer, b, *, back=False):
    return update_student_group(
        s.db,
        s.students[0].id,
        s.groups[0 if back or transfer == "subgroup" else 1].id,
        b.id if transfer == "subgroup" else None,
    )


@pytest.mark.parametrize("transfer", ["group", "subgroup"])
def test_shared_lesson_origin_survives_transfers_and_staff_corrections(attendance, transfer):
    s = attendance
    a, b = prepare_shared_lesson(s, transfer)
    assert s.write().status_code == 200
    original = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    origin = original.origin_group_id, original.origin_subgroup_id, original.membership_version
    assert origin[:2] == (s.groups[0].id, a.id if transfer == "subgroup" else None)
    transfer_student(s, transfer, b)
    # Teacher 1 has the assignment to the new group; teacher 0 still has the old one.
    for teacher in [0, 1]:
        assert s.write("absent", teacher=teacher).status_code == 404
        assert s.write(method="delete", teacher=teacher).status_code == 404
        assert s.write(teacher=teacher).status_code == 404  # even a no-op checks origin
    assert len(events(s)) == 1
    assert s.read(lesson=s.lesson.id).json()["status"] == "attended"
    token, _ = s.staff()
    assert s.write("absent", token=token).status_code == 200
    s.db.refresh(original)
    assert (
        original.origin_group_id,
        original.origin_subgroup_id,
        original.membership_version,
    ) == origin
    assert original.marked_by_user_id != s.teacher_users[0].id  # marker is not origin
    transfer_student(s, transfer, a, back=True)
    assert s.write().status_code == 404  # returning does not reopen this historical record
    assert s.write(method="delete").status_code == 404
    assert s.read(lesson=s.lesson.id).json()["status"] == "absent"
    assert len(events(s)) == 2
    assert s.write(method="delete", token=token).status_code == 200
    # Clearing a historical mark cannot be used to recreate it in a later membership.
    assert s.write().status_code == 404
    assert s.write(token=token).status_code == 404
    assert len(events(s)) == 3


@pytest.mark.parametrize("transfer", ["group", "subgroup"])
def test_shared_lesson_cannot_receive_new_backdated_mark_after_transfer(attendance, transfer):
    s = attendance
    a, b = prepare_shared_lesson(s, transfer)
    transfer_student(s, transfer, b)
    token, _ = s.staff()
    for teacher in [0, 1]:
        assert s.write(teacher=teacher).status_code == 404
    assert s.write(token=token).status_code == 404
    transfer_student(s, transfer, a, back=True)
    assert s.write().status_code == 404
    assert s.write(token=token).status_code == 404
    assert events(s) == []
    # A new lesson starting during the current membership still works normally.
    later = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=datetime.now(UTC),
        ends_at=datetime.now(UTC) + timedelta(hours=1),
        kind="lab",
    )
    s.add(
        LessonGroup,
        lesson_id=later.id,
        group_id=s.groups[0].id,
        subgroup_id=a.id if transfer == "subgroup" else None,
    )
    assert s.write(lesson=later.id).status_code == 200
    assert s.write("absent", lesson=later.id).status_code == 200
    assert s.write(method="delete", lesson=later.id).status_code == 200


def test_membership_metadata_tracks_raw_updates_noop_and_rollback(attendance):
    s = attendance
    student_id = s.students[0].id
    before = s.db.execute(
        text("SELECT membership_version,membership_changed_at FROM students WHERE id=:id"),
        {"id": student_id},
    ).one()
    assert before[0] == 0 and before[1] is not None
    statement = text(
        "UPDATE students SET group_id=:group WHERE id=:id "
        "RETURNING membership_version,membership_changed_at"
    )
    with s.db.begin_nested() as transaction:
        changed = s.db.execute(statement, {"group": s.groups[1].id, "id": student_id}).one()
        assert changed[0] == 1 and changed[1] is not None
        assert s.db.execute(statement, {"group": s.groups[1].id, "id": student_id}).one() == changed
        transaction.rollback()
    assert (
        s.db.execute(
            text("SELECT membership_version,membership_changed_at FROM students WHERE id=:id"),
            {"id": student_id},
        ).one()
        == before
    )
    assert s.write().status_code == 200


@pytest.mark.parametrize("transfer", ["group", "subgroup"])
@pytest.mark.parametrize("read_kind", ["list", "detail"])
def test_api_read_uses_sql_membership_after_concurrent_transfer(
    committed_attendance,
    monkeypatch,
    transfer,
    read_kind,  # noqa: F811
):
    s = committed_attendance
    a = s.add(Subgroup, group_id=s.groups[0].id, name="A")
    b = s.add(Subgroup, group_id=s.groups[0].id, name="B")
    if transfer == "subgroup":
        update_student_group(s.db, s.students[0].id, s.groups[0].id, a.id)
    s.lesson.starts_at = datetime.now(UTC)
    s.lesson.ends_at = s.lesson.starts_at + timedelta(hours=1)
    old_assignment = s.db.scalar(select(LessonGroup).where(LessonGroup.lesson_id == s.lesson.id))
    old_assignment.subgroup_id = a.id if transfer == "subgroup" else None
    s.db.flush()
    assert s.write().status_code == 200
    empty = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=s.lesson.starts_at,
        ends_at=s.lesson.ends_at,
        kind="lab",
    )
    s.add(
        LessonGroup,
        lesson_id=empty.id,
        group_id=s.groups[0].id,
        subgroup_id=a.id if transfer == "subgroup" else None,
    )
    new_lesson = s.add(
        Lesson,
        course_offering_id=s.courses[0].id,
        starts_at=s.lesson.starts_at,
        ends_at=s.lesson.ends_at,
        kind="lab",
    )
    s.add(
        LessonGroup,
        lesson_id=new_lesson.id,
        group_id=s.groups[0 if transfer == "subgroup" else 1].id,
        subgroup_id=b.id if transfer == "subgroup" else None,
    )
    s.db.commit()
    engine = s.db.bind

    def request_session():
        with Session(engine, expire_on_commit=False, autoflush=False) as db:
            yield db

    s.app.dependency_overrides[get_db_session] = request_session
    loaded, resume = Event(), Event()
    original_query = service.get_attendance_query

    def paused_query(student):
        # This is the real ORM object loaded by get_current_student in the request.
        assert student.group_id == s.groups[0].id
        loaded.set()
        assert resume.wait(10)
        return original_query(student)

    monkeypatch.setattr(service, "get_attendance_query", paused_query)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(
            s.read, **({"lesson": empty.id} if read_kind == "detail" else {"limit": 1})
        )
        try:
            assert loaded.wait(10)
            with Session(engine) as db:
                update_student_group(
                    db,
                    s.students[0].id,
                    s.groups[0 if transfer == "subgroup" else 1].id,
                    b.id if transfer == "subgroup" else None,
                )
                db.commit()
        finally:
            resume.set()
        response = future.result(timeout=10)
    monkeypatch.setattr(service, "get_attendance_query", original_query)
    if read_kind == "detail":
        assert response.status_code == 404  # no unmarked lesson of the previous membership
    else:
        assert response.status_code == 200
        page = response.json()
        assert [item["lesson_id"] for item in page["items"]] == [str(s.lesson.id)]
        assert page["items"][0]["status"] == "attended"
        next_page = s.read(limit=1, cursor=page["next_cursor"]).json()
        assert [item["lesson_id"] for item in next_page["items"]] == [str(new_lesson.id)]
        assert next_page["items"][0]["status"] == "unmarked"
        assert next_page["next_cursor"] is None
    assert s.read(lesson=s.lesson.id).json()["status"] == "attended"
    assert s.read(lesson=empty.id).status_code == 404
    assert s.read(1, lesson=s.lesson.id).status_code == 404
    assert len(events(s)) == 1


@pytest.mark.parametrize("with_mark", [False, True])
def test_transfer_on_shared_lesson_is_checked_after_write_wait(
    committed_attendance,
    with_mark,  # noqa: F811
):
    s = committed_attendance
    s.add(LessonGroup, lesson_id=s.lesson.id, group_id=s.groups[1].id)
    if with_mark:
        assert s.write().status_code == 200
    s.db.commit()
    engine = s.db.bind
    writer_pid = {}
    writer_started = Event()

    def session():
        with Session(engine, autoflush=False) as db:
            writer_pid["pid"] = db.scalar(text("SELECT pg_backend_pid()"))
            writer_started.set()
            yield db

    s.app.dependency_overrides[get_db_session] = session
    with Session(engine) as transfer:
        update_student_group(transfer, s.students[0].id, s.groups[1].id)
        with ThreadPoolExecutor(max_workers=1) as pool:
            # Assignment to the new group is valid and the lesson is shared.
            future = pool.submit(s.write, "absent", teacher=1)
            # Observe an actual wait via pg_blocking_pids, without a cached
            # pg_stat_activity snapshot. Always release the lock on test failure.
            try:
                assert writer_started.wait(10)
                wait_for_block(engine, writer_pid["pid"], future)
            finally:
                transfer.commit()
            assert future.result(timeout=10).status_code == 404
    s.db.expire_all()
    assert len(events(s)) == int(with_mark)
    mark = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert (mark.status if mark else None) == ("attended" if with_mark else None)


def test_permission_revocation_does_not_interrupt_already_authorized_request(
    committed_attendance,
    monkeypatch,  # noqa: F811
):
    s = committed_attendance
    token, grant = s.staff()
    grant_id = grant.id
    s.db.commit()
    engine = s.db.bind

    def session():
        with Session(engine, autoflush=False) as db:
            yield db

    s.app.dependency_overrides[get_db_session] = session
    authorized, resume = Event(), Event()
    original = service.require_staff_permission

    def paused_permission(*args, **kwargs):
        context = original(*args, **kwargs)
        authorized.set()
        assert resume.wait(10)
        return context

    monkeypatch.setattr(service, "require_staff_permission", paused_permission)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(s.write, token=token)
        try:
            assert authorized.wait(10)
            with Session(engine) as revoke:
                revoke.execute(delete(StaffPermission).where(StaffPermission.id == grant_id))
                revoke.commit()
        finally:
            resume.set()
        assert future.result(timeout=10).status_code == 200
    monkeypatch.setattr(service, "require_staff_permission", original)
    assert s.write("absent", token=token).status_code == 403
    assert len(events(s)) == 1


def test_unknown_legacy_origin_is_staff_only_then_teacher_recreates_current_mark(attendance):
    s = attendance
    # Emulate a preserved pre-review mark, whose group cannot be reconstructed.
    s.lesson.starts_at = datetime.now(UTC) - timedelta(days=1)
    s.add(
        Attendance,
        lesson_id=s.lesson.id,
        student_id=s.students[0].id,
        status="attended",
        marked_by_user_id=s.teacher_users[0].id,
    )
    assert s.write("absent").status_code == 404
    assert s.write(method="delete").status_code == 404
    assert s.read(lesson=s.lesson.id).json()["status"] == "attended"
    token, _ = s.staff()
    assert s.write("absent", token=token).status_code == 200
    mark = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert mark.origin_group_id is None and mark.membership_version is None
    assert s.write(method="delete", token=token).status_code == 200
    assert s.write().status_code == 200
    recreated = s.db.get(Attendance, (s.lesson.id, s.students[0].id))
    assert recreated.origin_group_id == s.groups[0].id
    assert recreated.membership_version == s.students[0].membership_version
    assert s.write(token=token).status_code == 200
    assert [event.action for event in events(s)] == ["update", "delete", "create"]
