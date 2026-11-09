import math
import threading
import time

from fastapi import HTTPException


class LoginRateLimiter:
    """Process-local fixed window keyed by the directly connected peer IP."""

    def __init__(self, limit: int = 5, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._windows: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def require_attempt(self, peer: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._windows = {key: value for key, value in self._windows.items() if value[0] > now}
            deadline, count = self._windows.get(peer, (now + self.window_seconds, 0))
            if count >= self.limit:
                raise HTTPException(
                    429,
                    "rate_limited",
                    headers={"Retry-After": str(max(1, math.ceil(deadline - now)))},
                )
            self._windows[peer] = deadline, count + 1
