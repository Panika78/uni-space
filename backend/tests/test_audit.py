from datetime import UTC, date, datetime

import pytest
from sqlalchemy.orm import Session

from app.audit import _EVENT_FIELDS, _serialize_snapshot, write_audit_event
from app.models import User


@pytest.mark.parametrize("event", list(_EVENT_FIELDS))
def test_every_event_projects_only_its_explicit_fields(event):
    fields = _EVENT_FIELDS[event]
    assert not {"password", "password_hash", "token", "full_name", "form_data"} & fields.keys()
    assert _serialize_snapshot(None, fields) is None
    with pytest.raises(ValueError, match="allowed fields"):
        _serialize_snapshot({"secret": "never serialized"}, fields)


@pytest.mark.parametrize("value", [{"token": "secret"}, ["secret"], "secret", True])
def test_selected_score_field_rejects_nested_or_untyped_secret(value):
    with pytest.raises(ValueError):
        _serialize_snapshot({"score": value}, _EVENT_FIELDS["assessment_result", "update"])


def test_lesson_serialization_is_flat_and_normalizes_timestamps():
    data = {"starts_at": datetime(2026, 11, 14, tzinfo=UTC), "group_ids": [1, 2]}
    result = _serialize_snapshot(data, _EVENT_FIELDS["lesson", "update"])
    assert result == {"starts_at": "2026-11-14T00:00:00+00:00", "group_ids": [1, 2]}
    data["group_ids"].append(3)
    assert result["group_ids"] == [1, 2]
    assert _serialize_snapshot(
        {"retake_date": date(2026, 11, 14)}, _EVENT_FIELDS["final_result", "update"]
    ) == {"retake_date": "2026-11-14"}


@pytest.mark.parametrize(
    "data",
    [
        {"starts_at": datetime(2026, 11, 14)},
        {"group_ids": [{"token": "secret"}]},
        {"status": "secret"},
    ],
)
def test_lesson_rejects_unsafe_field_values(data):
    with pytest.raises(ValueError):
        _serialize_snapshot(data, _EVENT_FIELDS["lesson", "update"])


def test_unknown_event_and_request_actor_id_are_rejected():
    with Session() as db:
        with pytest.raises(ValueError, match="Unsupported audit event"):
            write_audit_event(
                db,
                actor=User(),
                entity_type="application",
                entity_id=1,
                action="update",
                before_data={},
                after_data={},
            )
        with pytest.raises(TypeError, match="actor_user_id"):
            write_audit_event(db, actor_user_id=1)


def test_participant_audit_is_typed_sorted_and_copied():
    source = [{"group_id": 2, "subgroup_id": 4}, {"group_id": 1, "subgroup_id": None}]
    result = _serialize_snapshot({"participants": source}, _EVENT_FIELDS["lesson", "restore"])
    source[0]["subgroup_id"] = 99
    assert result == {
        "participants": [{"group_id": 1, "subgroup_id": None}, {"group_id": 2, "subgroup_id": 4}]
    }


@pytest.mark.parametrize(
    "value",
    [
        None,
        "secret",
        {"group_id": 1},
        [{"group_id": True, "subgroup_id": None}],
        [{"group_id": 1, "subgroup_id": "2"}],
        [{"group_id": 1, "subgroup_id": 2, "name": "secret"}],
        [{"group_id": 1, "subgroup_id": None}] * 2,
    ],
)
def test_participant_audit_rejects_arbitrary_nested_data(value):
    with pytest.raises(ValueError):
        _serialize_snapshot({"participants": value}, _EVENT_FIELDS["lesson", "update"])
