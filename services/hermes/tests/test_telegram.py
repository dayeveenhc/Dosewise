"""Integration test for the Telegram voice→language→audio path (handle_update)."""

from __future__ import annotations

import httpx

import hermes.api.routes as routes
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
from hermes.config import get_settings
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter, turn_tiers

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


async def test_confirm_yes_without_pending_falls_back_to_llm_turn(monkeypatch):
    """Pending state lost (e.g. restart) -> the tap re-enters a normal agent turn."""
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


def _no_llm(monkeypatch):
    """Fail the test if the deterministic path ever re-enters the LLM."""
    async def boom(*a, **k):
        raise AssertionError("run_agent_turn must not be called on the deterministic path")
    monkeypatch.setattr(telegram, "run_agent_turn", boom)


def _confirm_update(data="confirm:yes", cq="cq1", chat=111):
    return {"callback_query": {"id": cq, "data": data, "message": {"chat": {"id": chat}}}}


async def test_confirm_yes_commits_pending_prescription_without_llm(monkeypatch):
    use_anthropic(monkeypatch)
    _no_llm(monkeypatch)
    db = FakeDB({"medications": [], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    state = registry.get(111)
    state.pending_proposal = {"name": "Metformin", "dosage": "500mg", "purpose": None,
                              "instructions": None, "times": ["08:00"], "image": None}
    state.awaiting_confirmation = True
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update(), anthropic=None, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )
    saved = [row for table, row in db.inserted if table == "medications"]
    assert saved and saved[0]["name"] == "Metformin"     # committed deterministically
    assert state.pending_proposal is None
    assert state.awaiting_confirmation is False
    assert tg.markups[-1] is None                        # keyboard dropped
    assert "Metformin" in tg.sent[-1][1]
    # The model's history + memory reflect the tap it never saw.
    assert state.messages[-2:] == [{"role": "user", "content": "yes"},
                                   {"role": "assistant", "content": tg.sent[-1][1]}]
    assert any(t == "conversation_turns" for t, _ in db.inserted)


async def test_confirm_yes_commits_pending_reminder_without_llm(monkeypatch):
    use_anthropic(monkeypatch)
    _no_llm(monkeypatch)
    med_id = "00000000-0000-0000-0000-0000000000d1"
    db = FakeDB({"medications": [{"id": med_id, "name": "Metformin", "archived": False,
                                  "schedule": {"times": ["09:00"]}}],
                 "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    state = registry.get(111)
    state.pending_reminder = {"name": "Metformin", "times": ["08:00", "20:00"], "days": []}
    state.awaiting_confirmation = True
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update(), anthropic=None, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )
    updates = [(t, patch) for t, patch, _ in db.updated if t == "medications"]
    assert updates and updates[0][1]["schedule"]["times"] == ["08:00", "20:00"]
    assert state.pending_reminder is None
    assert state.awaiting_confirmation is False


async def test_confirm_yes_commits_pending_profile_without_llm(monkeypatch):
    use_anthropic(monkeypatch)
    _no_llm(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "accessibility": {}}],
                 "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    state = registry.get(111)
    state.pending_profile = {"content": "Allergic to penicillin.", "replace": False}
    state.awaiting_confirmation = True
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update(), anthropic=None, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )
    updates = [(t, patch) for t, patch, _ in db.updated if t == "profiles"]
    saved = updates[0][1]["accessibility"]["medical_profile"] if updates else None
    assert saved == "Allergic to penicillin."
    assert state.pending_profile is None
    assert state.awaiting_confirmation is False


async def test_confirm_no_clears_pending_and_writes_nothing(monkeypatch):
    use_anthropic(monkeypatch)
    _no_llm(monkeypatch)
    db = FakeDB({"medications": [], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    state = registry.get(111)
    state.pending_proposal = {"name": "Metformin", "image": b"PHOTO"}
    state.pending_image = b"PHOTO"
    state.awaiting_confirmation = True
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update("confirm:no"), anthropic=None, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )
    assert not [r for t, r in db.inserted if t == "medications"]  # nothing saved
    assert state.pending_proposal is None
    assert state.pending_image is None            # stale scan can't attach later
    assert state.awaiting_confirmation is False
    assert "won't save" in tg.sent[-1][1]


async def test_rate_limited_confirm_with_pending_still_commits(monkeypatch):
    """Deterministic confirms don't burn an LLM turn, so the cap doesn't apply."""
    use_anthropic(monkeypatch)
    _no_llm(monkeypatch)
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1, raising=False)
    limiter = SlidingWindowLimiter()
    limiter.check("turn:111", turn_tiers(s))  # burn the single slot

    db = FakeDB({"medications": [], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    state = registry.get(111)
    state.pending_proposal = {"name": "Metformin"}
    state.awaiting_confirmation = True
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update(), anthropic=None, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg, rate_limiter=limiter,
    )
    assert [r for t, r in db.inserted if t == "medications"]  # still committed


async def test_rate_limited_confirm_without_pending_gets_visible_ack(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1, raising=False)
    captured = _capture_turn(monkeypatch)
    limiter = SlidingWindowLimiter()
    limiter.check("turn:111", turn_tiers(s))  # burn the single slot

    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update(), anthropic=None, supabase=FakeSupabase(),
        registry=registry, telegram=tg, rate_limiter=limiter,
    )
    assert captured == {}                          # no LLM turn ran
    assert tg.answered == ["cq1"]
    assert tg.ack_texts[-1]                        # visible toast, not a silent swallow
    assert "wait" in tg.sent[-1][1].lower()        # plus the chat slow-down message


