import base64
import binascii
import json
import math
from collections.abc import Callable, Iterable, Sequence
from typing import TypeVar

from app.core.schemas import Page

T = TypeVar("T")
CursorKey = tuple[str | int | float, ...]


class InvalidCursorError(ValueError):
    """Raised when an opaque page cursor is malformed or unsupported."""


def _encode_cursor(key: CursorKey) -> str:
    raw = json.dumps({"v": 1, "key": key}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> CursorKey:
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        decoded = json.loads(raw)
        if (
            not isinstance(decoded, dict)
            or set(decoded) != {"v", "key"}
            or type(decoded["v"]) is not int
            or decoded["v"] != 1
            or not isinstance(decoded["key"], list)
            or not decoded["key"]
            or any(type(value) not in (str, int, float) for value in decoded["key"])
            or any(type(value) is float and not math.isfinite(value) for value in decoded["key"])
        ):
            raise ValueError
        return tuple(decoded["key"])
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as exc:
        raise InvalidCursorError("Invalid cursor") from exc


def validate_cursor(cursor: str) -> None:
    _decode_cursor(cursor)


def paginate(
    items: Iterable[T],
    *,
    key: Callable[[T], CursorKey],
    limit: int = 20,
    cursor: str | None = None,
) -> Page[T]:
    """Page records already ordered by `key`, where keys increase in page order.

    The tie breaker must be part of `key` (normally the stable record ID).
    For descending database order, encode an order-preserving inverse key here.
    This helper works on supplied rows and deliberately does not define SQL queries.
    """
    if not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    rows: Sequence[T] = list(items)
    after_key = _decode_cursor(cursor) if cursor is not None else None
    if after_key is not None:
        rows = [row for row in rows if key(row) > after_key]
    selected = rows[:limit]
    has_more = len(rows) > limit
    next_cursor = _encode_cursor(key(selected[-1])) if selected and has_more else None
    return Page[T](items=list(selected), next_cursor=next_cursor)
