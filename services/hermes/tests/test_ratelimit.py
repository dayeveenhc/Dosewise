"""Rate-limiting: the sliding-window limiter, per-user turn caps on /agent/turn,
the coarse per-IP middleware, and the strict-auth JWT gate.

The HTTP tests drive the ASGI app through httpx's ASGITransport, which does NOT
run the lifespan — so we populate ``app.state`` by hand and stub the agent turn,
keeping the tests offline (no LLM, no Supabase, no fastText warmup).
"""

from __future__ import annotations

import base64

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


# --- Security-verification pass (Track B): adversarial rate-limit probes ----
async def test_profile_extract_has_no_rate_limit_ceiling(monkeypatch):
    """/profile/extract calls a paid vision LLM and is reachable pre-account
    (no JWT required by design), yet unlike /agent/turn and /telegram/webhook
    it is absent from ``main._RATE_LIMITED_PATHS`` and its handler never calls
    ``limiter.check(...)`` either. This asserts the SECURE behaviour (a late
    request eventually gets 429) so it fails loudly today, proving the gap.
    """
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", True, raising=False)
    monkeypatch.setattr(s, "rate_limit_http_per_minute", 3, raising=False)

    async def fake_extract(client, *, image_bytes=None, image_media_type=None, pdf_text=None):
        return {"name": "Test Elder"}

    monkeypatch.setattr(routes, "extract_profile_fields", fake_extract)
    app = _make_app(monkeypatch)

    body = {"image_base64": base64.b64encode(b"fake-image-bytes").decode()}
    statuses = []
    async with _client(app) as c:
        # Well past rate_limit_http_per_minute (3) requests, same simulated IP,
        # all within the same real-time window (no sleeping between calls).
        for _ in range(10):
            resp = await c.post("/profile/extract", json=body)
            statuses.append(resp.status_code)

    # Currently EVERY request returns 200 — no ceiling is ever applied to this
    # endpoint, so a caller can hammer the paid vision LLM without limit.
    assert 429 in statuses, (
        "/profile/extract should start refusing once the per-IP ceiling is "
        f"exceeded, but got no 429s across {len(statuses)} requests: {statuses}"
    )


async def test_agent_turn_elder_id_rotation_bypasses_per_user_cap(monkeypatch):
    """Documents a known, accepted limitation of non-strict-auth mode: when
    ``hermes_strict_auth`` is False (the default), ``elder_id`` is a raw
    client-supplied string, and the per-user turn cap is keyed by
    ``f"turn:{elder_id}"``. Rotating elder_id per request therefore gives each
    request its own fresh per-user budget, leaving only the shared per-IP
    ceiling as protection. This is NOT expected to change in this pass — the
    test passes today and pins the current (bypassable) behaviour so a future
    fix has a clear regression signal to update, rather than leaving this gap
    silently undocumented.
    """
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 3, raising=False)
    monkeypatch.setattr(s, "rate_limit_http_per_minute", 10_000, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)

    n = s.rate_limit_turns_per_minute  # 3
    statuses = []
    async with _client(app) as c:
        for i in range(n + 1):
            body = {"message": "hi", "elder_id": f"rotating-elder-{i}"}
            resp = await c.post("/agent/turn", json=body)
            statuses.append(resp.status_code)

    # Known/accepted limitation: every request gets a brand-new per-elder_id
    # budget, so the per-user cap never engages even though N+1 turn requests
    # were made from the same (simulated) caller in the same window.
    assert statuses == [200] * (n + 1)


async def test_base64_decode_error_is_friendly_not_500(monkeypatch):
    """Both /agent/turn and /profile/extract call ``base64.b64decode(...)``
    outside any try/except, unlike the rest of each handler which deliberately
    catches broad Exception and returns a friendly 200 (see
    ``test_turn_error_returns_friendly_reply_not_500`` in
    test_api_agent_turn.py for the established convention). Malformed base64
    should follow that same convention, not surface as a bare 500.
    """

    async def fake_extract(client, *, image_bytes=None, image_media_type=None, pdf_text=None):
        return {}

    monkeypatch.setattr(routes, "extract_profile_fields", fake_extract)
    app = _make_app(monkeypatch)

    bad_b64 = "not-valid-base64!!!"
    async with _client(app) as c:
        turn_resp = await c.post(
            "/agent/turn",
            json={
                "message": "hi",
                "elder_id": "00000000-0000-0000-0000-00000000000a",
                "image_base64": bad_b64,
            },
        )
        extract_resp = await c.post(
            "/profile/extract", json={"image_base64": bad_b64}
        )

    assert turn_resp.status_code == 200, turn_resp.text
    assert "trouble" in turn_resp.json()["reply"].lower()

    assert extract_resp.status_code == 200, extract_resp.text
    assert extract_resp.json().get("note")
