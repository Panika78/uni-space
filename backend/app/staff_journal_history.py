"""Read the allowlisted journal projection of the append-only audit."""

from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import BigInteger, String, cast, column, func, select, table, tuple_
from sqlalchemy import DateTime as SQLDateTime
from sqlalchemy.dialects.postgresql import JSONB

from app.core.pagination import InvalidCursorError, decode_page_cursor, paginate_results
from app.core.schemas import Date, DateTime, Id, RequestModel
from app.models import User

journal_events = table(
    "staff_journal_events",
    column("entity_type", String),
    column("target_id", JSONB),
    column("student_id", JSONB),
    column("id", BigInteger),
    column("created_at", SQLDateTime(timezone=True)),
    column("action", String),
    column("actor_user_id", BigInteger),
    column("before", JSONB),
    column("after", JSONB),
)


class ScoreSnapshot(RequestModel):
    score: int


class FinalSnapshot(RequestModel):
    grade_value: int | None
    passed: bool | None
    retake_date: Date | None
    retake_location: str | None


class JournalEvent[Snapshot](RequestModel):
    event_id: Id
    action: Literal["create", "update", "delete"]
    created_at: DateTime
    actor_user_id: Id | None
    actor_name: str | None
    before: Snapshot | None
    after: Snapshot | None


def _json_id(value):
    return func.to_jsonb(cast(value, BigInteger), type_=JSONB)


def event_pair(entity_type, target_id, student_id):
    c = journal_events.c
    return (
        c.entity_type == entity_type,
        c.target_id == _json_id(target_id),
        c.student_id == _json_id(student_id),
    )


def has_history(entity_type, target_id, student_id):
    return (
        select(journal_events.c.id).where(*event_pair(entity_type, target_id, student_id)).exists()
    )


def list_history(db, entity_type, target_id, student_id, params, *, identity):
    c = journal_events.c
    scope = f"{identity}:{entity_type}:{target_id}:{student_id}"
    key_types = (str, str, int)
    boundary = decode_page_cursor(params.cursor, key_types=key_types, direction="desc")
    query = (
        select(c.id, c.created_at, c.action, c.actor_user_id, User.full_name, c.before, c.after)
        .select_from(journal_events.outerjoin(User, User.id == c.actor_user_id))
        .where(*event_pair(entity_type, target_id, student_id))
    )
    if boundary:
        try:
            stamp = datetime.fromisoformat(boundary[1])
            if boundary[0] != scope or stamp.tzinfo is None or boundary[2] <= 0:
                raise ValueError
        except ValueError as exc:
            raise InvalidCursorError("Cursor does not match this history") from exc
        query = query.where(tuple_(c.created_at, c.id) < tuple_(stamp, boundary[2]))
    rows = db.execute(query.order_by(c.created_at.desc(), c.id.desc()).limit(params.limit + 1))
    page = paginate_results(
        rows,
        key=lambda row: (scope, row.created_at.astimezone(UTC).isoformat(), row.id),
        key_types=key_types,
        direction="desc",
        limit=params.limit,
    )
    return {
        "items": [
            {
                "event_id": str(row.id),
                "action": row.action,
                "created_at": row.created_at,
                "actor_user_id": str(row.actor_user_id) if row.actor_user_id is not None else None,
                "actor_name": row.full_name,
                "before": row.before,
                "after": row.after,
            }
            for row in page.items
        ],
        "next_cursor": page.next_cursor,
    }
