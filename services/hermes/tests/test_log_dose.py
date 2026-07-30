"""log_dose slot-disambiguation suite (Phase-1 fix for "I took my metformin").

Live-proven root cause (2026-07-26, evidence on :8901): with morning+evening
doses both pending, the old code marked the LATEST pending row taken — at 2pm a
"just took my metformin" ticked the 8 PM dose while the overdue 8 AM one stayed
pending, and "my MORNING metformin" did the same because the tool had no slot
parameter. These tests pin the fix: earliest-first attribution, ask-when-
ambiguous (no write), proceed-when-unambiguous, slot/day-part targeting, an
already-taken guard, and the no-name ("I took my pills") path.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from fakes import FakeDB
from hermes.tools import doses
from hermes.tools.base import get_handler
from test_tools import ELDER_A, _ctx

# Pin "now" to 14:20 SGT (06:20 UTC) on 2026-07-26 — between an 08:00 and a
# 20:00 slot, the live-repro wall-clock.
_NOW = datetime(2026, 7, 26, 6, 20, tzinfo=UTC)
_SLOT_0800 = "2026-07-26T00:00:00+00:00"  # 08:00 SGT
_SLOT_2000 = "2026-07-26T12:00:00+00:00"  # 20:00 SGT


@pytest.fixture(autouse=True)
def _pin_clock(monkeypatch):
    from hermes.config import get_settings

    monkeypatch.setattr(doses, "_now_utc", lambda: _NOW)
    monkeypatch.setattr(get_settings(), "hermes_tz", "Asia/Singapore", raising=False)


def _db_two_pending() -> FakeDB:
    return FakeDB({
        "medications": [{
            "id": "m1", "name": "Metformin", "archived": False,
            "schedule": {"times": ["08:00", "20:00"], "frequency": "daily"},
        }],
        "doses": [
            {"id": "d-am", "medication_id": "m1", "elder_id": ELDER_A,
             "scheduled_at": _SLOT_0800, "status": "pending"},
            {"id": "d-pm", "medication_id": "m1", "elder_id": ELDER_A,
             "scheduled_at": _SLOT_2000, "status": "pending"},
        ],
    })


# --- ambiguous: ask, never guess, never write --------------------------------
async def test_two_pending_no_slot_asks_and_writes_nothing():
    db = _db_two_pending()
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="Metformin")
    assert "more than one dose" in out.lower()
    assert "8:00 AM" in out and "8:00 PM" in out
    assert 'slot "08:00"' in out and 'slot "20:00"' in out
    # The independent re-read shows NOTHING changed.
    assert not db.updated and not db.inserted
    assert not ctx.committed_actions
    rows = await db.select("doses", filters={"status": "eq.pending"})
    assert {r["id"] for r in rows} == {"d-am", "d-pm"}


async def test_two_pending_with_slot_flips_that_slot():
    db = _db_two_pending()
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="Metformin", slot="08:00")
    assert "Logged Metformin" in out
    assert db.updated and db.updated[0][2]["id"] == "eq.d-am"
    # Independent re-read: morning taken, evening STILL pending.
    taken = await db.select("doses", filters={"status": "eq.taken"})
    pending = await db.select("doses", filters={"status": "eq.pending"})
    assert [r["id"] for r in taken] == ["d-am"]
    assert [r["id"] for r in pending] == ["d-pm"]
    assert ctx.committed_actions[0]["dose_id"] == "d-am"


async def test_day_part_slot_maps_to_nearest_time():
    db = _db_two_pending()
    ctx = _ctx(db)
    await get_handler("log_dose")(ctx, medication_name="Metformin", slot="evening")
    assert db.updated and db.updated[0][2]["id"] == "eq.d-pm"
    assert ctx.committed_actions[0]["dose_id"] == "d-pm"


# --- unambiguous: proceed without asking, earliest-first ---------------------
async def test_single_pending_logs_without_asking():
    db = FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "archived": False,
                         "schedule": {"times": ["08:00"], "frequency": "daily"}}],
        "doses": [{"id": "d-am", "medication_id": "m1", "elder_id": ELDER_A,
                   "scheduled_at": _SLOT_0800, "status": "pending"}],
    })
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="Metformin")
    assert "Logged Metformin as taken" in out and "which" not in out.lower()
    assert db.updated[0][2]["id"] == "eq.d-am"


async def test_one_pending_one_taken_flips_the_pending_one():
    """Morning already taken → 'took my metformin' can only mean the evening."""
    db = _db_two_pending()
    db.tables["doses"][0]["status"] = "taken"  # d-am done this morning
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="Metformin")
    assert "Logged Metformin" in out
    assert db.updated and db.updated[0][2]["id"] == "eq.d-pm"


# --- label echo + multi-med matching ----------------------------------------
async def test_label_echo_with_dosage_still_resolves():
    db = _db_two_pending()
    ctx = _ctx(db)
    out = await get_handler("log_dose")(
        ctx, medication_name="Metformin 500mg", slot="morning"
    )
    assert "Logged Metformin" in out
    assert db.updated and db.updated[0][2]["id"] == "eq.d-am"


async def test_substring_match_on_two_meds_asks_which():
    db = FakeDB({
        "medications": [
            {"id": "m1", "name": "Vitamin D", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Vitamin B12", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
        ],
        "doses": [],
    })
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="vitamin")
    assert "More than one medication matches" in out
    assert "Vitamin D" in out and "Vitamin B12" in out
    assert not db.inserted and not db.updated and not ctx.committed_actions


# --- schedule fallback (no pending rows materialised) ------------------------
async def test_no_pending_single_due_slot_backdates_to_slot():
    db = FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "archived": False,
                         "schedule": {"times": ["08:00", "20:00"],
                                      "frequency": "daily"}}],
        "doses": [],
    })
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="Metformin")
    # At 14:20 only 08:00 is due-and-unmet — exactly one plausible dose.
    assert "8:00 AM" in out
    assert db.inserted and db.inserted[0][1]["scheduled_at"] == _SLOT_0800
    assert ctx.committed_actions[0]["slot"] == "08:00"


async def test_already_taken_today_guards_double_log():
    db = FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "archived": False,
                         "schedule": {"times": ["08:00"], "frequency": "daily"}}],
        "doses": [{"id": "d-am", "medication_id": "m1", "elder_id": ELDER_A,
                   "scheduled_at": _SLOT_0800, "status": "taken",
                   "logged_at": _SLOT_0800}],
    })
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx, medication_name="Metformin")
    assert "already logged" in out.lower()
    assert not db.inserted and not db.updated and not ctx.committed_actions


# --- no medication named ("I took my pills") --------------------------------
async def test_no_name_single_candidate_logs_it():
    db = FakeDB({
        "medications": [
            {"id": "m1", "name": "Metformin", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Lisinopril", "archived": False,
             "schedule": {"times": ["20:00"], "frequency": "daily"}},
        ],
        "doses": [{"id": "d-am", "medication_id": "m1", "elder_id": ELDER_A,
                   "scheduled_at": _SLOT_0800, "status": "pending"}],
    })
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx)
    # Lisinopril's 20:00 isn't due yet — Metformin is the only plausible dose.
    assert "Logged Metformin" in out
    assert db.updated and db.updated[0][2]["id"] == "eq.d-am"


async def test_no_name_multiple_candidates_asks_which():
    db = FakeDB({
        "medications": [
            {"id": "m1", "name": "Metformin", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Lisinopril", "archived": False,
             "schedule": {"times": ["09:00"], "frequency": "daily"}},
        ],
        "doses": [],
    })
    ctx = _ctx(db)
    out = await get_handler("log_dose")(ctx)
    assert "Several medications" in out
    assert "Metformin" in out and "Lisinopril" in out
    assert not db.inserted and not db.updated and not ctx.committed_actions
