import base64
import binascii
import json
import math
from collections.abc import Callable, Iterable
from itertools import islice
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


def _validate_page_options(
    key_types: CursorKeyTypes,
    direction: SortDirection,
    limit: int,
) -> None:
    if not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    if not key_types or any(value_type not in (str, int, float) for value_type in key_types):
        raise ValueError("key_types must declare one or more supported scalar types")
    if direction not in ("asc", "desc"):
        raise ValueError("direction must be 'asc' or 'desc'")


def decode_page_cursor(
    cursor: str | None,
    *,
    key_types: CursorKeyTypes,
    direction: SortDirection,
) -> CursorKey | None:
    """Decode and validate a cursor before using its key in an SQL keyset filter.

    Compose an ascending filter with `key > cursor_key`, or a descending filter
    with `key < cursor_key`, using the same ordered columns as the query.
    """
    _validate_page_options(key_types, direction, limit=20)
    if cursor is None:
        return None
    cursor_direction, cursor_key = _decode_cursor(cursor)
    _validate_key(cursor_key, key_types, cursor=True)
    if cursor_direction != direction:
        raise InvalidCursorError("Cursor sort direction does not match this selection")
    return cursor_key


def paginate_results(
    items: Iterable[T],
    *,
    key: Callable[[T], CursorKey],
    key_types: CursorKeyTypes,
    direction: SortDirection,
    limit: int = 20,
) -> Page[T]:
    """Build a page from already cursor-filtered, ordered query results.

    The query must apply `decode_page_cursor()`'s keyset boundary, use the declared
    order and limit its result to `limit + 1`. This function consumes at most that
    many rows, checks only that bounded window for order and unique tie breakers,
    and uses the extra row to decide whether to return a next cursor. It never
    applies the cursor filter a second time.
    """
    _validate_page_options(key_types, direction, limit)
    fetched: list[tuple[T, CursorKey]] = []
    previous_key: CursorKey | None = None
    for row in islice(items, limit + 1):
        row_key = key(row)
        _validate_key(row_key, key_types, cursor=False)
        if previous_key is not None:
            is_ordered = row_key > previous_key if direction == "asc" else row_key < previous_key
            if not is_ordered:
                raise ValueError(
                    "query results must be strictly ordered by key in the declared direction"
                )
        fetched.append((row, row_key))
        previous_key = row_key

    has_more = len(fetched) > limit
    selected = fetched[:limit]
    next_cursor = _encode_cursor(selected[-1][1], direction) if selected and has_more else None
    return Page[T](items=[row for row, _row_key in selected], next_cursor=next_cursor)


def paginate(
    items: Iterable[T],
    *,
    key: Callable[[T], CursorKey],
    key_types: CursorKeyTypes,
    direction: SortDirection = "asc",
    limit: int = 20,
    cursor: str | None = None,
) -> Page[T]:
    """Page an in-memory ordered selection, applying its cursor filter locally.

    `paginate_results()` is the bounded alternative for SQL results whose cursor
    filter and `limit + 1` bound were already applied by the query.
    """
    _validate_page_options(key_types, direction, limit)
    after_key = decode_page_cursor(cursor, key_types=key_types, direction=direction)
    rows = list(items)
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

    if after_key is None:
        filtered_rows = (row for row, _row_key in ordered_rows)
    elif direction == "asc":
        filtered_rows = (row for row, row_key in ordered_rows if row_key > after_key)
    else:
        filtered_rows = (row for row, row_key in ordered_rows if row_key < after_key)
    return paginate_results(
        filtered_rows,
        key=key,
        key_types=key_types,
        direction=direction,
        limit=limit,
    )
