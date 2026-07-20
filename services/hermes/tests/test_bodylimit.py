"""Request-body-size cap (MaxBodySizeMiddleware).

Round 2 fix for a gap Round 1 measured but didn't close: no request-body-size
limit existed anywhere in the stack (see
docs/security-verification-2026-07-12.md's body-size probe). These tests use a
tiny configured limit rather than real multi-MB payloads, so they run fast and
don't need the load-test harness's memory-safety guardrails.
"""

from __future__ import annotations

import json

import httpx

import hermes.api.routes as routes
from fakes import FakeSupabase
from hermes.config import get_settings
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter


def _make_app(monkeypatch, *, max_bytes: int, calls: list):
    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        calls.append(message)
        return "ok", [], history or []

    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    s = get_settings()
    monkeypatch.setattr(s, "hermes_max_body_bytes", max_bytes, raising=False)
    monkeypatch.setattr(s, "rate_limit_enabled", False, raising=False)
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None
    return app


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_oversized_content_length_rejected_before_read(monkeypatch):
    calls: list = []
    app = _make_app(monkeypatch, max_bytes=64, calls=calls)

    body = json.dumps({"message": "x" * 500, "elder_id": "e1"}).encode()
    assert len(body) > 64

    async with _client(app) as c:
        resp = await c.post(
            "/agent/turn",
            content=body,
            headers={"content-type": "application/json"},
        )

    assert resp.status_code == 413
    assert resp.json()["detail"] == "request body too large"
    assert calls == [], "route handler must never run for an oversized body"


async def test_undersized_request_is_unaffected(monkeypatch):
    calls: list = []
    app = _make_app(monkeypatch, max_bytes=64 * 1024, calls=calls)

    async with _client(app) as c:
        resp = await c.post(
            "/agent/turn", json={"message": "hi", "elder_id": "e1"}
        )

    assert resp.status_code == 200
    assert resp.json()["reply"] == "ok"
    assert calls == ["hi"]


async def test_chunked_body_without_content_length_still_capped(monkeypatch):
    calls: list = []
    app = _make_app(monkeypatch, max_bytes=64, calls=calls)

    body = json.dumps({"message": "y" * 500, "elder_id": "e1"}).encode()

    async def body_stream():
        # Yielding from an async generator makes httpx send a chunked request
        # with no Content-Length header, exercising the streaming guard rather
        # than the declared-length shortcut.
        chunk = 16
        for i in range(0, len(body), chunk):
            yield body[i : i + chunk]

    async with _client(app) as c:
        resp = await c.post(
            "/agent/turn",
            content=body_stream(),
            headers={"content-type": "application/json"},
        )

    # Not 413 here: FastAPI's own body-parsing (fastapi/routing.py,
    # request_body_to_args) wraps `await request.body()` in a bare
    # `except Exception as e: raise HTTPException(400, "There was an error
    # parsing the body")` — verified directly in the installed package. Our
    # _BodyTooLarge exception is raised *inside* that call (from within
    # guarded_receive, mid-stream) and gets normalized to this generic 400
    # before it ever unwinds back out to MaxBodySizeMiddleware's own
    # except block, so this middleware's custom 413 response is only reachable
    # via the declared-Content-Length fast path (see the test above). What
    # actually matters for the security property still holds: the abort is
    # immediate (no full buffering past max_bytes) and the route handler never
    # runs — asserted below.
    assert resp.status_code == 400
    assert calls == [], "route handler must never run for an oversized streamed body"
