"""undo_dose — flip a mistakenly-ticked dose back, immediately, today-only.

Undo must target the MOST RECENTLY logged (logged_at desc) taken dose of today
(elder tz), optionally narrowed to a named med; it never touches yesterday's
records, writes nothing when there's nothing to undo, and asks (no write) on an
ambiguous name.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from fakes import FakeDB
from helpers import assert_row, pin_clock, reread_rows
from hermes.tools.base import get_handler
from test_tools import ELDER_A, _ctx

# 14:20 SGT (06:20 UTC) on 2026-07-26; local midnight is 2026-07-25T16:00Z.
_NOW = datetime(2026, 7, 26, 6, 20, tzinfo=UTC)
_SLOT_0800 = "2026-07-26T00:00:00+00:00"  # 08:00 SGT
_SLOT_1200 = "2026-07-26T04:00:00+00:00"  # 12:00 SGT


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    pin_clock(monkeypatch, _NOW)


def _db() -> FakeDB:
    return FakeDB({
        "medications": [
            {"id": "m1", "name": "Metformin", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Lisinopril", "archived": False,
             "schedule": {"times": ["12:00"], "frequency": "daily"}},
        ],
        "doses": [
            {"id": "d1", "medication_id": "m1", "elder_id": ELDER_A,
             "scheduled_at": _SLOT_0800, "status": "taken",
             "logged_at": "2026-07-26T05:00:00+00:00", "logged_by": ELDER_A},
            {"id": "d2", "medication_id": "m2", "elder_id": ELDER_A,
             "scheduled_at": _SLOT_1200, "status": "taken",
             "logged_at": "2026-07-26T06:00:00+00:00", "logged_by": ELDER_A},
        ],
    })


async def test_undo_flips_most_recently_logged_dose_today():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("undo_dose")(ctx)
    # d2 (Lisinopril, logged 06:00Z) is the most recent tick — that's the undo.
    assert "Lisinopril" in out and "12:00 PM" in out
    rows = await reread_rows(db, "doses", id="d2")
    assert_row(rows, status="pending", logged_at=None, logged_by=None)
    # The other tick is untouched.
    assert_row(await reread_rows(db, "doses", id="d1"), status="taken")
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "undo_dose"
    assert action["entity_type"] == "dose"
    assert action["entity_id"] == "m2"  # medication id — the card the UI renders
    assert action["dose_id"] == "d2"
    assert action["name"] == "Lisinopril"
    assert action["changed_fields"] == {
        "status": {"before": "taken", "after": "pending"}
    }


async def test_undo_named_med_targets_that_med_only():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("undo_dose")(ctx, medication_name="Metformin")
    # m2's tick is newer, but the name narrows the undo to Metformin's.
    assert "Metformin" in out and "8:00 AM" in out
    assert_row(await reread_rows(db, "doses", id="d1"), status="pending")
    assert_row(await reread_rows(db, "doses", id="d2"), status="taken")
    assert ctx.committed_actions[0]["dose_id"] == "d1"


async def test_undo_ignores_yesterdays_doses():
    db = _db()
    # Push both ticks before local midnight (2026-07-25T16:00Z) — yesterday SGT.
    for row in db.tables["doses"]:
        row["logged_at"] = "2026-07-25T10:00:00+00:00"
    ctx = _ctx(db)
    out = await get_handler("undo_dose")(ctx)
    assert "nothing to undo" in out.lower()
    assert not db.updated and not ctx.committed_actions
    # Independent re-read: both records still taken.
    for dose_id in ("d1", "d2"):
        assert_row(await reread_rows(db, "doses", id=dose_id), status="taken")


async def test_undo_unknown_name_is_honest_miss():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("undo_dose")(ctx, medication_name="Nope")
    assert "No medication named" in out
    assert not db.updated and not ctx.committed_actions


async def test_undo_ambiguous_name_asks_and_writes_nothing():
    db = FakeDB({
        "medications": [
            {"id": "m1", "name": "Vitamin D", "archived": False, "schedule": {}},
            {"id": "m2", "name": "Vitamin B12", "archived": False, "schedule": {}},
        ],
        "doses": [
            {"id": "d1", "medication_id": "m1", "elder_id": ELDER_A,
             "scheduled_at": _SLOT_0800, "status": "taken",
             "logged_at": "2026-07-26T05:00:00+00:00", "logged_by": ELDER_A},
        ],
    })
    ctx = _ctx(db)
    out = await get_handler("undo_dose")(ctx, medication_name="vitamin")
    assert "More than one medication matches" in out
    assert not db.updated and not ctx.committed_actions
    assert_row(await reread_rows(db, "doses", id="d1"), status="taken")


async def test_undo_named_med_with_no_tick_today_is_honest():
    db = _db()
    db.tables["doses"] = [db.tables["doses"][1]]  # only Lisinopril ticked
    ctx = _ctx(db)
    out = await get_handler("undo_dose")(ctx, medication_name="Metformin")
    assert "Metformin" in out and "nothing to undo" in out.lower()
    assert not db.updated and not ctx.committed_actions
