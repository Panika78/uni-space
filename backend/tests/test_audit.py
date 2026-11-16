from datetime import UTC, date, datetime

import pytest
from sqlalchemy.orm import Session

from app.audit import (
    _EVENT_FIELDS,
    _serialize_snapshot,
    validate_retake_location,
    write_audit_event,
)
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


def test_assessment_date_snapshot_preserves_null_and_typed_fields():
    fields = _EVENT_FIELDS["assessment_group", "update"]
    assert _serialize_snapshot(
        {
            "planned_date": date(2026, 9, 2),
            "lesson_id": 123,
            "date_needs_confirmation": False,
            "token": "excluded",
        },
        fields,
    ) == {"planned_date": "2026-09-02", "lesson_id": 123, "date_needs_confirmation": False}
    assert _serialize_snapshot(
        {"planned_date": None, "lesson_id": None, "date_needs_confirmation": True}, fields
    ) == {"planned_date": None, "lesson_id": None, "date_needs_confirmation": True}


@pytest.mark.parametrize(
    "data",
    [
        {"planned_date": "2026-09-02"},
        {"lesson_id": True},
        {"lesson_id": {"token": "secret"}},
        {"date_needs_confirmation": "false"},
    ],
)
def test_assessment_date_snapshot_rejects_untyped_values(data):
    with pytest.raises(ValueError):
        _serialize_snapshot(data, _EVENT_FIELDS["assessment_group", "update"])


@pytest.mark.parametrize("value", [True, 123, {}, "", " ", "A\n101", "A\x00101", "x" * 201])
def test_retake_location_rejects_invalid_typed_content(value):
    with pytest.raises(ValueError):
        validate_retake_location(value)


def test_retake_location_is_explicit_nullable_allowlisted_text():
    fields = _EVENT_FIELDS["final_result", "update"]
    assert _serialize_snapshot({"retake_location": "A-101", "full_name": "secret"}, fields) == {
        "retake_location": "A-101"
    }
    assert _serialize_snapshot({"retake_location": None}, fields) == {"retake_location": None}
    assert "retake_location" not in _serialize_snapshot({"student_id": 1}, fields)


@pytest.mark.parametrize("value", ["x" * 201, "", " ", "A\n\t101\x01"])
def test_audit_preserves_historical_retake_location_exactly(value):
    fields = _EVENT_FIELDS["final_result", "update"]
    assert _serialize_snapshot({"retake_location": value}, fields) == {"retake_location": value}


@pytest.mark.parametrize("value", [True, 123, {}, ["A-101"]])
def test_audit_retake_location_remains_strictly_typed(value):
    with pytest.raises(ValueError, match="requires a string"):
        _serialize_snapshot({"retake_location": value}, _EVENT_FIELDS["final_result", "update"])
