"""Per-tool unit tests — offline, via the FakeDB/FakeSupabase doubles.

Covers every registered tool's key branches: happy path, empty/not-found, and
(for the safety-relevant ones) the write it performs.
"""

from __future__ import annotations

import hermes.tools.drug_info as drug_info
import hermes.tools.interactions as interactions
from fakes import FakeDB, FakeSupabase, FakeTelegram
from hermes.channels.session import SessionRegistry, SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"
CAREGIVER_C = "00000000-0000-0000-0000-00000000000c"


def _ctx(db: FakeDB, **kw) -> ToolContext:
    supa = FakeSupabase(db=db)
    return ToolContext(
        supabase=supa, elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A), **kw
    )


# --- list_medications -------------------------------------------------------
async def test_list_medications_formats_rows():
    db = FakeDB({"medications": [
        {"name": "Metformin", "dosage": "500mg", "purpose": "Blood sugar",
         "schedule": {"times": ["08:00", "20:00"]}, "priority": "critical",
         "instructions": "After meals.", "archived": False},
    ]})
    out = await get_handler("list_medications")(_ctx(db))
    assert "Metformin" in out and "500mg" in out and "08:00" in out


async def test_list_medications_empty():
    out = await get_handler("list_medications")(_ctx(FakeDB({"medications": []})))
    assert "No medications" in out


# --- log_dose ---------------------------------------------------------------
async def test_log_dose_marks_pending_taken():
    db = FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "archived": False}],
        "doses": [{"id": "d1", "scheduled_at": "2026-07-02T20:00:00+00:00",
                   "status": "pending", "medication_id": "m1"}],
    })
    out = await get_handler("log_dose")(_ctx(db), medication_name="Metformin")
    assert "Logged Metformin" in out
    assert db.updated and db.updated[0][0] == "doses"
    assert db.updated[0][1]["status"] == "taken"


async def test_log_dose_no_pending_inserts_new():
    db = FakeDB({"medications": [{"id": "m1", "name": "Metformin", "archived": False}],
                 "doses": []})
    out = await get_handler("log_dose")(_ctx(db), medication_name="Metformin")
    assert "just now" in out
    assert db.inserted and db.inserted[0][0] == "doses"


async def test_log_dose_unknown_medication():
    db = FakeDB({"medications": [], "doses": []})
    out = await get_handler("log_dose")(_ctx(db), medication_name="Nope")
    assert "No medication named" in out
    assert not db.inserted and not db.updated


# --- get_drug_info ----------------------------------------------------------
async def test_get_drug_info_cache_hit():
    payload = {"results": [{"purpose": ["Lowers blood sugar."]}]}
    db = FakeDB({"drug_cache": [{"drug_key": "metformin", "openfda_payload": payload}]})
    out = await get_handler("get_drug_info")(_ctx(db), drug_name="Metformin")
    assert "Lowers blood sugar" in out and "cached" in out


async def test_get_drug_info_cache_miss_fetches_and_writes_through(monkeypatch):
    fetched = {"results": [{"indications_and_usage": ["For type 2 diabetes."]}]}

    class _Resp:
        status_code = 200

        def json(self):
            return fetched

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            return _Resp()

    monkeypatch.setattr(drug_info.httpx, "AsyncClient", _Client)
    db = FakeDB({"drug_cache": []})
    out = await get_handler("get_drug_info")(_ctx(db), drug_name="Metformin")
    assert "type 2 diabetes" in out
    # write-through cache used the service client (same FakeDB here).
    assert any(t == "drug_cache" for t, _ in db.inserted)


async def test_get_drug_info_query_keeps_plus_literal(monkeypatch):
    """Regression: OpenFDA's '+' term-separator must reach the API literal, not
    percent-encoded to %2B. Passing the query via httpx params= encodes '+' -> %2B,
    which 500s and breaks every uncached grounding lookup."""
    seen: dict[str, str] = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"results": [{"purpose": ["Lowers blood sugar."]}]}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, *a, **k):
            seen["url"] = url
            return _Resp()

    monkeypatch.setattr(drug_info.httpx, "AsyncClient", _Client)
    await get_handler("get_drug_info")(_ctx(FakeDB({"drug_cache": []})), drug_name="Metformin")
    assert "openfda.brand_name:metformin+OR+openfda.generic_name:metformin" in seen["url"]
    assert "%2B" not in seen["url"]


