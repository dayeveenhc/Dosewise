"""/profile/extract contract: the structured "pull" API used for onboarding autofill.

Extraction is stateless (no jwt, no DB): a document goes in, structured fields
come out for the client to pre-fill a form the user then reviews.
"""

from __future__ import annotations

import base64

import httpx

from fakes import FakeSupabase
from hermes.api import routes
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter

PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG_MAGIC = b"\xff\xd8\xff" + b"\x00" * 16


def _make_app():
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = object()  # opaque; extract_profile_fields is monkeypatched
    app.state.telegram = None
    return app


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_pdf_text_extracted_into_fields(monkeypatch):
    seen: dict = {}

    async def fake_extract(client, *, image_bytes=None, image_media_type="image/jpeg", pdf_text=None):
        seen["pdf_text"] = pdf_text
        seen["image_bytes"] = image_bytes
        return {"full_name": "Tan Ah Kow", "conditions": ["Type 2 Diabetes"], "weight_kg": 68}

    monkeypatch.setattr(routes, "extract_pdf_text", lambda data: "Name: Tan Ah Kow\nDx: T2DM")
    monkeypatch.setattr(routes, "extract_profile_fields", fake_extract)
    app = _make_app()

    body = {"pdf_base64": base64.b64encode(b"%PDF-fake").decode()}
    async with _client(app) as c:
        resp = await c.post("/profile/extract", json=body)

    assert resp.status_code == 200
    data = resp.json()
    assert data["fields"] == {
        "full_name": "Tan Ah Kow",
        "conditions": ["Type 2 Diabetes"],
        "weight_kg": 68,
    }
    # The extracted PDF text (not the raw base64) reaches the extractor.
    assert "Tan Ah Kow" in seen["pdf_text"]
    assert seen["image_bytes"] is None


async def test_image_upload_sniffs_media_type(monkeypatch):
    seen: dict = {}

    async def fake_extract(client, *, image_bytes=None, image_media_type="image/jpeg", pdf_text=None):
        seen["image_media_type"] = image_media_type
        seen["image_len"] = len(image_bytes or b"")
        return {"current_meds": [{"name": "Metformin", "dose": "500mg", "time": "08:00"}]}

    monkeypatch.setattr(routes, "extract_profile_fields", fake_extract)
    app = _make_app()

    body = {"image_base64": base64.b64encode(PNG_MAGIC).decode()}
    async with _client(app) as c:
        resp = await c.post("/profile/extract", json=body)

    assert resp.status_code == 200
    assert resp.json()["fields"]["current_meds"][0]["name"] == "Metformin"
    # A PNG upload is labelled correctly, not mislabelled as the JPEG default.
    assert seen["image_media_type"] == "image/png"
    assert seen["image_len"] == len(PNG_MAGIC)


async def test_unreadable_pdf_gets_nudge_without_calling_the_model(monkeypatch):
    async def must_not_run(*a, **k):  # pragma: no cover - must not be reached
        raise AssertionError("extract_profile_fields must not run for an unreadable PDF")

    monkeypatch.setattr(routes, "extract_pdf_text", lambda data: "")
    monkeypatch.setattr(routes, "extract_profile_fields", must_not_run)
    app = _make_app()

    body = {"pdf_base64": base64.b64encode(b"%PDF-scan").decode()}
    async with _client(app) as c:
        resp = await c.post("/profile/extract", json=body)

    assert resp.status_code == 200
    data = resp.json()
    assert data["fields"] == {}
    assert "photo" in (data["note"] or "").lower()


async def test_no_attachment_returns_empty(monkeypatch):
    async def must_not_run(*a, **k):  # pragma: no cover - must not be reached
        raise AssertionError("extract_profile_fields must not run with nothing to read")

    monkeypatch.setattr(routes, "extract_profile_fields", must_not_run)
    app = _make_app()

    async with _client(app) as c:
        resp = await c.post("/profile/extract", json={})

    assert resp.status_code == 200
    assert resp.json()["fields"] == {}


async def test_extractor_error_returns_friendly_note_not_500(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(routes, "extract_profile_fields", boom)
    app = _make_app()

    body = {"image_base64": base64.b64encode(JPEG_MAGIC).decode()}
    async with _client(app) as c:
        resp = await c.post("/profile/extract", json=body)

    assert resp.status_code == 200
    data = resp.json()
    assert data["fields"] == {}
    assert data["note"]
