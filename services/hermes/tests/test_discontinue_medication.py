"""discontinue_medication — propose→confirm archive (Stopped), NEVER a delete.

Uses the generic pending_bulk slot ({"tool": "discontinue_medication",
"items": [{medication_id, name}]}); the confirm re-reads the med fresh by id,
flips archived=true, and emits a status active→discontinued committed action.
"""

from __future__ import annotations

from fakes import FakeDB
from helpers import assert_row, reread_rows
from hermes.tools.base import get_handler
from test_tools import _ctx


def _db() -> FakeDB:
    return FakeDB({"medications": [
        {"id": "m1", "name": "Metformin", "dosage": "500mg", "archived": False},
    ]})


async def test_propose_stashes_and_writes_nothing():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("discontinue_medication")(
        ctx, medication_name="Metformin"
    )
    assert "PROPOSED" in out
    assert "Metformin 500mg" in out and "Stopped" in out and "never deleted" in out
    assert ctx.session.pending_bulk == {
        "tool": "discontinue_medication",
        "items": [{"medication_id": "m1", "name": "Metformin"}],
    }
    assert ctx.session.awaiting_confirmation is True
    assert not db.updated and not ctx.committed_actions
    # Independent re-read: still active.
    assert_row(await reread_rows(db, "medications", id="m1"), archived=False)


async def test_confirm_archives_never_deletes():
    db = _db()
    ctx = _ctx(db)
    tool = get_handler("discontinue_medication")
    await tool(ctx, medication_name="Metformin")
    out = await tool(ctx, medication_name="Metformin", confirmed=True)
    assert "Stopped" in out

    # Independent re-read: the ROW STILL EXISTS, now archived.
    rows = await reread_rows(db, "medications", id="m1")
    assert_row(rows, name="Metformin", archived=True)
    assert len(db.tables["medications"]) == 1  # nothing was deleted

    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "discontinue_medication"
    assert action["entity_type"] == "medication"
    assert action["entity_id"] == "m1"
    assert action["name"] == "Metformin"
    assert action["changed_fields"] == {
        "status": {"before": "active", "after": "discontinued"}
    }
    assert ctx.session.pending_bulk is None
    assert ctx.session.awaiting_confirmation is False


async def test_confirm_without_proposal_refused():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("discontinue_medication")(
        ctx, medication_name="Metformin", confirmed=True
    )
    assert "Refused" in out
    assert not db.updated and not ctx.committed_actions
    assert_row(await reread_rows(db, "medications", id="m1"), archived=False)


async def test_confirm_for_different_name_than_proposed_refused():
    db = FakeDB({"medications": [
        {"id": "m1", "name": "Metformin", "dosage": "500mg", "archived": False},
        {"id": "m2", "name": "Aspirin", "dosage": "100mg", "archived": False},
    ]})
    ctx = _ctx(db)
    tool = get_handler("discontinue_medication")
    await tool(ctx, medication_name="Metformin")
    # The model skips a propose and confirms a DIFFERENT med: refuse — the
    # stash covers only what was read back.
    out = await tool(ctx, medication_name="Aspirin", confirmed=True)
    assert "Refused" in out
    for med_id in ("m1", "m2"):
        assert_row(await reread_rows(db, "medications", id=med_id), archived=False)


async def test_unknown_name_is_honest_miss():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("discontinue_medication")(ctx, medication_name="Nope")
    assert "No medication named" in out
    assert ctx.session.pending_bulk is None
    assert not db.updated


async def test_ambiguous_name_asks_and_stashes_nothing():
    db = FakeDB({"medications": [
        {"id": "m1", "name": "Vitamin D", "archived": False},
        {"id": "m2", "name": "Vitamin B12", "archived": False},
    ]})
    ctx = _ctx(db)
    out = await get_handler("discontinue_medication")(ctx, medication_name="vitamin")
    assert "More than one medication matches" in out
    assert ctx.session.pending_bulk is None
    assert not db.updated


async def test_confirm_when_already_archived_is_honest():
    db = _db()
    ctx = _ctx(db)
    tool = get_handler("discontinue_medication")
    await tool(ctx, medication_name="Metformin")
    db.tables["medications"][0]["archived"] = True  # raced: archived elsewhere
    out = await tool(ctx, medication_name="Metformin", confirmed=True)
    assert "nothing to stop" in out.lower()
    assert not db.updated and not ctx.committed_actions
