"""In-process request rate limiting.

A dependency-free sliding-window limiter. State is a plain dict of timestamp
deques, which is safe under a single uvicorn worker on one event loop (the
deployment today — see ``docker-compose.yml``). It intentionally resets on
restart; if this ever runs multi-worker, swap the store for Redis.

Two call sites use it (see ``main.py`` / ``api/routes.py`` / ``channels/telegram.py``):

* a coarse per-IP ceiling on the POST endpoints (one tier), and
* the real protection — per-user caps on expensive agent turns (per-minute AND
  per-hour tiers), keyed by ``elder_id`` (HTTP) or Telegram ``chat_id``.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Callable

# (limit, window_seconds) — a request is allowed only if every tier permits it.
Tier = tuple[int, float]


class SlidingWindowLimiter:
    """Sliding-window counter keyed by an arbitrary string.

    ``now`` is injectable so tests can drive time without sleeping.
    """

    def __init__(self, *, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        # (key, window) -> timestamps of allowed hits still inside that window.
        self._events: dict[tuple[str, float], deque[float]] = defaultdict(deque)

    def check(self, key: str, tiers: list[Tier]) -> tuple[bool, float]:
        """Return ``(allowed, retry_after_seconds)`` for ``key`` across all tiers.

        Evaluated atomically: a hit is recorded only when *every* tier has room, so
        a request denied by the hourly tier doesn't consume a per-minute slot.
        """
        now = self._now()
        denied = False
        retry_after = 0.0
        queues: list[deque[float]] = []
        for limit, window in tiers:
            q = self._events[(key, window)]
            cutoff = now - window
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                denied = True
                retry_after = max(retry_after, q[0] + window - now)
            queues.append(q)
        if denied:
            return False, max(retry_after, 0.0)
        for q in queues:
            q.append(now)
        return True, 0.0


def turn_tiers(settings) -> list[Tier]:
    """Per-user agent-turn limits (per-minute + per-hour) from settings."""
    return [
        (settings.rate_limit_turns_per_minute, 60.0),
        (settings.rate_limit_turns_per_hour, 3600.0),
    ]


def http_tiers(settings) -> list[Tier]:
    """Coarse per-IP ceiling for the POST endpoints (per-minute)."""
    return [(settings.rate_limit_http_per_minute, 60.0)]
