"""Transactional generation of personal notifications for domain writes."""

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import Notification, TeachingAssignment, User


def create_domain_notifications(
    db: Session,
    *,
    logical_event_key: str,
    recipient_user_ids: set[int] | list[int],
    notification_type: str,
    title: str,
    body: str,
    entity_type: str | None,
    entity_ids_by_user: dict[int, int] | None = None,
    audience_group_ids_by_user: dict[int, int] | None = None,
    recipient_roles: set[str] | None = None,
) -> None:
    """Insert one row per active recipient in the caller's open transaction.

    Event keys come from immutable audit/history/document rows, never from an
    entity ID or a time window. The unique event/recipient pair makes retries
    and concurrent delivery safe. This helper deliberately never commits,
    catches database failures, or chooses recipients from request values.
    """
    if not db.in_transaction():
        raise ValueError("Notifications require the domain transaction")
    if not logical_event_key or len(logical_event_key) > 120:
        raise ValueError("Invalid notification event identity")
    recipients = {int(user_id) for user_id in recipient_user_ids if int(user_id) > 0}
    if not recipients:
        return
    active = set(
        db.scalars(
            select(User.id)
            .where(
                User.id.in_(recipients),
                User.is_active.is_(True),
                User.role.in_(recipient_roles or {"student"}),
            )
            .order_by(User.id)
            .with_for_update()
        )
    )
    if not active:
        return
    rows = [
        {
            "logical_event_key": logical_event_key,
            "user_id": user_id,
            "type": notification_type,
            "title": title,
            "body": body,
            "entity_type": (
                entity_type if entity_ids_by_user and user_id in entity_ids_by_user else None
            ),
            "entity_id": entity_ids_by_user.get(user_id) if entity_ids_by_user else None,
            "audience_group_id": (
                audience_group_ids_by_user.get(user_id) if audience_group_ids_by_user else None
            ),
        }
        for user_id in sorted(active)
    ]
    db.execute(
        insert(Notification)
        .values(rows)
        .on_conflict_do_nothing(constraint="uq_notifications_logical_event_recipient")
    )


def create_schedule_notifications(
    db: Session, *, event_id: int, before: dict | None, after: dict
) -> None:
    """Notify changed student audiences using the schedule card each one sees."""
    from sqlalchemy import and_, or_

    from app.models import Student, Teacher

    def audience(snapshot: dict | None) -> dict[int, int]:
        if snapshot is None or snapshot["status"] != "scheduled":
            return {}
        scopes = snapshot["participants"]
        if not scopes:
            return {}
        predicates = [
            and_(
                Student.group_id == item["group_id"],
                *(
                    (Student.subgroup_id == item["subgroup_id"],)
                    if item["subgroup_id"] is not None
                    else ()
                ),
            )
            for item in scopes
        ]
        rows = db.execute(
            select(Student.user_id, Student.id)
            .join(User, User.id == Student.user_id)
            .where(
                Student.academic_status == "enrolled",
                User.is_active.is_(True),
                User.role == "student",
                or_(*predicates),
            )
            .with_for_update(of=Student)
        ).all()
        return {int(user_id): int(snapshot["id"]) for user_id, _student_id in rows}

    before_targets = audience(before)
    after_targets = audience(after)
    before_users = set(before_targets)
    after_users = set(after_targets)

    # Group/subgroup membership selects who sees a row; changing that selector
    # alone does not change the row shown to a student who remains in the
    # audience. The student card displays time, course, kind, teacher, rooms,
    # and moved/cancelled state, but not the full participant-group list.
    def visible_schedule(snapshot: dict | None) -> tuple | None:
        if snapshot is None:
            return None
        return (
            snapshot["id"],
            snapshot["course_offering_id"],
            snapshot["starts_at"],
            snapshot["ends_at"],
            snapshot["kind"],
            snapshot["status"],
            snapshot["teacher_id"],
            tuple(snapshot["room_ids"]),
            snapshot["previous_lesson_id"],
        )

    student_users = (before_users - after_users) | (after_users - before_users)
    if visible_schedule(before) != visible_schedule(after):
        student_users |= before_users & after_users
    targets = {
        user_id: after_targets[user_id] if user_id in after_targets else before_targets[user_id]
        for user_id in student_users
    }

    def teacher_audience(snapshot: dict | None) -> dict[int, set[int]]:
        if snapshot is None or snapshot["teacher_id"] is None or not snapshot["group_ids"]:
            return {}
        assignments = db.execute(
            select(Teacher.user_id, TeachingAssignment.group_id)
            .join(User, User.id == Teacher.user_id)
            .join(TeachingAssignment, TeachingAssignment.teacher_id == Teacher.id)
            .where(
                Teacher.id == snapshot["teacher_id"],
                TeachingAssignment.course_offering_id == snapshot["course_offering_id"],
                TeachingAssignment.group_id.in_(snapshot["group_ids"]),
                User.is_active.is_(True),
                User.role == "teacher",
            )
        ).all()
        groups_by_user: dict[int, set[int]] = {}
        for user_id, group_id in assignments:
            groups_by_user.setdefault(int(user_id), set()).add(int(group_id))
        return groups_by_user

    before_teacher_groups = teacher_audience(before)
    after_teacher_groups = teacher_audience(after)
    before_teachers = set(before_teacher_groups)
    after_teachers = set(after_teacher_groups)
    teacher_users = (before_teachers - after_teachers) | (after_teachers - before_teachers)
    for user_id in before_teachers & after_teachers:
        if (
            visible_schedule(before) != visible_schedule(after)
            or before_teacher_groups[user_id] != after_teacher_groups[user_id]
        ):
            teacher_users.add(user_id)
    create_domain_notifications(
        db,
        logical_event_key=f"audit:{event_id}",
        recipient_user_ids=student_users | teacher_users,
        notification_type="schedule_changed",
        title="Изменилось расписание",
        body="Проверьте актуальное расписание.",
        entity_type="lesson",
        entity_ids_by_user=targets,
        recipient_roles={"student", "teacher"},
    )
