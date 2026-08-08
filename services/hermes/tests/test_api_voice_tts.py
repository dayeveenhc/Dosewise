"""/voice/tts — the web app's expressive spoken replies.

The contract the browser depends on: a 200 carries mp3 bytes, and ANY non-200
means "fall back to speechSynthesis". So the tests that matter most are the
failure ones — a deploy with no OpenAI key must answer 503 honestly rather than
200 with an empty body, which would leave the reply silent with no fallback.
"""

from __future__ import annotations

import httpx
import pytest

from fakes import FakeSupabase
from hermes.agent import tts
from hermes.api import routes
from hermes.config import get_settings
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter

ELDER = "00000000-0000-0000-0000-00000000000a"


def _make_app():
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


async def test_serves_mp3_when_a_voice_is_configured(monkeypatch):
    seen: dict = {}

    async def fake_synth(text, *, settings=None):
        seen["text"] = text
        return b"ID3-fake-mp3"

    monkeypatch.setattr(routes, "tts_available", lambda: True)
    monkeypatch.setattr(routes, "synthesize_reply", fake_synth)

    async with _client(_make_app()) as c:
        resp = await c.post(
            "/voice/tts", json={"text": "Time for your Metformin.", "elder_id": ELDER}
        )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/mpeg")
    # Medication details must not sit in an intermediary cache as a playable file.
    assert resp.headers["cache-control"] == "no-store"
    assert resp.content == b"ID3-fake-mp3"
    assert seen["text"] == "Time for your Metformin."


async def test_503_when_no_voice_is_configured(monkeypatch):
    """The signal the client falls back on. A 200 here would be silence."""
    monkeypatch.setattr(routes, "tts_available", lambda: False)

    async with _client(_make_app()) as c:
        resp = await c.post("/voice/tts", json={"text": "Hello", "elder_id": ELDER})

    assert resp.status_code == 503


async def test_503_when_the_provider_fails(monkeypatch):
    monkeypatch.setattr(routes, "tts_available", lambda: True)
    monkeypatch.setattr(routes, "synthesize_reply", lambda text, **_: _none())

    async with _client(_make_app()) as c:
        resp = await c.post("/voice/tts", json={"text": "Hello", "elder_id": ELDER})

    assert resp.status_code == 503


async def _none():
    return None


async def test_requires_the_api_key(monkeypatch):
    """Same gate as every other POST — this one spends provider credit."""
    settings = get_settings()
    monkeypatch.setattr(settings, "hermes_api_key", "secret", raising=False)
    monkeypatch.setattr(routes, "tts_available", lambda: True)

    async with _client(_make_app()) as c:
        resp = await c.post("/voice/tts", json={"text": "Hello", "elder_id": ELDER})

    assert resp.status_code == 401


async def test_rate_limited_on_its_own_bucket(monkeypatch):
    """Reading replies aloud must not eat the allowance for asking questions."""
    settings = get_settings()
    monkeypatch.setattr(settings, "rate_limit_enabled", True, raising=False)
    monkeypatch.setattr(settings, "rate_limit_turns_per_minute", 2, raising=False)
    monkeypatch.setattr(routes, "tts_available", lambda: True)

    async def fake_synth(text, *, settings=None):
        return b"mp3"

    monkeypatch.setattr(routes, "synthesize_reply", fake_synth)

    app = _make_app()
    async with _client(app) as c:
        codes = [
            (await c.post("/voice/tts", json={"text": "hi", "elder_id": ELDER})).status_code
            for _ in range(4)
        ]
    assert 429 in codes, f"expected the per-user cap to bite, got {codes}"
    # The agent-turn bucket is untouched: its own key is "turn:<id>", not "tts:<id>".
    allowed, _ = app.state.rate_limiter.check(f"turn:{ELDER}", [(1, 60.0)])
    assert allowed is True


@pytest.mark.parametrize(
    "text,expected_prefix",
    [("", ""), ("   ", ""), ("Take one tablet.", "Take one tablet.")],
)
def test_speakable_trims_and_never_returns_junk(text, expected_prefix):
    assert tts.speakable(text) == expected_prefix


def test_speakable_cuts_a_long_reply_at_a_sentence_boundary():
    long_text = ("This is a sentence. " * 200).strip()
    spoken = tts.speakable(long_text)
    assert 0 < len(spoken) <= tts.TTS_CHAR_LIMIT
    # Never mid-word: the cut lands on a full stop.
    assert spoken.endswith(".")


def test_available_is_false_without_a_key(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "", raising=False)
    assert tts.available(settings) is False
    monkeypatch.setattr(settings, "openai_api_key", "sk-test", raising=False)
    monkeypatch.setattr(settings, "openai_tts_model", "", raising=False)
    assert tts.available(settings) is False