async def test_deterministic_commit_failure_apologises_and_clears(monkeypatch):
    use_anthropic(monkeypatch)
    _no_llm(monkeypatch)

    class ExplodingDB(FakeDB):
        async def insert(self, table, row, returning=True):
            if table == "medications":
                raise RuntimeError("db down")
            return await super().insert(table, row, returning=returning)

    db = ExplodingDB({"medications": [], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    state = registry.get(111)
    state.pending_proposal = {"name": "Metformin"}
    state.awaiting_confirmation = True
    tg = FakeTelegram()

    await telegram.handle_update(
        _confirm_update(), anthropic=None, supabase=FakeSupabase(db=db),
        registry=registry, telegram=tg,
    )
    assert "couldn't save" in tg.sent[-1][1]
    assert state.pending_proposal is None          # must re-propose, not half-retry
    assert state.awaiting_confirmation is False


# --- Rate limiting ---------------------------------------------------------
async def test_over_rate_limit_skips_turn_and_warns(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1, raising=False)
    captured = _capture_turn(monkeypatch)  # stubs run_agent_turn
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    limiter = SlidingWindowLimiter()
    update = {"message": {"chat": {"id": 111}, "text": "what are my meds?"}}
    kwargs = dict(
        anthropic=FakeAnthropic([response("end_turn", [text_block("x")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg, rate_limiter=limiter,
    )

    await telegram.handle_update(update, **kwargs)   # first turn runs
    assert captured.get("text") == "what are my meds?"

    captured.clear()
    await telegram.handle_update(update, **kwargs)   # second is over the cap
    assert captured == {}                            # run_agent_turn NOT called
    assert "wait" in tg.sent[-1][1].lower()          # gentle slow-down message


async def test_no_limiter_means_no_limiting(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_turns_per_minute", 1, raising=False)
    captured = _capture_turn(monkeypatch)
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    update = {"message": {"chat": {"id": 111}, "text": "hi"}}
    kwargs = dict(
        anthropic=FakeAnthropic([response("end_turn", [text_block("x")])]),
        supabase=FakeSupabase(), registry=registry, telegram=tg,  # rate_limiter=None
    )
    await telegram.handle_update(update, **kwargs)
    captured.clear()
    await telegram.handle_update(update, **kwargs)
    assert captured.get("text") == "hi"  # second turn still ran (limiting disabled)


# --- First-time setup (/start, /setup) --------------------------------------
async def test_start_with_empty_profile_opens_guided_intake(monkeypatch):
    captured = _capture_turn(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "accessibility": {}}]})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/start"}},
        anthropic=None, supabase=FakeSupabase(db=db), registry=registry, telegram=tg,
    )
    assert tg.sent[0][1] == telegram._HELP        # welcome first
    assert "started the bot" in captured["text"]  # then the intake kickoff turn


async def test_start_with_populated_profile_shows_help_only(monkeypatch):
    captured = _capture_turn(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A,
                               "accessibility": {"medical_profile": "Has COPD."}}]})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/start"}},
        anthropic=None, supabase=FakeSupabase(db=db), registry=registry, telegram=tg,
    )
    assert tg.sent == [(111, telegram._HELP)]
    assert captured == {}  # no agent turn


async def test_setup_reruns_intake_even_with_profile(monkeypatch):
    captured = _capture_turn(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A,
                               "accessibility": {"medical_profile": "Has COPD."}}]})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/setup"}},
        anthropic=None, supabase=FakeSupabase(db=db), registry=registry, telegram=tg,
    )
    assert registry.get(111).intake_active is True
    assert "set up or redo" in captured["text"]


