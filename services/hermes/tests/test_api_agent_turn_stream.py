"""/agent/turn/stream: the SSE variant of /agent/turn used for Mei's live-action
UI. Same contract otherwise — this only covers what's different: event framing,
the unreadable-PDF short-circuit, and that it doesn't regress auth/rate-limit."""

from __future__ import annotations

import base64
import json

import httpx

from fakes import FakeSupabase
from hermes.api import routes
from hermes.config import get_settings
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
    return [json.loads(chunk[len("data: ") :]) for chunk in body.strip().split("\n\n") if chunk]


async def test_tool_events_stream_before_the_final_event(monkeypatch):
    async def fake_turn(
        client, ctx, message, *, image_bytes=None, history=None, on_event=None, **_
    ):
        assert on_event is not None
        await on_event({"type": "tool_start", "tool": "add_prescription"})
        ctx.committed_actions.append({"tool": "add_prescription", "summary": "Metformin 500mg"})
        await on_event({"type": "tool_end", "tool": "add_prescription", "is_error": False})
        return "Added it.", ["add_prescription"], history or []

    app = _make_app(monkeypatch, fake_turn)
    async with _client(app) as c:
        resp = await c.post(
            "/agent/turn/stream", json={"message": "add metformin", "elder_id": ELDER}
        )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _parse_events(resp.text)
    assert events == [
        {"type": "tool_start", "tool": "add_prescription"},
        {"type": "tool_end", "tool": "add_prescription", "is_error": False},
        {
            "type": "final",
            "reply": "Added it.",
            "tools_used": ["add_prescription"],
            "actions": [{"tool": "add_prescription", "summary": "Metformin 500mg"}],
            "walkthrough": None,
            "choices": None,
            "alert": None,
            "awaiting_confirmation": False,
        },
    ]


async def test_no_tool_calls_still_ends_with_a_final_event(monkeypatch):
    async def fake_turn(
        client, ctx, message, *, image_bytes=None, history=None, on_event=None, **_
    ):
        return "just chatting", [], history or []

    app = _make_app(monkeypatch, fake_turn)
    async with _client(app) as c:
        resp = await c.post("/agent/turn/stream", json={"message": "hi", "elder_id": ELDER})
    events = _parse_events(resp.text)
    assert events == [
        {
            "type": "final",
            "reply": "just chatting",
            "tools_used": [],
            "actions": [],
            "walkthrough": None,
            "choices": None,
            "alert": None,
            "awaiting_confirmation": False,
        }
    ]


async def test_unreadable_pdf_short_circuits_to_a_single_final_event(monkeypatch):
    async def fake_turn(*a, **k):  # pragma: no cover - must not be reached
        raise AssertionError("run_agent_turn must not be called for an unreadable PDF")

    monkeypatch.setattr(routes, "extract_pdf_text", lambda data: "")
    app = _make_app(monkeypatch, fake_turn)

    body = {"message": "", "elder_id": ELDER, "pdf_base64": base64.b64encode(b"%PDF-scan").decode()}
    async with _client(app) as c:
        resp = await c.post("/agent/turn/stream", json=body)
    events = _parse_events(resp.text)
    assert len(events) == 1
    assert events[0]["type"] == "final"
    assert "couldn't read that PDF" in events[0]["reply"]


async def test_provider_error_mid_stream_ends_with_a_friendly_final_event(monkeypatch):
    async def boom(client, ctx, message, *, image_bytes=None, history=None, on_event=None, **_):
        raise RuntimeError("provider exploded")

    app = _make_app(monkeypatch, boom)
    async with _client(app) as c:
        resp = await c.post("/agent/turn/stream", json={"message": "hi", "elder_id": ELDER})
    events = _parse_events(resp.text)
    assert len(events) == 1
    assert events[0]["type"] == "final"
    assert "trouble" in events[0]["reply"].lower()
    assert events[0]["actions"] == []


async def test_jwt_required_in_strict_mode_rejects_before_streaming_starts(monkeypatch):
    async def fake_turn(*a, **k):  # pragma: no cover - must not be reached
        raise AssertionError("must not run without auth")

    app = _make_app(monkeypatch, fake_turn)
    monkeypatch.setattr(get_settings(), "hermes_strict_auth", True, raising=False)
    async with _client(app) as c:
        resp = await c.post("/agent/turn/stream", json={"message": "hi"})
    assert resp.status_code == 401


async def test_final_event_key_set_matches_the_response_model(monkeypatch):
    """The streaming half of the two-sided contract — see the twin in
    test_api_agent_turn.py::test_final_body_key_set_matches_the_response_model.

    `final` is assembled as a literal dict here, not from AgentTurnResponse, so
    nothing but this test stops it drifting from the non-streaming route. It
    already did once, on `choices`. `type` is the one legitimate extra: it is the
    SSE event tag, not part of the payload contract.
    """
    async def fake_turn(
        client, ctx, message, *, image_bytes=None, history=None, on_event=None, **_
    ):
        return "ok", [], history or []

    app = _make_app(monkeypatch, fake_turn)
    async with _client(app) as c:
        resp = await c.post("/agent/turn/stream", json={"message": "hi", "elder_id": ELDER})
    final = _parse_events(resp.text)[-1]
    assert final["type"] == "final"
    assert set(final) - {"type"} == set(routes.AgentTurnResponse.model_fields)