async def test_get_drug_info_brand_falls_back_to_generic(monkeypatch):
    """A brand OpenFDA doesn't index (e.g. Panadol) should retry via the generic
    alias rather than bare-refusing."""
    seen: list[str] = []

    class _Resp:
        def __init__(self, results):
            self.status_code = 200
            self._results = results

        def json(self):
            return {"results": self._results}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, *a, **k):
            seen.append(url)
            # First (brand OR generic) query misses; the generic-alias query hits.
            if "acetaminophen" in url:
                return _Resp([{"purpose": ["Pain reliever / fever reducer."]}])
            return _Resp([])

    monkeypatch.setattr(drug_info.httpx, "AsyncClient", _Client)
    out = await get_handler("get_drug_info")(_ctx(FakeDB({"drug_cache": []})), drug_name="Panadol")
    assert "Pain reliever" in out
    assert any("acetaminophen" in u for u in seen)


# --- check_drug_interactions ------------------------------------------------
async def test_check_interactions_pair_flags_when_mentioned(monkeypatch):
    async def _fake(ctx, name):
        return "May interact with warfarin and increase bleeding risk." if name.lower() == "aspirin" else ""

    monkeypatch.setattr(interactions, "interaction_text", _fake)
    out = await get_handler("check_drug_interactions")(
        _ctx(FakeDB({})), drug_a="Aspirin", drug_b="Warfarin"
    )
    assert "⚠" in out and "OpenFDA" in out


async def test_check_interactions_pair_no_mention(monkeypatch):
    async def _fake(ctx, name):
        return "Take with food."

    monkeypatch.setattr(interactions, "interaction_text", _fake)
    out = await get_handler("check_drug_interactions")(
        _ctx(FakeDB({})), drug_a="Vitamin C", drug_b="Metformin"
    )
    assert "don't specifically mention" in out


async def test_check_interactions_against_current_meds(monkeypatch):
    async def _fake(ctx, name):
        return "Concomitant use with metformin may require monitoring."

    monkeypatch.setattr(interactions, "interaction_text", _fake)
    db = FakeDB({"medications": [{"name": "Metformin", "archived": False}]})
    out = await get_handler("check_drug_interactions")(_ctx(db), drug_a="Cimetidine")
    assert "Metformin" in out and "⚠" in out


async def test_check_interactions_no_data_offers_doctor(monkeypatch):
    async def _fake(ctx, name):
        return ""

    monkeypatch.setattr(interactions, "interaction_text", _fake)
    out = await get_handler("check_drug_interactions")(
        _ctx(FakeDB({})), drug_a="Mystery", drug_b="Other"
    )
    assert "add_doctor_question" in out


async def test_get_drug_info_unreachable_reports_transient(monkeypatch):
    """When OpenFDA is unreachable (network error), the reply must say 'try again',
    not 'no such drug' — and must not invent facts."""

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, *a, **k):
            raise drug_info.httpx.ConnectError("boom")

    monkeypatch.setattr(drug_info.httpx, "AsyncClient", _Client)
    out = await get_handler("get_drug_info")(_ctx(FakeDB({"drug_cache": []})), drug_name="Metformin")
    assert "again" in out.lower()


# --- message_caregiver ------------------------------------------------------
async def test_message_caregiver_records_and_delivers():
    db = FakeDB({"care_links": [
        {"caregiver_id": CAREGIVER_C, "elder_id": ELDER_A, "status": "active"}]})
    registry = SessionRegistry(ELDER_A)
    registry._profile_to_chat[CAREGIVER_C] = 999  # caregiver is on the bot
    session = SessionState(elder_id=ELDER_A, registry=registry)
    tg = FakeTelegram()
    ctx = ToolContext(supabase=FakeSupabase(db=db), elder_id=ELDER_A,
                      session=session, telegram=tg)
    out = await get_handler("message_caregiver")(ctx, message="She missed her dose.")
    assert "delivered to 1" in out
    assert db.inserted[0][0] == "conversation_turns"
    assert tg.sent and "She missed her dose." in tg.sent[0][1]


