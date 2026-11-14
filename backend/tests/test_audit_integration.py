"""Real PostgreSQL transactions, using separate connections to verify durability."""

from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import BigInteger, DateTime, delete, inspect, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError, PendingRollbackError
from sqlalchemy.orm import Session

from app.audit import write_audit_event
from app.models import AuditEvent, User

pytestmark = pytest.mark.integration


@pytest.fixture
def audit_context(postgresql_engine):
    with Session(postgresql_engine, expire_on_commit=False, autoflush=False) as db:
        actor = User(
            login=f"audit-actor-{uuid4().hex}",
            password_hash="fictional-unusable",
            full_name="Fictional Actor",
            role="admin",
            is_active=True,
        )
        target = User(
            login=f"audit-target-{uuid4().hex}",
            password_hash="fictional-unusable",
            full_name="Fictional Target",
            role="student",
            is_active=True,
        )
        db.add_all([actor, target])
        db.commit()
        ids = actor.id, target.id
        try:
            yield db, actor, target
        finally:
            db.rollback()
            db.execute(delete(AuditEvent).where(AuditEvent.actor_user_id == ids[0]))
            db.execute(delete(User).where(User.id.in_(ids)))
            db.commit()


def record_change(db, actor, target, **kwargs):
    return write_audit_event(
        db,
        actor=actor,
        entity_type="user",
        entity_id=target.id,
        action="set_active",
        before_data={"is_active": True},
        after_data={"is_active": False},
        **kwargs,
    )


@pytest.mark.parametrize("commit", [True, False])
def test_business_change_and_audit_share_commit_or_rollback(
    audit_context, postgresql_engine, commit
):
    db, actor, target = audit_context
    target.is_active = False
    transaction = db.get_transaction()
    event = record_change(db, actor, target, reason="administrative_change")
    assert inspect(event).session is db
    # Writer uses the existing transaction and flushes even with autoflush=False.
    assert db.get_transaction() is transaction
    assert db.scalar(select(User.is_active).where(User.id == target.id)) is False
    assert db.scalar(select(AuditEvent).where(AuditEvent.id == event.id)) is event
    assert event.actor_user_id == actor.id
    assert event.before_data == {"is_active": True}
    assert event.after_data == {"is_active": False}
    assert event.reason == "administrative_change"
    assert event.created_at.utcoffset() == timedelta(0)
    assert event.created_at == db.scalar(text("SELECT transaction_timestamp()"))
    with Session(postgresql_engine) as observer:
        assert observer.get(User, target.id).is_active is True
        assert observer.get(AuditEvent, event.id) is None
    event_id, target_id = event.id, target.id
    db.commit() if commit else db.rollback()
    with Session(postgresql_engine) as observer:
        assert observer.get(User, target_id).is_active is (not commit)
        assert (observer.get(AuditEvent, event_id) is not None) is commit


def test_audit_insert_failure_prevents_partial_business_commit(audit_context, postgresql_engine):
    db, actor, target = audit_context
    target_id = target.id
    target.is_active = False
    # Simulate an actor disappearing before the mandatory audit INSERT: the
    # User object remains attached, but PostgreSQL must reject the audit FK.
    db.execute(delete(User).where(User.id == actor.id).execution_options(synchronize_session=False))
    with pytest.raises(IntegrityError):
        record_change(db, actor, target)
    with pytest.raises(PendingRollbackError):
        db.commit()
    db.rollback()
    with Session(postgresql_engine) as observer:
        assert observer.get(User, target_id).is_active is True
        assert observer.scalar(select(AuditEvent).where(AuditEvent.entity_id == target_id)) is None
        assert observer.get(User, actor.id) is not None


