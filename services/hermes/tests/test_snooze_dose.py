"""snooze_dose — TODAY-ONLY reminder snooze, never a schedule edit.

Targets the earliest due-but-unmet slot today (else the next upcoming slot);
persists to profiles.accessibility.dose_snoozes via read-merge-write (replacing
any entry for the same medication/slot/date, preserving unrelated accessibility
keys); refuses honestly when no slot today remains. Immediate write.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from fakes import FakeDB
from helpers import assert_row, pin_clock, reread_rows
from hermes.tools.base import get_handler
from test_tools import ELDER_A, _ctx

# 14:20 SGT (06:20 UTC) on 2026-07-26.
_NOW = datetime(2026, 7, 26, 6, 20, tzinfo=UTC)
_TODAY = "2026-07-26"


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    pin_clock(monkeypatch, _NOW)


def _db(accessibility: dict | None = None, doses: list | None = None) -> FakeDB:
    return FakeDB({
        "medications": [
            {"id": "m1", "name": "Metformin", "archived": False,
             "schedule": {"times": ["08:00", "20:00"], "frequency": "daily"}},
        ],
        "doses": list(doses or []),
        "profiles": [{"id": ELDER_A, "accessibility": dict(accessibility or {})}],
    })


async def test_default_30_minutes_targets_earliest_unmet_slot():
    db = _db(accessibility={"medical_profile": "Has diabetes."})
    ctx = _ctx(db)
    out = await get_handler("snooze_dose")(ctx, medication_name="Metformin")
    # 08:00 is due and unmet → that's the snoozed slot; now+30 = 14:50 SGT.
    assert "8:00 AM" in out and "2:50 PM" in out and "today only" in out
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    access = rows[0]["accessibility"]
    assert access["dose_snoozes"] == [{
        "medication_id": "m1", "name": "Metformin", "slot": "08:00",
        "date": _TODAY, "until": "14:50",
    }]
    # Read-merge-write: unrelated accessibility keys survive.
    assert access["medical_profile"] == "Has diabetes."
    # The medication's schedule is NOT a snooze target — untouched.
    assert_row(await reread_rows(db, "medications", id="m1"),
               schedule={"times": ["08:00", "20:00"], "frequency": "daily"})
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "snooze_dose"
    assert action["entity_type"] == "dose"
    assert action["entity_id"] == "m1"
    assert action["slot"] == "08:00"
    assert action["changed_fields"] == {
        "snoozed_until": {"before": None, "after": "14:50"}
    }


async def test_until_time_and_next_upcoming_slot_when_due_ones_met():
    # 08:00 already logged taken → the target is the upcoming 20:00 slot.
    db = _db(doses=[
        {"id": "d1", "medication_id": "m1", "elder_id": ELDER_A,
         "scheduled_at": "2026-07-26T00:00:00+00:00", "status": "taken"},
    ])
    ctx = _ctx(db)
    out = await get_handler("snooze_dose")(
        ctx, medication_name="Metformin", until="20:30"
    )
    assert "8:00 PM" in out and "8:30 PM" in out and "today only" in out
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    assert_row(rows[0]["accessibility"]["dose_snoozes"],
               medication_id="m1", slot="20:00", date=_TODAY, until="20:30")
    assert ctx.committed_actions[0]["changed_fields"]["snoozed_until"]["after"] \
        == "20:30"


async def test_resnooze_replaces_entry_for_same_slot_and_day():
    db = _db(accessibility={"dose_snoozes": [
        {"medication_id": "m1", "name": "Metformin", "slot": "08:00",
         "date": _TODAY, "until": "14:40"},
        {"medication_id": "m9", "name": "Other", "slot": "09:00",
         "date": _TODAY, "until": "15:00"},
    ]})
    ctx = _ctx(db)
    await get_handler("snooze_dose")(
        ctx, medication_name="Metformin", until="15:10"
    )
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    snoozes = rows[0]["accessibility"]["dose_snoozes"]
    # Replaced (not duplicated) for the same (med, slot, date); others intact.
    assert_row(snoozes, medication_id="m1", slot="08:00", until="15:10")
    assert_row(snoozes, medication_id="m9", until="15:00")
    assert len(snoozes) == 2
    # The replaced entry's old time is the honest `before`.
    assert ctx.committed_actions[0]["changed_fields"]["snoozed_until"] == {
        "before": "14:40", "after": "15:10"
    }


async def test_no_slots_today_refuses_honestly():
    db = _db()
    db.tables["medications"][0]["schedule"] = {"times": [], "frequency": "daily"}
    ctx = _ctx(db)
    out = await get_handler("snooze_dose")(ctx, medication_name="Metformin")
    assert "no scheduled dose times today" in out.lower()
    assert not db.updated and not ctx.committed_actions


async def test_all_doses_logged_and_none_upcoming_refuses_honestly(monkeypatch):
    # 22:00 SGT: both slots are past; both covered by taken doses.
    pin_clock(monkeypatch, datetime(2026, 7, 26, 14, 0, tzinfo=UTC))
    db = _db(doses=[
        {"id": "d1", "medication_id": "m1", "elder_id": ELDER_A,
         "scheduled_at": "2026-07-26T00:00:00+00:00", "status": "taken"},
        {"id": "d2", "medication_id": "m1", "elder_id": ELDER_A,
         "scheduled_at": "2026-07-26T12:00:00+00:00", "status": "taken"},
    ])
    ctx = _ctx(db)
    out = await get_handler("snooze_dose")(ctx, medication_name="Metformin")
    assert "nothing to snooze" in out.lower()
    assert not db.updated and not ctx.committed_actions


async def test_bad_until_time_writes_nothing():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("snooze_dose")(
        ctx, medication_name="Metformin", until="half past eight"
    )
    assert "isn't clear" in out
    assert not db.updated and not ctx.committed_actions


async def test_unknown_and_ambiguous_names_write_nothing():
    db = FakeDB({
        "medications": [
            {"id": "m1", "name": "Vitamin D", "archived": False,
             "schedule": {"times": ["08:00"]}},
            {"id": "m2", "name": "Vitamin B12", "archived": False,
             "schedule": {"times": ["08:00"]}},
        ],
        "doses": [],
        "profiles": [{"id": ELDER_A, "accessibility": {}}],
    })
    ctx = _ctx(db)
    out = await get_handler("snooze_dose")(ctx, medication_name="vitamin")
    assert "More than one medication matches" in out
    out = await get_handler("snooze_dose")(ctx, medication_name="Nope")
    assert "No medication named" in out
    assert not db.updated and not ctx.committed_actions