# --- Schedule commands -------------------------------------------------------
async def test_week_command_renders_week_view(monkeypatch):
    med_id = "00000000-0000-0000-0000-0000000000d1"
    db = FakeDB({
        "medications": [{"id": med_id, "name": "Metformin", "archived": False,
                         "schedule": {"times": ["08:00"]}}],
        "doses": [],
    })
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/week"}},
        anthropic=None, supabase=FakeSupabase(db=db), registry=registry, telegram=tg,
    )
    assert "This week:" in tg.sent[-1][1]
    assert tg.markups[-1] is None  # week view carries no Took-it buttons


# --- Language stickiness + voice policy (mirror the user) -------------------
async def test_short_message_keeps_last_detected_language(monkeypatch):
    """A follow-up too short to detect must not flip the conversation language."""
    use_anthropic(monkeypatch)
    detections = iter(["zlm", None])  # confident Malay, then an undetectable "ya"
    monkeypatch.setattr(telegram, "detect_language", lambda text: next(detections))

    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "en"}], "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    anthropic = FakeAnthropic([response("end_turn", [text_block("Baik!")])])
    kwargs = dict(anthropic=anthropic, supabase=FakeSupabase(db=db),
                  registry=registry, telegram=tg)

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "apa khabar semua"}}, **kwargs)
    assert registry.get(111).last_lang_iso == "zlm"

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "ya"}}, **kwargs)
    # Second turn still speaks Malay to the model.
    system_text = "".join(b["text"] for b in anthropic.messages.calls[-1]["system"])
    assert "Malay" in system_text


async def test_typed_message_with_tts_opt_in_gets_audio(monkeypatch):
    use_anthropic(monkeypatch)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "eng")

    async def fake_synthesize(text, *, model=None):
        return b"WAVDATA"

    monkeypatch.setattr(telegram, "synthesize", fake_synthesize)
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "en",
                               "accessibility": {"tts": True}}],
                 "conversation_turns": []})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    anthropic = FakeAnthropic([response("end_turn", [text_block("Sure!")])])

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "what are my meds?"}},
        anthropic=anthropic, supabase=FakeSupabase(db=db), registry=registry, telegram=tg,
    )
    assert tg.audio_sent == [(111, b"WAVDATA")]  # opted in -> spoken even when typed


async def test_voice_command_toggles_and_persists(monkeypatch):
    db = FakeDB({"profiles": [{"id": ELDER_A, "accessibility": {"medical_profile": "x"}}]})
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    kwargs = dict(anthropic=None, supabase=FakeSupabase(db=db),
                  registry=registry, telegram=tg)

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/voice on"}}, **kwargs)
    state = registry.get(111)
    assert state.voice_default is True and state.voice_loaded is True
    table, patch, _ = db.updated[-1]
    assert table == "profiles" and patch["accessibility"]["tts"] is True
    assert patch["accessibility"]["medical_profile"] == "x"  # merged, not clobbered
    assert "on" in tg.sent[-1][1].lower()

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/voice off"}}, **kwargs)
    assert state.voice_default is False
    assert db.updated[-1][1]["accessibility"]["tts"] is False

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "text": "/voice"}}, **kwargs)
    assert "/voice on" in tg.sent[-1][1]  # bare command -> usage line


async def test_spoken_turn_with_failed_tts_sends_notice(monkeypatch):
    use_anthropic(monkeypatch)

    async def fake_transcribe(audio, **_):
        return "what are my meds"

    async def failing_synthesize(text, *, model=None):
        return None  # TTS down

    monkeypatch.setattr(telegram, "transcribe", fake_transcribe)
    monkeypatch.setattr(telegram, "synthesize", failing_synthesize)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "eng")
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    anthropic = FakeAnthropic([response("end_turn", [text_block("Here they are.")])])

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "voice": {"file_id": "v1"}}},
        anthropic=anthropic, supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert tg.audio_sent == []
    assert "voice reply" in tg.sent[-1][1]  # honest notice, not silence


async def test_long_reply_is_spoken_in_chunks(monkeypatch):
    use_anthropic(monkeypatch)

    async def fake_transcribe(audio, **_):
        return "tell me everything"

    async def fake_synthesize(text, *, model=None):
        return text.encode()  # echo the chunk so we can count

    monkeypatch.setattr(telegram, "transcribe", fake_transcribe)
    monkeypatch.setattr(telegram, "synthesize", fake_synthesize)
    monkeypatch.setattr(telegram, "detect_language", lambda text: "eng")
    long_reply = "This is one sentence. " * 100  # ~2200 chars -> 3 chunks
    registry = SessionRegistry(ELDER_A)
    tg = FakeTelegram()
    anthropic = FakeAnthropic([response("end_turn", [text_block(long_reply)])])

    await telegram.handle_update(
        {"message": {"chat": {"id": 111}, "voice": {"file_id": "v1"}}},
        anthropic=anthropic, supabase=FakeSupabase(), registry=registry, telegram=tg,
    )
    assert len(tg.audio_sent) == 3
    assert all(len(audio) <= 1000 for _, audio in tg.audio_sent)


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