async def test_message_caregiver_records_without_live_delivery():
    db = FakeDB({"care_links": []})
    out = await get_handler("message_caregiver")(_ctx(db), message="FYI")
    assert "recorded" in out.lower()
    assert db.inserted[0][0] == "conversation_turns"


# --- request_human_help -----------------------------------------------------
async def test_request_human_help_logs_escalation():
    db = FakeDB({"doctor_questions": []})
    out = await get_handler("request_human_help")(_ctx(db), reason="feels dizzy",
                                                   urgency="high")
    assert "escalation" in out.lower()
    table, row = db.inserted[0]
    assert table == "doctor_questions"
    assert row["question"].startswith("[ESCALATION]")
    assert row["context"]["urgency"] == "high"


# --- show_instruction_video -------------------------------------------------
async def test_show_instruction_video_found():
    db = FakeDB({"instruction_videos": [
        {"title": "How to use eye drops", "technique": "eye_drops",
         "storage_path": "videos/eye_drops.mp4"}]})
    out = await get_handler("show_instruction_video")(_ctx(db), technique="eye_drops")
    assert "eye drops" in out.lower()


async def test_show_instruction_video_missing():
    db = FakeDB({"instruction_videos": []})
    out = await get_handler("show_instruction_video")(_ctx(db), technique="nebulizer")
    assert "No instruction video" in out


# --- add_doctor_question ----------------------------------------------------
async def test_add_doctor_question_inserts():
    db = FakeDB({"doctor_questions": []})
    out = await get_handler("add_doctor_question")(
        _ctx(db), question="Is dizziness a side effect?", context="metformin")
    assert "doctor" in out.lower()
    table, row = db.inserted[0]
    assert table == "doctor_questions"
    assert row["context"]["note"] == "metformin"


# --- check_refills / log_refill --------------------------------------------
async def test_check_refills_flags_low():
    db = FakeDB({"refills": [
        {"pills_remaining": 3, "threshold": 5, "run_out_forecast": "2026-07-06",
         "medications": {"name": "Metformin"}},
        {"pills_remaining": 30, "threshold": 5, "run_out_forecast": None,
         "medications": {"name": "Vitamin D3"}},
    ]})
    out = await get_handler("check_refills")(_ctx(db))
    assert "RUNNING LOW" in out
    assert "Low on: Metformin" in out


async def test_check_refills_empty():
    out = await get_handler("check_refills")(_ctx(FakeDB({"refills": []})))
    assert "No refill counts" in out


async def test_log_refill_updates_existing():
    db = FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "archived": False,
                         "schedule": {"times": ["08:00", "20:00"]}}],
        "refills": [{"id": "r1", "medication_id": "m1"}],
    })
    out = await get_handler("log_refill")(_ctx(db), medication_name="Metformin",
                                          pills_remaining=60, threshold=10)
    assert "60 pills" in out
    assert db.updated and db.updated[0][0] == "refills"
    assert db.updated[0][1]["pills_remaining"] == 60
    assert db.updated[0][1]["threshold"] == 10


async def test_log_refill_inserts_when_absent():
    db = FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "archived": False,
                         "schedule": {"times": ["08:00"]}}],
        "refills": [],
    })
    out = await get_handler("log_refill")(_ctx(db), medication_name="Metformin",
                                          pills_remaining=30)
    assert "30 pills" in out
    assert any(t == "refills" for t, _ in db.inserted)


async def test_log_refill_unknown_medication():
    db = FakeDB({"medications": [], "refills": []})
    out = await get_handler("log_refill")(_ctx(db), medication_name="Nope",
                                          pills_remaining=10)
    assert "No medication named" in out
    assert not db.inserted and not db.updated


