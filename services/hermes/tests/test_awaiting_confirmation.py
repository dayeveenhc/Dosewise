"""`awaiting_confirmation` on the web contract — the deterministic "a tool
proposed something and is waiting on a yes/no" signal.

Every propose→confirm tool already sets ``session.awaiting_confirmation``, and
Telegram consumes it to attach its ✅/✖ keyboard. The web response had no field
for it, so tappable confirm buttons only ever appeared when the model happened to
call ``offer_choices`` — a probabilistic path for an affordance that should be
certain. These tests pin the contract AND the per-turn reset, without which the
flag stays true forever and paints Yes/No under unrelated later replies.
"""

from __future__ import annotations

import json

import httpx

from fakes import FakeSupabase
from hermes.api import routes
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter

ELDER = "00000000-0000-0000-0000-00000000000a"


def _make_app(monkeypatch, fake_turn):
    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None
    return app


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _parse_events(body: str) -> list[dict]:
    return [json.loads(c[len("data: ") :]) for c in body.strip().split("\n\n") if c]


async def _proposing_turn(client, ctx, message, *, history=None, **_):
    """Stands in for e.g. add_prescription(confirmed=false): proposes, writes
    nothing, and flags that it's waiting on a yes/no."""
    ctx.session.awaiting_confirmation = True
    return "Add Metformin 500mg — shall I save it?", ["add_prescription"], history or []


async def _plain_turn(client, ctx, message, *, history=None, **_):
    return "Metformin lowers blood sugar.", ["get_drug_info"], history or []


async def test_propose_turn_reports_awaiting_confirmation(monkeypatch):
    app = _make_app(monkeypatch, _proposing_turn)
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "add metformin", "elder_id": ELDER})
    body = resp.json()
    assert body["awaiting_confirmation"] is True
    # A propose commits nothing — that distinction is the whole point.
    assert body["actions"] == []


async def test_plain_turn_does_not(monkeypatch):
    app = _make_app(monkeypatch, _plain_turn)
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "what is metformin", "elder_id": ELDER})
    assert resp.json()["awaiting_confirmation"] is False


async def test_the_flag_does_not_stick_to_the_next_turn(monkeypatch):
    """THE regression this reset exists for. SessionState persists per elder in
    app.http_sessions and nothing on the web path ever clears the flag
    (_clear_pending is Telegram-only), so without the reset in _build_context a
    single propose would paint Yes/No buttons under every later reply."""
    turns = iter([_proposing_turn, _plain_turn])

    async def dispatch(*a, **k):
        return await next(turns)(*a, **k)

    app = _make_app(monkeypatch, dispatch)
    async with _client(app) as c:
        first = await c.post("/agent/turn", json={"message": "add metformin", "elder_id": ELDER})
        second = await c.post("/agent/turn", json={"message": "thanks", "elder_id": ELDER})
    assert first.json()["awaiting_confirmation"] is True
    assert second.json()["awaiting_confirmation"] is False


async def test_stream_final_carries_the_flag(monkeypatch):
    app = _make_app(monkeypatch, _proposing_turn)
    async with _client(app) as c:
        resp = await c.post(
            "/agent/turn/stream", json={"message": "add metformin", "elder_id": ELDER}
        )
    final = _parse_events(resp.text)[-1]
    assert final["awaiting_confirmation"] is True


async def test_stream_error_final_has_the_same_key_set_as_success(monkeypatch):
    """The error branch used to omit `choices` entirely while the success branch
    included it — two different `final` shapes that only worked because the
    client defaulted a missing key. Nothing may render a confirm affordance under
    an error reply either."""

    async def boom(*a, **k):
        raise RuntimeError("provider down")

    ok_app = _make_app(monkeypatch, _plain_turn)
    async with _client(ok_app) as c:
        ok = _parse_events(
            (await c.post("/agent/turn/stream", json={"message": "hi", "elder_id": ELDER})).text
        )[-1]

    err_app = _make_app(monkeypatch, boom)
    async with _client(err_app) as c:
        err = _parse_events(
            (await c.post("/agent/turn/stream", json={"message": "hi", "elder_id": ELDER})).text
        )[-1]

    assert set(err) == set(ok)
    assert err["choices"] is None
    assert err["awaiting_confirmation"] is False


async def test_app_role_reaches_the_tool_context(monkeypatch):
    """start_walkthrough's wrong-shell guard reads ctx.app_role, so the request
    field has to actually arrive there — it previously stopped at the prompt."""
    seen = {}

    async def capture(client, ctx, message, *, history=None, **_):
        seen["role"] = ctx.app_role
        return "ok", [], history or []

    app = _make_app(monkeypatch, capture)
    async with _client(app) as c:
        await c.post(
            "/agent/turn",
            json={"message": "hi", "elder_id": ELDER, "app_role": "caregiver"},
        )
    assert seen["role"] == "caregiver"

    async with _client(app) as c:
        await c.post("/agent/turn", json={"message": "hi", "elder_id": ELDER})
    assert seen["role"] == "elder"  # Telegram/CLI and any omitted value
