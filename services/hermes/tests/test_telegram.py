"""Integration test for the Telegram voice→language→audio path (handle_update)."""

from __future__ import annotations

import hermes.channels.telegram as telegram
from fakes import (
    FakeAnthropic,
    FakeDB,
    FakeSupabase,
    FakeTelegram,
    response,
    text_block,
    use_anthropic,
)
from hermes.channels.session import SessionRegistry

ELDER_A = "00000000-0000-0000-0000-00000000000a"


async def test_voice_note_replies_with_text_and_audio_in_detected_language(monkeypatch):
    use_anthropic(monkeypatch)

    async def fake_transcribe(audio, *, content_type="audio/ogg", engine="whisper", language=None):
        return "apa khabar"

    async def fake_synthesize(text, *, model=None):
        fake_synthesize.model = model
        return b"WAVDATA"

    # Avoid loading the fastText model / hitting HF in the test.
    monkeypatch.setattr(telegram, "transcribe", fake_transcribe)
    monkeypatch.setattr(telegram, "synthesize", fake_synthesize)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "zlm")  # Malay

    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "ms"}], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    anthropic = FakeAnthropic([response("end_turn", [text_block("Khabar baik!")])])
    update = {"message": {"chat": {"id": 111},
                          "voice": {"file_id": "v1", "mime_type": "audio/ogg"}}}

    await telegram.handle_update(
        update, anthropic=anthropic, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )

    # Text reply sent, and audio reply spoken back via the Malay TTS voice.
    assert tg.sent and tg.sent[-1][1] == "Khabar baik!"
    assert tg.audio_sent and tg.audio_sent[-1] == (111, b"WAVDATA")
    assert fake_synthesize.model == "facebook/mms-tts-zlm"
    # Reply language was threaded into the system prompt.
    system_text = "".join(b["text"] for b in anthropic.messages.calls[0]["system"])
    assert "Malay" in system_text


async def test_typed_message_replies_text_only(monkeypatch):
    use_anthropic(monkeypatch)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "eng")
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "en"}], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    anthropic = FakeAnthropic([response("end_turn", [text_block("Sure!")])])
    update = {"message": {"chat": {"id": 111}, "text": "what are my meds?"}}

    await telegram.handle_update(
        update, anthropic=anthropic, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )
    assert tg.sent and tg.sent[-1][1] == "Sure!"
    assert tg.audio_sent == []  # typed in -> no spoken reply


def _capture_turn(monkeypatch):
    """Stub run_agent_turn; return a dict that captures the image_bytes it received."""
    captured: dict = {}

    async def fake_run_agent_turn(
        client, ctx, text, *, image_bytes=None, history=None, reply_language=None, **_
    ):
        captured["image_bytes"] = image_bytes
        captured["text"] = text
        return "Got it.", [], history or []

    monkeypatch.setattr(telegram, "run_agent_turn", fake_run_agent_turn)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "eng")
    return captured


