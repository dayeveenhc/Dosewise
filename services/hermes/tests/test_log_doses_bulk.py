"""log_doses — the EXPLICIT-LIST bulk propose→confirm ("I took my metformin and
my lisinopril"), distinct from resolve_missed_doses' server-computed "all".

Proves: the propose resolves each name through the shared _dose_plan engine
(multi-slot ambiguity → earliest slot, SHOWN in the read-back), stashes
pending_bulk and writes nothing; unknown names are excluded but reported; the
confirm is guarded by match_pending_bulk (tool-scoped), re-resolves fresh
(race-safe), commits via _commit_dose, and replaces the per-item actions with
ONE bulk committed action; partial failures are reported honestly.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

import pytest

from fakes import FakeDB
from helpers import assert_row, pin_clock, reread_rows
from hermes.tools.base import get_handler
from test_tools import ELDER_A, _ctx

TZ = "Asia/Singapore"
# 14:20 SGT (06:20 UTC) on 2026-07-26 — 08:00/09:00 are past due, 20:00 upcoming.
_NOW = datetime(2026, 7, 26, 6, 20, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    pin_clock(monkeypatch, _NOW, tz=TZ)


def _slot_utc_iso(hhmm: str) -> str:
    hh, mm = hhmm.split(":")
    local = datetime.combine(
        date(2026, 7, 26), time(int(hh), int(mm)), tzinfo=ZoneInfo(TZ)
    )
    return local.astimezone(UTC).isoformat()


def _db() -> FakeDB:
    return FakeDB({
        "medications": [
            {"id": "m1", "name": "Metformin", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Lisinopril", "archived": False,
             "schedule": {"times": ["09:00"], "frequency": "daily"}},
            {"id": "m3", "name": "Aspirin", "archived": False,
             "schedule": {"times": ["08:00", "20:00"], "frequency": "daily"}},
        ],
        "doses": [],
    })


async def test_propose_stashes_pending_bulk_and_writes_nothing():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("log_doses")(
        ctx, medication_names=["Metformin", "Lisinopril"]
    )
    assert "PROPOSED" in out
    assert "Metformin (8:00 AM)" in out and "Lisinopril (9:00 AM)" in out
    assert "yes/no" in out
    assert not db.inserted and not db.updated and not ctx.committed_actions
    pending = ctx.session.pending_bulk
    assert pending["tool"] == "log_doses"
    assert [(i["medication_id"], i["name"], i["kind"], i["payload"])
            for i in pending["items"]] == [
        ("m1", "Metformin", "backdate", "08:00"),
        ("m2", "Lisinopril", "backdate", "09:00"),
    ]
    assert ctx.session.awaiting_confirmation is True
    # Independent re-read: still no dose rows.
    assert await reread_rows(db, "doses", elder_id=ELDER_A) == []


async def test_propose_multi_slot_med_resolves_to_earliest_and_shows_it():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("log_doses")(ctx, medication_names=["Aspirin"])
    # Aspirin's 08:00/20:00 would be an "ask" for log_dose; the bulk flow picks
    # the EARLIEST due slot and SHOWS it, so the user's yes covers that slot.
    assert "Aspirin (8:00 AM)" in out
    item = ctx.session.pending_bulk["items"][0]
    assert (item["kind"], item["payload"]) == ("backdate", "08:00")


async def test_propose_unknown_names_listed_and_excluded():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("log_doses")(
        ctx, medication_names=["Metformin", "Nope"]
    )
    assert "Not on file: Nope" in out
    assert [i["name"] for i in ctx.session.pending_bulk["items"]] == ["Metformin"]


async def test_propose_nothing_resolvable_stashes_nothing():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("log_doses")(ctx, medication_names=["Nope", "Nada"])
    assert "Not on file" in out and "PROPOSED" not in out
    assert ctx.session.pending_bulk is None
    assert ctx.session.awaiting_confirmation is False


async def test_confirm_without_proposal_refused():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("log_doses")(
        ctx, medication_names=["Metformin"], confirmed=True
    )
    assert "Refused" in out
    assert not db.inserted and not ctx.committed_actions


async def test_confirm_with_other_tools_pending_bulk_refused():
    db = _db()
    ctx = _ctx(db)
    # A DIFFERENT tool's bulk stash must not be committable by log_doses.
    ctx.session.pending_bulk = {
        "tool": "discontinue_medication",
        "items": [{"medication_id": "m1", "name": "Metformin"}],
    }
    out = await get_handler("log_doses")(
        ctx, medication_names=["Metformin"], confirmed=True
    )
    assert "Refused" in out
    assert not db.inserted and not ctx.committed_actions
    # The other tool's stash is left in place for ITS confirm.
    assert ctx.session.pending_bulk["tool"] == "discontinue_medication"


async def test_confirm_commits_all_with_one_bulk_action():
    db = _db()
    ctx = _ctx(db)
    tool = get_handler("log_doses")
    await tool(ctx, medication_names=["Metformin", "Lisinopril"])
    out = await tool(ctx, medication_names=["Metformin", "Lisinopril"], confirmed=True)
    assert "Marked 2 doses as taken" in out

    # Independent re-read: one taken row per med, back-dated to its slot.
    m1 = assert_row(await reread_rows(db, "doses", medication_id="m1"),
                    status="taken", scheduled_at=_slot_utc_iso("08:00"))
    m2 = assert_row(await reread_rows(db, "doses", medication_id="m2"),
                    status="taken", scheduled_at=_slot_utc_iso("09:00"))
    assert m1["logged_by"] == ELDER_A and m2["logged_by"] == ELDER_A

    # The frontend must see ONE action: the per-item log_dose actions that
    # _commit_dose appended were replaced by a single bulk entry.
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "log_doses"
    assert action["summary"] == "2 doses marked taken"
    assert [(e["entity_id"], e["slot"], e["name"]) for e in action["entities"]] == [
        ("m1", "08:00", "Metformin"), ("m2", "09:00", "Lisinopril"),
    ]
    for entity in action["entities"]:
        assert entity["entity_type"] == "dose"
        assert entity["changed_fields"] == {
            "status": {"before": None, "after": "taken"}
        }
        assert entity["dose_id"]
    assert action["dose_ids"] == [e["dose_id"] for e in action["entities"]]
    assert ctx.session.pending_bulk is None
    assert ctx.session.awaiting_confirmation is False


async def test_confirm_flips_pending_row_and_bulk_entity_reflects_it():
    db = _db()
    db.tables["doses"].append(
        {"id": "d-am", "medication_id": "m1", "elder_id": ELDER_A,
         "scheduled_at": _slot_utc_iso("08:00"), "status": "pending"}
    )
    ctx = _ctx(db)
    tool = get_handler("log_doses")
    await tool(ctx, medication_names=["Metformin"])
    await tool(ctx, medication_names=["Metformin"], confirmed=True)
    assert_row(await reread_rows(db, "doses", id="d-am"), status="taken")
    entity = ctx.committed_actions[0]["entities"][0]
    assert entity["dose_id"] == "d-am"
    assert entity["changed_fields"]["status"] == {
        "before": "pending", "after": "taken"
    }


async def test_confirm_reresolves_and_skips_dose_taken_since_propose():
    db = _db()
    ctx = _ctx(db)
    tool = get_handler("log_doses")
    await tool(ctx, medication_names=["Metformin", "Lisinopril"])
    # Race: Metformin gets logged (e.g. Home-screen tap) between propose/confirm.
    db.tables["doses"].append(
        {"id": "d-race", "medication_id": "m1", "elder_id": ELDER_A,
         "scheduled_at": _slot_utc_iso("08:00"), "status": "taken",
         "logged_at": _NOW.isoformat()}
    )
    out = await tool(
        ctx, medication_names=["Metformin", "Lisinopril"], confirmed=True
    )
    assert "Marked 1 dose as taken" in out and "Lisinopril" in out
    assert "Already logged" in out and "Metformin" in out
    # No double-write for m1: still exactly the race row.
    assert [r["id"] for r in await reread_rows(db, "doses", medication_id="m1")] \
        == ["d-race"]
    assert len(ctx.committed_actions) == 1
    assert [e["entity_id"] for e in ctx.committed_actions[0]["entities"]] == ["m2"]


class _FlakyInsertDB(FakeDB):
    """FakeDB whose doses insert fails for one medication_id."""

    def __init__(self, tables, fail_for: str):
        super().__init__(tables)
        self._fail_for = fail_for

    async def insert(self, table, row, returning=True):
        if table == "doses" and row.get("medication_id") == self._fail_for:
            raise RuntimeError("insert failed")
        return await super().insert(table, row, returning=returning)


async def test_confirm_partial_failure_reported_honestly():
    db = _FlakyInsertDB(_db().tables, fail_for="m2")
    ctx = _ctx(db)
    tool = get_handler("log_doses")
    await tool(ctx, medication_names=["Metformin", "Lisinopril"])
    out = await tool(
        ctx, medication_names=["Metformin", "Lisinopril"], confirmed=True
    )
    assert "Marked 1 dose as taken" in out
    assert "Could not save" in out and "Lisinopril" in out
    assert len(ctx.committed_actions) == 1
    assert [e["entity_id"] for e in ctx.committed_actions[0]["entities"]] == ["m1"]
    # The failed med really has no row.
    assert await reread_rows(db, "doses", medication_id="m2") == []
