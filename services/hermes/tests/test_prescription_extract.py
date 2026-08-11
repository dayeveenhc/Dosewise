"""/prescription/extract contract: reading a medication label into form fields.

The "pull" sibling of /profile/extract, and the reason the add-prescription
sheet no longer interrogates anyone: a label photo goes in, structured fields
come out, and the app pre-fills a form the person reviews and saves. The save IS
the confirmation, so nothing here writes.

Mirrors test_profile_extract.py's shape deliberately — the two routes share
their decode guards, their PDF nudge and their never-500 contract, and the pair
of suites is what stops one drifting from the other.
"""

from __future__ import annotations

import base64

import httpx

from fakes import FakeSupabase
from hermes.api import routes
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter

PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _make_app():
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = object()  # opaque; the extractor is monkeypatched
    app.state.telegram = None
    return app


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_label_photo_becomes_prescription_fields(monkeypatch):
    seen: dict = {}

    async def fake_extract(
        client, *, image_bytes=None, image_media_type="image/jpeg", pdf_text=None
    ):
        seen["image_bytes"] = image_bytes
        seen["media_type"] = image_media_type
        return {
            "name": "Amoxicillin",
            "dose": "500mg",
            "purpose": "chest infection",
            "times": ["08:00", "16:00", "00:00"],
            "frequency": "every 8 hours",
            "duration_days": 5,
        }

    monkeypatch.setattr(routes, "extract_prescription_fields", fake_extract)
    app = _make_app()

    body = {"image_base64": base64.b64encode(PNG_MAGIC).decode()}
    async with _client(app) as c:
        resp = await c.post("/prescription/extract", json=body)

    assert resp.status_code == 200
    fields = resp.json()["fields"]
    assert fields["name"] == "Amoxicillin"
    assert fields["duration_days"] == 5
    # `times` survives as a real JSON array. This is the structured HTTP path,
    # NOT tools/walkthrough.py's str()-coercing params — a list must not arrive
    # at the client as literal text.
    assert fields["times"] == ["08:00", "16:00", "00:00"]
    # The browser strips the data-URL mime before upload, so the route sniffs it.
    assert seen["media_type"] == "image/png"
    assert seen["image_bytes"] == PNG_MAGIC


async def test_inferred_list_passes_through_untouched(monkeypatch):
    """The marking the form renders as "Please check" is the model's own claim.

    The client cannot re-derive which fields were read verbatim, so this list is
    the only signal it has — dropping or reshaping it here would silently
    present a worked-out schedule as if it were printed on the label.
    """

    async def fake_extract(client, **kwargs):
        return {"name": "Latanoprost", "times": ["21:00"], "inferred": ["times"]}

    monkeypatch.setattr(routes, "extract_prescription_fields", fake_extract)
    app = _make_app()

    async with _client(app) as c:
        resp = await c.post(
            "/prescription/extract",
            json={"image_base64": base64.b64encode(PNG_MAGIC).decode()},
        )

    assert resp.json()["fields"]["inferred"] == ["times"]


async def test_scanned_pdf_is_nudged_without_calling_the_model(monkeypatch):
    called = False

    async def fake_extract(client, **kwargs):
        nonlocal called
        called = True
        return {}

    # A scan has no text layer, and there is no photo to fall back on.
    monkeypatch.setattr(routes, "extract_pdf_text", lambda data: "")
    monkeypatch.setattr(routes, "extract_prescription_fields", fake_extract)
    app = _make_app()

    async with _client(app) as c:
        resp = await c.post(
            "/prescription/extract",
            json={"pdf_base64": base64.b64encode(b"%PDF-scan").decode()},
        )

    assert resp.status_code == 200
    assert resp.json()["fields"] == {}
    assert "photo" in resp.json()["note"]
    assert called is False, "a scan with no text layer must not burn an LLM call"


async def test_no_attachment_returns_an_empty_answer_not_an_error():
    app = _make_app()
    async with _client(app) as c:
        resp = await c.post("/prescription/extract", json={})

    assert resp.status_code == 200
    assert resp.json()["fields"] == {}
    assert resp.json()["note"]


async def test_extractor_failure_is_a_friendly_note_never_a_500(monkeypatch):
    async def boom(client, **kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(routes, "extract_prescription_fields", boom)
    app = _make_app()

    async with _client(app) as c:
        resp = await c.post(
            "/prescription/extract",
            json={"image_base64": base64.b64encode(PNG_MAGIC).decode()},
        )

    # The sheet falls back to asking Mei in chat; a 500 would just look broken.
    assert resp.status_code == 200
    assert resp.json()["fields"] == {}
    assert resp.json()["note"]


async def test_undecodable_base64_is_caught(monkeypatch):
    """The round-1 audit's unguarded-decode finding, held for the new route too."""
    app = _make_app()
    async with _client(app) as c:
        resp = await c.post("/prescription/extract", json={"image_base64": "!!!not base64!!!"})

    assert resp.status_code == 200
    assert resp.json()["fields"] == {}
