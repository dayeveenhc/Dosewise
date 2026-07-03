"""Per-tool unit tests — offline, via the FakeDB/FakeSupabase doubles.

Covers every registered tool's key branches: happy path, empty/not-found, and
(for the safety-relevant ones) the write it performs.
"""

from __future__ import annotations

import hermes.tools.drug_info as drug_info
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