# --- add_prescription photo storage ----------------------------------------
async def test_add_prescription_uploads_photo_on_confirm():
    add = get_handler("add_prescription")
    db = FakeDB({"medications": []})
    supa = FakeSupabase(db=db)
    session = SessionState(elder_id=ELDER_A)
    session.pending_image = b"JPEGBYTES"
    ctx = ToolContext(supabase=supa, elder_id=ELDER_A, session=session)

    await add(ctx, name="Metformin", confirmed=False, dosage="500mg")  # propose
    out = await add(ctx, name="Metformin", confirmed=True, dosage="500mg")  # confirm
    assert "Saved" in out
    assert supa.uploads and supa.uploads[0][0] == "pill-photos"
    assert supa.uploads[0][1].startswith(f"{ELDER_A}/")
    med_rows = [r for t, r in db.inserted if t == "medications"]
    assert med_rows and med_rows[0]["pill_photo_path"].startswith(f"{ELDER_A}/")
    assert session.pending_image is None  # cleared after commit


async def test_add_prescription_saves_med_even_if_upload_fails():
    add = get_handler("add_prescription")
    db = FakeDB({"medications": []})
    supa = FakeSupabase(db=db, fail_upload=True)
    session = SessionState(elder_id=ELDER_A)
    session.pending_image = b"JPEG"
    ctx = ToolContext(supabase=supa, elder_id=ELDER_A, session=session)

    await add(ctx, name="Warfarin", confirmed=False)
    out = await add(ctx, name="Warfarin", confirmed=True)
    assert "Saved" in out
    med_rows = [r for t, r in db.inserted if t == "medications"]
    assert med_rows and "pill_photo_path" not in med_rows[0]  # graceful degrade


async def test_photo_not_attached_to_later_unrelated_med():
    """A photo proposed but never confirmed must not be saved onto a *different*
    medication that is confirmed later without its own photo (privacy)."""
    add = get_handler("add_prescription")
    db = FakeDB({"medications": []})
    supa = FakeSupabase(db=db)
    session = SessionState(elder_id=ELDER_A)
    session.pending_image = b"MEDX-PHOTO"
    ctx = ToolContext(supabase=supa, elder_id=ELDER_A, session=session)

    # Photo arrives, MedX proposed (image consumed onto the proposal) but never confirmed.
    await add(ctx, name="MedX", confirmed=False, dosage="10mg")
    assert session.pending_image is None  # consumed off the shared session slot

    # Later, an unrelated, photoless med is proposed and confirmed.
    await add(ctx, name="Aspirin", confirmed=False, dosage="100mg")
    out = await add(ctx, name="Aspirin", confirmed=True, dosage="100mg")
    assert "Saved" in out
    assert supa.uploads == []  # MedX's photo was NOT uploaded for Aspirin
    med_rows = [r for t, r in db.inserted if t == "medications"]
    assert med_rows and "pill_photo_path" not in med_rows[0]


async def test_add_prescription_carries_photo_on_repropose():
    """Re-proposing the SAME drug (model refined a field) keeps the photo, so a
    confirm after a correction still stores it."""
    add = get_handler("add_prescription")
    db = FakeDB({"medications": []})
    supa = FakeSupabase(db=db)
    session = SessionState(elder_id=ELDER_A)
    session.pending_image = b"JPEGBYTES"
    ctx = ToolContext(supabase=supa, elder_id=ELDER_A, session=session)

    await add(ctx, name="Metformin", confirmed=False, dosage="500mg")  # propose
    await add(ctx, name="Metformin", confirmed=False, dosage="850mg")  # re-propose, corrected
    out = await add(ctx, name="Metformin", confirmed=True, dosage="850mg")  # confirm
    assert "Saved" in out
    assert supa.uploads and supa.uploads[0][0] == "pill-photos"
    med_rows = [r for t, r in db.inserted if t == "medications"]
    assert med_rows and med_rows[0]["pill_photo_path"].startswith(f"{ELDER_A}/")


