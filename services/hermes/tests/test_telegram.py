"""Integration test for the Telegram voice→language→audio path (handle_update)."""

from __future__ import annotations

import hermes.channels.telegram as telegram
from fakes import FakeAnthropic, FakeDB, FakeSupabase, FakeTelegram, response, text_block
from hermes.channels.session import SessionRegistry

ELDER_A = "00000000-0000-0000-0000-00000000000a"


async def test_voice_note_replies_with_text_and_audio_in_detected_language(monkeypatch):
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
