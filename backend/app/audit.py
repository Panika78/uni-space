"""Minimal transactional audit writer. See docs/AUDIT.md for the caller contract."""

from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.models import AuditEvent, User


def _integer(value: object) -> int:
    if type(value) is not int:
        raise ValueError("Audit field requires an integer")
    return value


def _boolean(value: object) -> bool:
    if type(value) is not bool:
        raise ValueError("Audit field requires a boolean")
    return value


def _choice(*choices: str) -> Callable[[object], str]:
    def serialize(value: object) -> str:
        if type(value) is not str or value not in choices:
            raise ValueError("Unsupported audit field value")
        return value

    return serialize


def _timestamp(value: object) -> str:
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Audit timestamp requires a timezone-aware datetime")
    return value.astimezone(UTC).isoformat()


def _date(value: object) -> str:
    if type(value) is not date:
        raise ValueError("Audit date requires a date")
    return value.isoformat()


def _ids(value: object) -> list[int]:
    if type(value) not in (list, tuple):
        raise ValueError("Audit references require a list of integer IDs")
    return [_integer(item) for item in value]


# Explicit fields AND value serializers per event. Never traverse ORM objects,
# arbitrary nested mappings, or stringify unknown objects.
_SCORE_FIELDS = {"assessment_group_id": _integer, "student_id": _integer, "score": _integer}
_FINAL_FIELDS = {
    "course_offering_id": _integer,
    "student_id": _integer,
    "grade_value": _integer,
    "passed": _boolean,
    "retake_date": _date,
}
_LESSON_FIELDS = {
    "course_offering_id": _integer,
    "teacher_id": _integer,
    "starts_at": _timestamp,
    "ends_at": _timestamp,
    "kind": _choice("lecture", "seminar", "lab", "other"),
    "status": _choice("scheduled", "cancelled", "moved"),
    "previous_lesson_id": _integer,
    "version": _integer,
    "group_ids": _ids,
    "room_ids": _ids,
}
_ROLE = _choice("student", "teacher", "staff", "admin")
_EVENT_FIELDS = {
    **{("assessment_result", action): _SCORE_FIELDS for action in ("create", "update", "delete")},
    **{("final_result", action): _FINAL_FIELDS for action in ("create", "update", "delete")},
    **{("lesson", action): _LESSON_FIELDS for action in ("create", "update", "cancel", "move")},
    ("user", "create"): {"role": _ROLE, "is_active": _boolean},
    ("user", "set_role"): {"role": _ROLE},
    ("user", "set_active"): {"is_active": _boolean},
    ("student", "set_academic_status"): {
        "academic_status": _choice("enrolled", "academic_leave", "expelled", "graduated")
    },
}
_REASON = _choice("correction", "administrative_change", "schedule_change")


def _serialize_snapshot(data: Mapping[str, object] | None, fields: dict) -> dict | None:
    if data is None:
        return None
    if not isinstance(data, Mapping):
        raise ValueError("Audit snapshot requires a mapping")
    result = {
        name: None if data[name] is None else serialize(data[name])
        for name, serialize in fields.items()
        if name in data
    }
    if not result:
        raise ValueError("Audit snapshot must include allowed fields")
    return result


def write_audit_event(
    db: Session,
    *,
    actor: User,
    entity_type: str,
    entity_id: int,
    action: str,
    before_data: Mapping[str, object] | None,
    after_data: Mapping[str, object] | None,
    reason: str | None = None,
) -> AuditEvent:
    """Add and flush an event in the caller's transaction; propagate every error.

    Pass the User returned by get_current_user, never a request actor ID.
    Require an active caller transaction; this does not prove that the business
    change belongs to it. Call before the business commit. The caller must roll
    back the whole operation on ANY exception, including validation errors.
    No commit, rollback, session, or savepoint is created here.
    """
    fields = _EVENT_FIELDS.get((entity_type, action))
    if fields is None:
        raise ValueError("Unsupported audit event")
    if (
        not isinstance(actor, User)
        or not inspect(actor).persistent
        or inspect(actor).session is not db
    ):
        raise ValueError("Audit actor must be the authenticated User in the supplied session")
    # Avoid starting a transaction through Session.add() after commit/rollback.
    # A SELECT or a new mutation can already have triggered autobegin, so this
    # guard cannot detect an earlier, incorrectly committed business operation.
    if not db.in_transaction():
        raise ValueError("Audit requires an active caller transaction before business commit")
    if _integer(entity_id) <= 0:
        raise ValueError("Audit entity ID must be positive; flush new entities first")
    before = _serialize_snapshot(before_data, fields)
    after = _serialize_snapshot(after_data, fields)
    if action == "create":
        valid = before is None and after is not None
    elif action == "delete":
        valid = before is not None and after is None
    else:
        valid = before is not None and after is not None and before.keys() == after.keys()
    if not valid:
        raise ValueError("Invalid audit before/after shape")
    event = AuditEvent(
        actor_user_id=actor.id,
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        before_data=before,
        after_data=after,
        reason=None if reason is None else _REASON(reason),
    )
    db.add(event)
    # Flush the entire unit of work. A failed INSERT makes the Session unusable
    # until its owner rolls back; never isolate a mandatory event in a savepoint.
    db.flush()
    return event
