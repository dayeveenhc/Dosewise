"""Coverage for the optional shared-secret guard in api/apikey.py.

Exercises the real ``hmac.compare_digest`` comparison (not just the
"unset -> no-op" early return) against both /agent/turn and /profile/extract,
which are the two routes wired with ``Depends(require_api_key)``.
"""

from __future__ import annotations

import base64

import httpx

import hermes.api.routes as routes
from fakes import FakeSupabase
from hermes.config import get_settings
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter

REAL_KEY = "test-key-123"


def _make_app(monkeypatch):
    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        return "ok", [], history or []

    async def fake_extract(client, *, image_bytes=None, image_media_type=None, pdf_text=None):
        return {"name": "Test Elder"}

    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    monkeypatch.setattr(routes, "extract_profile_fields", fake_extract)
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


def _turn_body():
    return {"message": "hi", "elder_id": "00000000-0000-0000-0000-00000000000a"}


def _extract_body():
    return {"image_base64": base64.b64encode(b"fake-image-bytes").decode()}


async def test_missing_header_is_401(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "hermes_api_key", REAL_KEY, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)

    async with _client(app) as c:
        turn_resp = await c.post("/agent/turn", json=_turn_body())
        extract_resp = await c.post("/profile/extract", json=_extract_body())

    assert turn_resp.status_code == 401
    assert extract_resp.status_code == 401


async def test_header_present_wrong_length_is_401(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "hermes_api_key", REAL_KEY, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)

    headers = {"X-Hermes-Api-Key": "short"}  # different length than REAL_KEY
    async with _client(app) as c:
        turn_resp = await c.post("/agent/turn", json=_turn_body(), headers=headers)
        extract_resp = await c.post("/profile/extract", json=_extract_body(), headers=headers)

    assert turn_resp.status_code == 401
    assert extract_resp.status_code == 401


async def test_header_present_correct_length_wrong_value_is_401(monkeypatch):
    """Exercises the real hmac.compare_digest branch, not the early
    "not x_hermes_api_key" short-circuit — same length as REAL_KEY but
    different content."""
    s = get_settings()
    monkeypatch.setattr(s, "hermes_api_key", REAL_KEY, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)

    wrong_same_length = "x" * len(REAL_KEY)
    assert wrong_same_length != REAL_KEY
    assert len(wrong_same_length) == len(REAL_KEY)
    headers = {"X-Hermes-Api-Key": wrong_same_length}

    async with _client(app) as c:
        turn_resp = await c.post("/agent/turn", json=_turn_body(), headers=headers)
        extract_resp = await c.post("/profile/extract", json=_extract_body(), headers=headers)

    assert turn_resp.status_code == 401
    assert extract_resp.status_code == 401


async def test_header_present_correct_value_is_200(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "hermes_api_key", REAL_KEY, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)

    headers = {"X-Hermes-Api-Key": REAL_KEY}
    async with _client(app) as c:
        turn_resp = await c.post("/agent/turn", json=_turn_body(), headers=headers)
        extract_resp = await c.post("/profile/extract", json=_extract_body(), headers=headers)

    assert turn_resp.status_code == 200
    assert extract_resp.status_code == 200


async def test_unset_api_key_means_no_header_required(monkeypatch):
    """Default (empty) hermes_api_key -> require_api_key is a documented no-op;
    a request with no X-Hermes-Api-Key header at all must still succeed."""
    s = get_settings()
    monkeypatch.setattr(s, "hermes_api_key", "", raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    app = _make_app(monkeypatch)

    async with _client(app) as c:
        turn_resp = await c.post("/agent/turn", json=_turn_body())
        extract_resp = await c.post("/profile/extract", json=_extract_body())

    assert turn_resp.status_code == 200
    assert extract_resp.status_code == 200
