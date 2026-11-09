import base64
import binascii
import json
import math
from collections.abc import Callable, Iterable, Sequence
from typing import Literal, TypeVar

from app.core.schemas import Page

T = TypeVar("T")
CursorKey = tuple[str | int | float, ...]
CursorKeyTypes = tuple[type[str] | type[int] | type[float], ...]
SortDirection = Literal["asc", "desc"]


class InvalidCursorError(ValueError):
    """Raised when an opaque page cursor is malformed or unsupported."""


def _encode_cursor(key: CursorKey, direction: SortDirection) -> str:
    raw = json.dumps({"v": 2, "direction": direction, "key": key}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[SortDirection, CursorKey]:
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        decoded = json.loads(raw)
        if (
            not isinstance(decoded, dict)
            or set(decoded) != {"v", "direction", "key"}
            or type(decoded["v"]) is not int
            or decoded["v"] != 2
            or decoded["direction"] not in ("asc", "desc")
            or not isinstance(decoded["key"], list)
            or not decoded["key"]
            or any(type(value) not in (str, int, float) for value in decoded["key"])
            or any(type(value) is float and not math.isfinite(value) for value in decoded["key"])
        ):
            raise ValueError
        return decoded["direction"], tuple(decoded["key"])
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as exc:
        raise InvalidCursorError("Invalid cursor") from exc


def validate_cursor(cursor: str) -> None:
    _decode_cursor(cursor)


def _validate_key(key: CursorKey, key_types: CursorKeyTypes, *, cursor: bool) -> None:
    if (
        not isinstance(key, tuple)
        or len(key) != len(key_types)
        or any(type(value) is not expected for value, expected in zip(key, key_types, strict=True))
    ):
        if cursor:
            raise InvalidCursorError("Cursor does not match this selection")
        raise ValueError("key() returned a key that does not match key_types")


def paginate(
    items: Iterable[T],
    *,
    key: Callable[[T], CursorKey],
    key_types: CursorKeyTypes,
    direction: SortDirection = "asc",
    limit: int = 20,
    cursor: str | None = None,
) -> Page[T]:
    """Page records already ordered by a strict, unique key in the declared direction.

    `key_types` declares the full key schema so an empty selection can still reject a
    cursor created for another selection. Include a unique tie breaker (normally the
    record ID). `direction` must match the database order, such as `created_at DESC,
    id DESC`. This helper validates the supplied order and does not define SQL queries.
    """
    if not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    if not key_types or any(value_type not in (str, int, float) for value_type in key_types):
        raise ValueError("key_types must declare one or more supported scalar types")
    if direction not in ("asc", "desc"):
        raise ValueError("direction must be 'asc' or 'desc'")

    after_key: CursorKey | None = None
    if cursor is not None:
        cursor_direction, after_key = _decode_cursor(cursor)
        _validate_key(after_key, key_types, cursor=True)
        if cursor_direction != direction:
            raise InvalidCursorError("Cursor sort direction does not match this selection")

    rows: Sequence[T] = list(items)
    ordered_rows: list[tuple[T, CursorKey]] = []
    previous_key: CursorKey | None = None
    for row in rows:
        row_key = key(row)
        _validate_key(row_key, key_types, cursor=False)
        if previous_key is not None:
            is_ordered = row_key > previous_key if direction == "asc" else row_key < previous_key
            if not is_ordered:
                raise ValueError("items must be strictly ordered by key in the declared direction")
        ordered_rows.append((row, row_key))
        previous_key = row_key

    if after_key is not None:
        if direction == "asc":
            ordered_rows = [pair for pair in ordered_rows if pair[1] > after_key]
        else:
            ordered_rows = [pair for pair in ordered_rows if pair[1] < after_key]
    selected_pairs = ordered_rows[:limit]
    has_more = len(ordered_rows) > limit
    next_cursor = (
        _encode_cursor(selected_pairs[-1][1], direction) if selected_pairs and has_more else None
    )
    selected = [row for row, _row_key in selected_pairs]
    return Page[T](items=list(selected), next_cursor=next_cursor)
