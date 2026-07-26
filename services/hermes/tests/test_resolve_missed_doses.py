"""resolve_missed_doses — offline bulk propose→confirm tests via FakeDB doubles.

"Resolve and tick all my missing dosages" is ONE tool call, not an LLM fan-out of
log_dose per med. Proves the missed-set computation (past-due slots minus today's
taken doses, earliest-first attribution, elder-tz aware), the propose stash, the
confirm's back-dated inserts + single bulk committed action, the no-proposal
refusal, and honest per-row failure handling.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

import pytest

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"
TZ = "Asia/Singapore"
# Pinned clock: 2026-07-25 14:00 SGT (06:00 UTC) — 08:00/09:00/12:00 are past
# due, 20:00 is upcoming.
FIXED_NOW = datetime(2026, 7, 25, 6, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _pin_clock_and_tz(monkeypatch):
    from hermes.config import get_settings
    from hermes.tools import doses

    monkeypatch.setattr(doses, "_now_utc", lambda: FIXED_NOW)
    monkeypatch.setattr(get_settings(), "hermes_tz", TZ, raising=False)


def _slot_utc_iso(hhmm: str) -> str:
    """A slot's wall-clock time TODAY in the elder tz, as the UTC ISO the tool stores."""
    hh, mm = hhmm.split(":")
    local = datetime.combine(
        date(2026, 7, 25), time(int(hh), int(mm)), tzinfo=ZoneInfo(TZ)
    )
    return local.astimezone(UTC).isoformat()


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db),
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


def _db(doses_rows: list[dict] | None = None) -> FakeDB:
    return FakeDB(
        {
            "medications": [
                {"id": "m1", "name": "Metformin", "archived": False,
                 "schedule": {"times": ["08:00"]}},
                {"id": "m2", "name": "Amlodipine", "archived": False,
                 "schedule": {"times": ["09:00"]}},
                {"id": "m3", "name": "Atorvastatin", "archived": False,
                 "schedule": {"times": ["12:00"]}},
            ],
            "doses": list(doses_rows or []),
        }
    )


async def test_propose_lists_all_missed_and_writes_nothing():
    tool = get_handler("resolve_missed_doses")
    db = _db()
    ctx = _ctx(db)
    out = await tool(ctx, confirmed=False)
    assert "PROPOSED" in out
    for phrase in ("Metformin at 8:00 AM", "Amlodipine at 9:00 AM",
                   "Atorvastatin at 12:00 PM"):
        assert phrase in out
    assert not db.inserted and not db.updated  # nothing written on a proposal
    assert ctx.session.pending_missed_doses == [
        {"medication_id": "m1", "name": "Metformin", "slot": "08:00"},
        {"medication_id": "m2", "name": "Amlodipine", "slot": "09:00"},
        {"medication_id": "m3", "name": "Atorvastatin", "slot": "12:00"},
    ]
    assert ctx.session.awaiting_confirmation is True
    assert ctx.committed_actions == []


async def test_taken_dose_consumes_earliest_slot():
    # One Metformin dose already logged taken today: with times 08:00+12:00, the
    # earliest due slot (08:00) is attributed taken — only 12:00 is missed.
    tool = get_handler("resolve_missed_doses")
    db = FakeDB(
        {
            "medications": [
                {"id": "m1", "name": "Metformin", "archived": False,
                 "schedule": {"times": ["08:00", "12:00"]}},
            ],
            "doses": [
                {"id": "d0", "medication_id": "m1", "status": "taken",
                 "scheduled_at": _slot_utc_iso("08:00")},
            ],
        }
    )
    ctx = _ctx(db)
    out = await tool(ctx, confirmed=False)
    assert "12:00 PM" in out and "8:00 AM" not in out
    assert ctx.session.pending_missed_doses == [
        {"medication_id": "m1", "name": "Metformin", "slot": "12:00"},
    ]


