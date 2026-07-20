"""/agent/turn web-app contract: PDF ingest and CORS for the browser frontend."""

from __future__ import annotations

import base64

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
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def test_pdf_base64_folds_extracted_text_into_message(monkeypatch):
    seen: dict = {}

    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        seen["message"] = message
        return "profile updated", ["update_medical_profile"], history or []

    monkeypatch.setattr(routes, "extract_pdf_text", lambda data: "BP 128/80\nHbA1c 6.9%")
    app = _make_app(monkeypatch, fake_turn)

    body = {
        "message": "Please update my profile from this report.",
        "elder_id": ELDER,
        "pdf_base64": base64.b64encode(b"%PDF-fake").decode(),
    }
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json=body)
    assert resp.status_code == 200
    assert resp.json()["reply"] == "profile updated"
    # The extracted text is folded into the agent message, Telegram-style.
    assert seen["message"].startswith("Please update my profile from this report.")
    assert "[Attached PDF contents]\nBP 128/80\nHbA1c 6.9%\n[End of PDF]" in seen["message"]


async def test_unreadable_pdf_gets_nudge_without_burning_a_turn(monkeypatch):
    async def fake_turn(*a, **k):  # pragma: no cover - must not be reached
        raise AssertionError("run_agent_turn must not be called for an unreadable PDF")

    monkeypatch.setattr(routes, "extract_pdf_text", lambda data: "")
    app = _make_app(monkeypatch, fake_turn)

    body = {
        "message": "",
        "elder_id": ELDER,
        "pdf_base64": base64.b64encode(b"%PDF-scan").decode(),
    }
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert "couldn't read that PDF" in data["reply"]
    assert data["tools_used"] == []


async def test_reply_language_forwarded_and_committed_actions_returned(monkeypatch):
    seen: dict = {}

    async def fake_turn(
        client, ctx, message, *, image_bytes=None, history=None, reply_language=None, **_
    ):
        seen["reply_language"] = reply_language
        # A committed write records itself on ctx; the route surfaces it as `actions`.
        ctx.committed_actions.append(
            {"tool": "add_prescription", "summary": "Metformin 500mg"}
        )
        return "done", ["add_prescription"], history or []

    app = _make_app(monkeypatch, fake_turn)

    body = {
        "message": "Yes, add it.",
        "elder_id": ELDER,
        "reply_language": "Mandarin Chinese",
    }
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json=body)
    assert resp.status_code == 200
    # The client's language preference reaches the agent...
    assert seen["reply_language"] == "Mandarin Chinese"
    # ...and the committed write is returned so the UI can confirm + redirect.
    assert resp.json()["actions"] == [
        {"tool": "add_prescription", "summary": "Metformin 500mg"}
    ]


async def test_actions_defaults_empty_when_nothing_committed(monkeypatch):
    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        return "just chatting", [], history or []

    app = _make_app(monkeypatch, fake_turn)
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "elder_id": ELDER})
    assert resp.status_code == 200
    assert resp.json()["actions"] == []


async def test_turn_error_returns_friendly_reply_not_500(monkeypatch):
    async def boom(client, ctx, message, *, image_bytes=None, history=None, **_):
        raise RuntimeError("provider exploded")

    app = _make_app(monkeypatch, boom)
    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "elder_id": ELDER})
    # A mid-turn provider/DB error is caught + logged server-side and returns a
    # friendly 200 reply, instead of a bare 500 the browser would hide behind its
    # own generic fallback.
    assert resp.status_code == 200
    data = resp.json()
    assert "trouble" in data["reply"].lower()
    assert data["tools_used"] == []
    assert data["actions"] == []


async def test_cors_preflight_allows_configured_web_origin(monkeypatch):
    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        return "ok", [], history or []

    app = _make_app(monkeypatch, fake_turn)
    origin = get_settings().cors_origins[0]

    async with _client(app) as c:
        resp = await c.options(
            "/agent/turn",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == origin