# --- set_medication_reminder ------------------------------------------------
async def test_set_reminder_proposes_no_write_and_awaits_confirmation():
    set_rem = get_handler("set_medication_reminder")
    db = FakeDB({"medications": [{"id": "m1", "name": "Metformin", "archived": False,
                                  "schedule": {"times": ["08:00"], "frequency": "daily"}}]})
    ctx = _ctx(db)
    out = await set_rem(ctx, name="Metformin", confirmed=False, times=["8:00", "20:00"])
    assert "PROPOSED" in out and "08:00" in out and "20:00" in out
    assert not db.updated  # nothing written on a proposal
    assert ctx.session.awaiting_confirmation is True
    assert ctx.session.pending_reminder == {"name": "Metformin", "times": ["08:00", "20:00"]}


async def test_set_reminder_confirm_updates_schedule_times():
    set_rem = get_handler("set_medication_reminder")
    db = FakeDB({"medications": [{"id": "m1", "name": "Metformin", "archived": False,
                                  "schedule": {"times": ["08:00"], "frequency": "daily"}}]})
    ctx = _ctx(db)
    await set_rem(ctx, name="Metformin", confirmed=False, times=["09:00", "21:00"])
    out = await set_rem(ctx, name="Metformin", confirmed=True, times=["09:00", "21:00"])
    assert "Saved" in out
    assert db.updated and db.updated[0][0] == "medications"
    patch, filters = db.updated[0][1], db.updated[0][2]
    assert patch["schedule"]["times"] == ["09:00", "21:00"]
    assert patch["schedule"]["frequency"] == "daily"  # existing frequency preserved
    assert filters == {"id": "eq.m1"}
    assert ctx.session.pending_reminder is None
    assert ctx.session.awaiting_confirmation is False


async def test_set_reminder_confirm_falls_back_to_proposed_times():
    # A tap-to-confirm that doesn't resupply `times` must still save the times the
    # user already confirmed (from the stashed proposal), not silently do nothing.
    set_rem = get_handler("set_medication_reminder")
    db = FakeDB({"medications": [{"id": "m1", "name": "Metformin", "archived": False,
                                  "schedule": {"times": ["08:00"], "frequency": "daily"}}]})
    ctx = _ctx(db)
    await set_rem(ctx, name="Metformin", confirmed=False, times=["09:00", "21:00"])
    out = await set_rem(ctx, name="Metformin", confirmed=True, times=None)
    assert "Saved" in out
    assert db.updated and db.updated[0][1]["schedule"]["times"] == ["09:00", "21:00"]
    assert ctx.session.pending_reminder is None
    assert ctx.session.awaiting_confirmation is False


async def test_set_reminder_confirm_without_proposal_refuses():
    set_rem = get_handler("set_medication_reminder")
    db = FakeDB({"medications": [{"id": "m1", "name": "Metformin", "archived": False,
                                  "schedule": {}}]})
    ctx = _ctx(db)
    out = await set_rem(ctx, name="Metformin", confirmed=True, times=["08:00"])
    assert "Refused" in out
    assert not db.updated


async def test_set_reminder_unknown_medication():
    set_rem = get_handler("set_medication_reminder")
    db = FakeDB({"medications": []})
    ctx = _ctx(db)
    await set_rem(ctx, name="Nope", confirmed=False, times=["08:00"])
    out = await set_rem(ctx, name="Nope", confirmed=True, times=["08:00"])
    assert "No medication named" in out
    assert not db.updated
    assert ctx.session.awaiting_confirmation is False


async def test_set_reminder_rejects_bad_time():
    set_rem = get_handler("set_medication_reminder")
    db = FakeDB({"medications": [{"id": "m1", "name": "Metformin", "archived": False,
                                  "schedule": {}}]})
    ctx = _ctx(db)
    out = await set_rem(ctx, name="Metformin", confirmed=False, times=["25:00", "lunch"])
    assert "aren't clear" in out
    assert not db.updated
    assert ctx.session.pending_reminder is None
    assert ctx.session.awaiting_confirmation is False