async def test_confirm_inserts_backdated_rows_and_one_bulk_action():
    tool = get_handler("resolve_missed_doses")
    db = _db()
    ctx = _ctx(db)
    await tool(ctx, confirmed=False)
    out = await tool(ctx, confirmed=True)
    assert "Marked 3 missed doses as taken" in out

    # Three dose rows, scheduled_at back-dated to each SLOT (elder tz → UTC), not "now".
    rows = [row for table, row in db.inserted if table == "doses"]
    assert len(rows) == 3
    by_med = {r["medication_id"]: r for r in rows}
    assert by_med["m1"]["scheduled_at"] == _slot_utc_iso("08:00")
    assert by_med["m2"]["scheduled_at"] == _slot_utc_iso("09:00")
    assert by_med["m3"]["scheduled_at"] == _slot_utc_iso("12:00")
    for r in rows:
        assert r["status"] == "taken"
        assert r["elder_id"] == ELDER_A
        assert r["logged_by"] == ELDER_A
        assert r["logged_at"] == FIXED_NOW.isoformat()

    # ONE bulk committed action covering all three entities.
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "resolve_missed_doses"
    assert action["summary"] == "3 missed doses marked taken"
    assert len(action["entities"]) == 3
    for entity, (med_id, slot) in zip(
        action["entities"],
        [("m1", "08:00"), ("m2", "09:00"), ("m3", "12:00")],
        strict=True,
    ):
        assert entity["entity_type"] == "dose"
        assert entity["entity_id"] == med_id  # medication id — the card the UI renders
        assert entity["changed_fields"] == {
            "status": {"before": None, "after": "taken"}
        }
        assert entity["slot"] == slot
        assert entity["dose_id"]  # real (fake-db) dose row id captured
    assert action["dose_ids"] == [e["dose_id"] for e in action["entities"]]

    # Pending slot + confirmation flag cleared.
    assert ctx.session.pending_missed_doses is None
    assert ctx.session.awaiting_confirmation is False


async def test_confirm_without_proposal_refused():
    tool = get_handler("resolve_missed_doses")
    db = _db()
    ctx = _ctx(db)
    out = await tool(ctx, confirmed=True)
    assert "Refused" in out
    assert not db.inserted and not db.updated
    assert ctx.committed_actions == []


async def test_empty_missed_set_is_friendly_and_stashes_nothing():
    # Every due slot is already covered by a taken dose → nothing to resolve.
    tool = get_handler("resolve_missed_doses")
    db = _db(
        [
            {"id": f"d{i}", "medication_id": mid, "status": "taken",
             "scheduled_at": _slot_utc_iso(slot)}
            for i, (mid, slot) in enumerate(
                [("m1", "08:00"), ("m2", "09:00"), ("m3", "12:00")]
            )
        ]
    )
    ctx = _ctx(db)
    out = await tool(ctx, confirmed=False)
    assert "No missed doses today" in out
    assert ctx.session.pending_missed_doses is None
    assert ctx.session.awaiting_confirmation is False
    assert not db.inserted


async def test_future_times_only_med_contributes_nothing():
    tool = get_handler("resolve_missed_doses")
    db = FakeDB(
        {
            "medications": [
                {"id": "m1", "name": "Metformin", "archived": False,
                 "schedule": {"times": ["08:00"]}},
                {"id": "m4", "name": "Melatonin", "archived": False,
                 "schedule": {"times": ["20:00", "22:00"]}},  # all upcoming at 14:00
            ],
            "doses": [],
        }
    )
    ctx = _ctx(db)
    out = await tool(ctx, confirmed=False)
    assert "Metformin" in out and "Melatonin" not in out
    assert ctx.session.pending_missed_doses == [
        {"medication_id": "m1", "name": "Metformin", "slot": "08:00"},
    ]


async def test_confirm_recomputes_and_skips_doses_logged_since_propose():
    # A dose logged between propose and confirm must not be double-written: the
    # confirm re-computes fresh and intersects with what was proposed.
    tool = get_handler("resolve_missed_doses")
    db = _db()
    ctx = _ctx(db)
    await tool(ctx, confirmed=False)
    db.tables["doses"].append(
        {"id": "d-race", "medication_id": "m1", "status": "taken",
         "scheduled_at": _slot_utc_iso("08:00")}
    )
    out = await tool(ctx, confirmed=True)
    assert "Marked 2 missed doses as taken" in out
    rows = [row for table, row in db.inserted if table == "doses"]
    assert {r["medication_id"] for r in rows} == {"m2", "m3"}
    assert len(ctx.committed_actions) == 1
    assert len(ctx.committed_actions[0]["entities"]) == 2


class _FlakyInsertDB(FakeDB):
    """FakeDB whose doses insert fails for one medication_id."""

    def __init__(self, tables, fail_for: str):
        super().__init__(tables)
        self._fail_for = fail_for

    async def insert(self, table, row, returning=True):
        if table == "doses" and row.get("medication_id") == self._fail_for:
            raise RuntimeError("insert failed")
        return await super().insert(table, row, returning=returning)


async def test_partial_insert_failure_reported_honestly():
    tool = get_handler("resolve_missed_doses")
    db = _FlakyInsertDB(_db().tables, fail_for="m2")
    ctx = _ctx(db)
    await tool(ctx, confirmed=False)
    out = await tool(ctx, confirmed=True)
    assert "Marked 2 of 3 missed doses as taken" in out
    assert "Could not save" in out and "Amlodipine" in out
    # The failed med is excluded from the bulk action's entities.
    assert len(ctx.committed_actions) == 1
    entities = ctx.committed_actions[0]["entities"]
    assert {e["entity_id"] for e in entities} == {"m1", "m3"}