async def test_photo_message_sets_pending_image_and_passes_to_turn(monkeypatch):
    captured = _capture_turn(monkeypatch)
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    tg.audio = b"JPEGPHOTO"  # download_file returns this
    # Telegram sends a size ladder; the handler must pick the largest (last).
    update = {"message": {"chat": {"id": 111},
                          "photo": [{"file_id": "small"}, {"file_id": "big"}]}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("ok")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.downloads == ["big"]                      # largest photo downloaded
    assert captured["image_bytes"] == b"JPEGPHOTO"      # threaded into the turn
    assert registry.get(111).pending_image == b"JPEGPHOTO"  # held for confirm


async def test_image_document_is_treated_like_a_photo(monkeypatch):
    captured = _capture_turn(monkeypatch)
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    tg.audio = b"PNGBYTES"
    update = {"message": {"chat": {"id": 222},
                          "document": {"file_id": "docfile", "mime_type": "image/png"}}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("ok")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.downloads == ["docfile"]
    assert captured["image_bytes"] == b"PNGBYTES"
    assert registry.get(222).pending_image == b"PNGBYTES"


async def test_non_image_non_pdf_document_is_ignored(monkeypatch):
    captured = _capture_turn(monkeypatch)
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    # A .docx (neither image/* nor application/pdf) and no caption -> ignored.
    update = {"message": {"chat": {"id": 333},
                          "document": {"file_id": "doc.docx",
                                       "mime_type": "application/msword"}}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("ok")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.downloads == []          # nothing downloaded
    assert captured == {}              # run_agent_turn never called


async def test_pdf_document_text_threaded_into_turn(monkeypatch):
    captured = _capture_turn(monkeypatch)
    monkeypatch.setattr(telegram, "extract_pdf_text", lambda data: "Metformin 500mg twice daily.")
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    tg.audio = b"%PDF-bytes"
    update = {"message": {"chat": {"id": 444}, "caption": "my meds list",
                          "document": {"file_id": "rx.pdf", "mime_type": "application/pdf"}}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("ok")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.downloads == ["rx.pdf"]
    assert "my meds list" in captured["text"]
    assert "Metformin 500mg twice daily." in captured["text"]


async def test_unreadable_pdf_asks_for_photo_and_runs_no_turn(monkeypatch):
    captured = _capture_turn(monkeypatch)
    monkeypatch.setattr(telegram, "extract_pdf_text", lambda data: "")  # scanned/empty
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    tg.audio = b"%PDF-scan"
    update = {"message": {"chat": {"id": 555},
                          "document": {"file_id": "scan.pdf", "mime_type": "application/pdf"}}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("ok")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.downloads == ["scan.pdf"]
    assert captured == {}                       # no turn ran
    assert "photo" in tg.sent[-1][1].lower()    # asked for a photo instead


# --- Inline tap-buttons ----------------------------------------------------
async def test_reply_gets_yes_no_keyboard_when_awaiting_confirmation(monkeypatch):
    async def fake_run_agent_turn(
        client, ctx, text, *, image_bytes=None, history=None, reply_language=None, **_
    ):
        ctx.session.awaiting_confirmation = True  # a tool just proposed something
        return "Save Metformin 500mg?", ["add_prescription"], history or []

    monkeypatch.setattr(telegram, "run_agent_turn", fake_run_agent_turn)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "eng")
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    update = {"message": {"chat": {"id": 111}, "text": "add metformin"}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("x")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.sent[-1] == (111, "Save Metformin 500mg?")
    assert tg.markups[-1] == telegram._CONFIRM_KEYBOARD  # Yes/No keyboard attached


async def test_confirm_yes_callback_runs_turn_and_delivers_reply(monkeypatch):
    seen: dict = {}

    async def fake_run_agent_turn(
        client, ctx, text, *, image_bytes=None, history=None, reply_language=None, **_
    ):
        seen["text"] = text
        ctx.session.awaiting_confirmation = False  # committed -> keyboard drops off
        return "Saved it.", ["add_prescription"], history or []

    monkeypatch.setattr(telegram, "run_agent_turn", fake_run_agent_turn)
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    update = {"callback_query": {"id": "cq1", "data": "confirm:yes",
                                 "message": {"chat": {"id": 111}}}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("x")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert seen["text"] == "yes"            # tap translated to plain-text confirmation
    assert tg.answered == ["cq1"]           # spinner stopped
    assert tg.sent[-1] == (111, "Saved it.")
    assert tg.markups[-1] is None           # no longer awaiting -> no keyboard


async def test_dose_taken_callback_logs_the_dose():
    med_id = "00000000-0000-0000-0000-0000000000d1"
    db = FakeDB({
        "medications": [{"id": med_id, "name": "Metformin", "archived": False}],
        "doses": [],
    })
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    update = {"callback_query": {"id": "cq2", "data": f"dose:taken:{med_id}",
                                 "message": {"chat": {"id": 111}}}}

    await telegram.handle_update(
        update, anthropic=FakeAnthropic([response("end_turn", [text_block("x")])]),
        supabase=FakeSupabase(db=db), registry=registry, telegram=tg,
    )
    assert tg.answered == ["cq2"]
    assert any(table == "doses" for table, _ in db.inserted)  # dose logged as taken
    assert "taken" in tg.sent[-1][1].lower()