def test_new_entity_flush_and_safe_jsonb_ignore_client_actor(audit_context, postgresql_engine):
    db, actor, target = audit_context
    payload = {
        "role": "student",
        "is_active": True,
        "actor_user_id": target.id,
        "password": "secret",
        "password_hash": "secret",
        "token": "secret",
        "refresh_token": "secret",
        "cookie": "secret",
        "private_key": "secret",
        "attachments": [{"content": "secret"}],
        "form_data": {"private": "secret"},
        "full_name": "Private Name",
        "login": "private-login",
        "email": "private@example.test",
        "avatar_storage_key": "secret",
    }
    created = User(
        login=f"audit-new-{uuid4().hex}",
        full_name="Fictional New",
        password_hash="fictional-unusable",
        role="student",
        is_active=True,
    )
    db.add(created)
    assert created.id is None
    db.flush()
    event = write_audit_event(
        db,
        actor=actor,
        entity_type="user",
        entity_id=created.id,
        action="create",
        before_data=None,
        after_data=payload,
    )
    # Serialization made an independent copy, not a reference to request data.
    payload["role"] = "admin"
    row = db.execute(
        text(
            "SELECT actor_user_id, before_data IS NULL, after_data, pg_typeof(after_data)::text "
            "FROM audit_events WHERE id=:id"
        ),
        {"id": event.id},
    ).one()
    assert row == (actor.id, True, {"role": "student", "is_active": True}, "jsonb")
    entity_id, event_id = created.id, event.id
    db.rollback()
    with Session(postgresql_engine) as observer:
        assert observer.get(User, entity_id) is None
        assert observer.get(AuditEvent, event_id) is None


@pytest.mark.parametrize("actor_kind", ["id", "none", "detached", "other_session"])
def test_writer_rejects_untrusted_actor_forms(audit_context, postgresql_engine, actor_kind):
    db, actor, target = audit_context
    with Session(postgresql_engine) as other:
        invalid = {
            "id": actor.id,
            "none": None,
            "detached": User(id=actor.id),
            "other_session": other.get(User, actor.id),
        }[actor_kind]
        with pytest.raises(ValueError, match="actor"):
            record_change(db, invalid, target)
    assert db.scalar(select(AuditEvent).where(AuditEvent.entity_id == target.id)) is None


def test_schema_has_expected_types_foreign_key_and_entity_history_index(postgresql_engine):
    inspector = inspect(postgresql_engine)
    columns = {column["name"]: column for column in inspector.get_columns("audit_events")}
    for name in ("id", "actor_user_id", "entity_id"):
        assert isinstance(columns[name]["type"], BigInteger)
    for name in ("before_data", "after_data"):
        assert isinstance(columns[name]["type"], JSONB)
        assert columns[name]["nullable"]
    assert isinstance(columns["created_at"]["type"], DateTime)
    assert columns["created_at"]["type"].timezone
    assert columns["created_at"]["default"]
    assert not columns["created_at"]["nullable"]
    assert columns["actor_user_id"]["nullable"]
    assert inspector.get_foreign_keys("audit_events")[0]["referred_table"] == "users"
    assert inspector.get_indexes("audit_events")[0]["column_names"] == [
        "entity_type",
        "entity_id",
        "created_at",
        "id",
    ]


@pytest.mark.parametrize("change", ["shape", "empty", "reason", "nested", "entity_id"])
def test_invalid_event_rolls_back_callers_operation(audit_context, postgresql_engine, change):
    db, actor, target = audit_context
    target_id = target.id
    target.is_active = False
    db.flush()
    args = dict(
        actor=actor,
        entity_type="user",
        entity_id=target_id,
        action="set_active",
        before_data={"is_active": True},
        after_data={"is_active": False},
    )
    args.update(
        {
            "shape": {"before_data": None},
            "empty": {"after_data": {"password": "secret"}},
            "reason": {"reason": "secret"},
            "nested": {"after_data": {"is_active": {"token": "secret"}}},
            "entity_id": {"entity_id": None},
        }[change]
    )
    # Validation errors must also propagate to the transaction owner.
    with pytest.raises(ValueError):
        write_audit_event(db, **args)
    db.rollback()
    with Session(postgresql_engine) as observer:
        assert observer.get(User, target_id).is_active is True
        assert observer.scalar(select(AuditEvent).where(AuditEvent.entity_id == target_id)) is None


def test_secrets_are_removed_from_both_snapshots(audit_context):
    db, actor, target = audit_context
    forbidden = {
        key: {"secret": "never persist"}
        for key in (
            "password",
            "password_hash",
            "token",
            "cookie",
            "private_key",
            "attachments",
            "form_data",
            "full_name",
            "actor_user_id",
        )
    }
    event = write_audit_event(
        db,
        actor=actor,
        entity_type="user",
        entity_id=target.id,
        action="set_active",
        before_data={"is_active": True, **forbidden},
        after_data={"is_active": False, **forbidden},
    )
    db.expire(event)
    assert event.before_data == {"is_active": True}
    assert event.after_data == {"is_active": False}
    assert event.actor_user_id == actor.id