# --- /telegram/webhook HTTP route (guard logic, not handle_update itself) ---
_WEBHOOK_TELEGRAM_SENTINEL = object()


def _make_webhook_app(monkeypatch, *, telegram_state=_WEBHOOK_TELEGRAM_SENTINEL):
    """Build the real ASGI app with app.state populated by hand (ASGITransport
    doesn't run the lifespan) and handle_update stubbed so these tests only
    exercise the route's own guard logic (secret check + telegram-configured
    check + rate-limit middleware), not handle_update's internals."""
    calls: list[dict] = []

    async def fake_handle_update(update, **kwargs):
        calls.append({"update": update, **kwargs})

    monkeypatch.setattr(routes, "handle_update", fake_handle_update)
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.registry = SessionRegistry(ELDER_A)
    app.state.telegram = telegram_state
    return app, calls


def _webhook_client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def test_webhook_missing_secret_header_is_403(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "telegram_webhook_secret", "shh", raising=False)
    app, calls = _make_webhook_app(monkeypatch)
    body = {"message": {"chat": {"id": 1}, "text": "hi"}}

    async with _webhook_client(app) as c:
        resp = await c.post("/telegram/webhook", json=body)

    assert resp.status_code == 403
    assert calls == []


async def test_webhook_wrong_secret_header_is_403(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "telegram_webhook_secret", "shh", raising=False)
    app, calls = _make_webhook_app(monkeypatch)
    body = {"message": {"chat": {"id": 1}, "text": "hi"}}

    async with _webhook_client(app) as c:
        resp = await c.post(
            "/telegram/webhook",
            json=body,
            headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"},
        )

    assert resp.status_code == 403
    assert calls == []


async def test_webhook_matching_secret_header_succeeds(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "telegram_webhook_secret", "shh", raising=False)
    app, calls = _make_webhook_app(monkeypatch)
    body = {"message": {"chat": {"id": 1}, "text": "hi"}}

    async with _webhook_client(app) as c:
        resp = await c.post(
            "/telegram/webhook",
            json=body,
            headers={"X-Telegram-Bot-Api-Secret-Token": "shh"},
        )

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert len(calls) == 1
    assert calls[0]["update"] == body


async def test_webhook_secret_unset_allows_any_request(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "telegram_webhook_secret", "", raising=False)
    app, calls = _make_webhook_app(monkeypatch)
    body = {"message": {"chat": {"id": 1}, "text": "hi"}}

    async with _webhook_client(app) as c:
        # No secret header at all, and secret is unset -> still succeeds.
        resp = await c.post("/telegram/webhook", json=body)

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert len(calls) == 1


async def test_webhook_returns_503_when_telegram_not_configured(monkeypatch):
    """app.state.telegram is None (bot token unset) -> 503, regardless of the
    secret header (even when the secret matches or is unset)."""
    s = get_settings()
    monkeypatch.setattr(s, "telegram_webhook_secret", "", raising=False)
    app, calls = _make_webhook_app(monkeypatch, telegram_state=None)
    body = {"message": {"chat": {"id": 1}, "text": "hi"}}

    async with _webhook_client(app) as c:
        resp = await c.post("/telegram/webhook", json=body)

    assert resp.status_code == 503
    assert calls == []


async def test_webhook_is_subject_to_per_ip_rate_limit_middleware(monkeypatch):
    """Regression: /telegram/webhook must remain in main._RATE_LIMITED_PATHS
    alongside /agent/turn and /profile/extract."""
    s = get_settings()
    monkeypatch.setattr(s, "telegram_webhook_secret", "", raising=False)
    monkeypatch.setattr(s, "rate_limit_http_per_minute", 1, raising=False)
    app, calls = _make_webhook_app(monkeypatch)
    body = {"message": {"chat": {"id": 1}, "text": "hi"}}

    async with _webhook_client(app) as c:
        first = await c.post("/telegram/webhook", json=body)
        second = await c.post("/telegram/webhook", json=body)

    assert first.status_code == 200
    assert second.status_code == 429
    assert len(calls) == 1  # only the allowed request reached the handler
