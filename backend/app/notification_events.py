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
    """Notify the union of current student audiences before and after a lesson write."""
    from sqlalchemy import and_, or_

    from app.models import Student, Teacher

    def audience(snapshot: dict | None) -> tuple[set[int], dict[int, int]]:
        if snapshot is None or snapshot["status"] != "scheduled":
            return set(), {}
        scopes = snapshot["participants"]
        if not scopes:
            return set(), {}
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
        targets = {int(user_id): int(snapshot["id"]) for user_id, _student_id in rows}
        return set(targets), targets

    before_users, targets = audience(before)
    after_users, after_targets = audience(after)
    targets.update(after_targets)
    teacher_ids = {
        int(snapshot["teacher_id"])
        for snapshot in (before, after)
        if snapshot is not None and snapshot["teacher_id"] is not None
    }
    teacher_scopes = []
    for snapshot in (before, after):
        if snapshot is not None and snapshot["teacher_id"] is not None:
            groups = snapshot["group_ids"]
            if groups:
                teacher_scopes.append(
                    (
                        snapshot["teacher_id"],
                        snapshot["course_offering_id"],
                        groups,
                    )
                )
    teacher_users = set()
    if teacher_ids and teacher_scopes:
        from sqlalchemy import and_, or_

        teacher_users = set(
            db.scalars(
                select(Teacher.user_id)
                .join(User, User.id == Teacher.user_id)
                .join(TeachingAssignment, TeachingAssignment.teacher_id == Teacher.id)
                .where(
                    Teacher.id.in_(teacher_ids),
                    User.is_active.is_(True),
                    User.role == "teacher",
                    or_(
                        *[
                            and_(
                                TeachingAssignment.teacher_id == teacher_id,
                                TeachingAssignment.course_offering_id == course_id,
                                TeachingAssignment.group_id.in_(group_ids),
                            )
                            for teacher_id, course_id, group_ids in teacher_scopes
                        ]
                    ),
                )
            )
        )
    create_domain_notifications(
        db,
        logical_event_key=f"audit:{event_id}",
        recipient_user_ids=before_users | after_users | teacher_users,
        notification_type="schedule_changed",
        title="Изменилось расписание",
        body="Проверьте актуальное расписание.",
        entity_type="lesson",
        entity_ids_by_user=targets,
        recipient_roles={"student", "teacher"},
    )
