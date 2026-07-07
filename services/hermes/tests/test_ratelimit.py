"""Rate-limiting: the sliding-window limiter, per-user turn caps on /agent/turn,
the coarse per-IP middleware, and the strict-auth JWT gate.

The HTTP tests drive the ASGI app through httpx's ASGITransport, which does NOT
run the lifespan — so we populate ``app.state`` by hand and stub the agent turn,
keeping the tests offline (no LLM, no Supabase, no fastText warmup).
"""

from __future__ import annotations

import httpx

import hermes.api.routes as routes
from fakes import FakeSupabase
from hermes.config import get_settings
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter


# --- Unit: the limiter itself ----------------------------------------------
def test_allows_up_to_limit_then_denies():
    clock = {"t": 1000.0}
    limiter = SlidingWindowLimiter(now=lambda: clock["t"])
    tiers = [(3, 60.0)]

    assert limiter.check("k", tiers)[0] is True
    assert limiter.check("k", tiers)[0] is True
    assert limiter.check("k", tiers)[0] is True
    allowed, retry_after = limiter.check("k", tiers)
    assert allowed is False
    assert 0 < retry_after <= 60


def test_window_slides_and_reallows():
    clock = {"t": 0.0}
    limiter = SlidingWindowLimiter(now=lambda: clock["t"])
    tiers = [(1, 60.0)]

    assert limiter.check("k", tiers)[0] is True
    assert limiter.check("k", tiers)[0] is False
    clock["t"] = 61.0  # first hit has aged out of the window
    assert limiter.check("k", tiers)[0] is True


def test_keys_are_independent():
    limiter = SlidingWindowLimiter(now=lambda: 0.0)
    tiers = [(1, 60.0)]
    assert limiter.check("a", tiers)[0] is True
    assert limiter.check("b", tiers)[0] is True  # different key, own budget


def test_denied_tier_does_not_consume_other_tier():
    # per-minute allows, per-hour is already exhausted -> deny, and the per-minute
    # slot must NOT be consumed by the rejected request.
    clock = {"t": 0.0}
    limiter = SlidingWindowLimiter(now=lambda: clock["t"])
    both = [(5, 60.0), (2, 3600.0)]  # per-minute cap 5, per-hour cap 2

    assert limiter.check("k", both)[0] is True
    assert limiter.check("k", both)[0] is True
    # hourly cap (2) now full -> next denied even though per-minute (5) has room.
    assert limiter.check("k", both)[0] is False
    # the denied request must not have consumed a per-minute slot: after the hour
    # clears, the minute tier still has budget for a fresh hit.
    clock["t"] = 3601.0
    assert limiter.check("k", both)[0] is True


# --- HTTP: per-user turn cap, per-IP middleware, strict auth ----------------
def _make_app(monkeypatch):
    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        return "ok", [], history or []

    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None
    return app


def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def test_agent_turn_per_user_cap_returns_429(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 2, raising=False)
    monkeypatch.setattr(s, "rate_limit_http_per_minute", 1000, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)
    body = {"message": "hi", "elder_id": "00000000-0000-0000-0000-00000000000a"}

    async with _client(app) as c:
        assert (await c.post("/agent/turn", json=body)).status_code == 200
        assert (await c.post("/agent/turn", json=body)).status_code == 200
        resp = await c.post("/agent/turn", json=body)
        assert resp.status_code == 429
        assert resp.headers.get("Retry-After")
        # A different elder has an independent budget.
        other = {"message": "hi", "elder_id": "00000000-0000-0000-0000-00000000000b"}
        assert (await c.post("/agent/turn", json=other)).status_code == 200


async def test_per_ip_middleware_returns_429(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_http_per_minute", 2, raising=False)
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1000, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)
    # Vary elder so the per-user cap can't be what trips — only the per-IP cap can.
    async with _client(app) as c:
        for i in range(2):
            body = {"message": "hi", "elder_id": f"00000000-0000-0000-0000-00000000000{i}"}
            assert (await c.post("/agent/turn", json=body)).status_code == 200
        resp = await c.post("/agent/turn", json={"message": "hi", "elder_id": "x"})
        assert resp.status_code == 429


async def test_strict_auth_requires_jwt(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "hermes_strict_auth", True, raising=False)
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1000, raising=False)
    monkeypatch.setattr(s, "rate_limit_http_per_minute", 1000, raising=False)
    app = _make_app(monkeypatch)
    async with _client(app) as c:
        # No jwt -> refused (won't mint a token for a caller-supplied elder_id).
        resp = await c.post("/agent/turn", json={"message": "hi", "elder_id": "x"})
        assert resp.status_code == 401


async def test_rate_limit_disabled_bypasses_cap(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", False, raising=False)
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)
    body = {"message": "hi", "elder_id": "00000000-0000-0000-0000-00000000000a"}
    async with _client(app) as c:
        for _ in range(5):
            assert (await c.post("/agent/turn", json=body)).status_code == 200
