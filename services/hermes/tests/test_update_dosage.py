"""update_medication_dosage — offline propose→confirm tests via FakeDB doubles.

Scenario 6: "the doctor changed my metformin to 1000mg" edits an EXISTING med's
dosage. Proves the propose stashes without writing, the confirm mutates
medications.dosage and emits a committed action shaped for the elder
Prescriptions card (entity_type="medication", a lone before→after dosage change),
and that a confirm with no matching proposal is refused.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB, **kw) -> ToolContext:
    supa = FakeSupabase(db=db)
    return ToolContext(
        supabase=supa, elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A), **kw
    )


def _db() -> FakeDB:
    return FakeDB({"medications": [
        {"id": "m1", "name": "Metformin", "dosage": "500mg", "archived": False},
    ]})


async def test_update_dosage_proposes_without_write():
    tool = get_handler("update_medication_dosage")
    db = _db()
    ctx = _ctx(db)
    out = await tool(ctx, medication_name="Metformin", dosage="1000mg", confirmed=False)
    assert "PROPOSED" in out and "500mg" in out and "1000mg" in out
    assert not db.updated  # nothing written on a proposal
    assert ctx.session.pending_dosage == {"name": "Metformin", "dosage": "1000mg"}
    assert ctx.session.awaiting_confirmation is True
    # The med row is untouched — an independent re-read still shows the old dose.
    still = await db.select("medications", filters={"id": "eq.m1"})
    assert still[0]["dosage"] == "500mg"


async def test_update_dosage_confirm_writes_and_records_change():
    tool = get_handler("update_medication_dosage")
    db = _db()
    ctx = _ctx(db)
    await tool(ctx, medication_name="Metformin", dosage="1000mg", confirmed=False)
    out = await tool(ctx, medication_name="Metformin", dosage="1000mg", confirmed=True)
    assert "Saved" in out

    # The write hit medications.dosage for the right row.
    assert db.updated and db.updated[0][0] == "medications"
    patch, filters = db.updated[0][1], db.updated[0][2]
    assert patch == {"dosage": "1000mg"}
    assert filters == {"id": "eq.m1"}

    # Independent re-read reflects before→after.
    after = await db.select("medications", filters={"id": "eq.m1"})
    assert after[0]["dosage"] == "1000mg"

    # Pending slot + confirmation flag cleared.
    assert ctx.session.pending_dosage is None
    assert ctx.session.awaiting_confirmation is False

    # Exactly one committed action, shaped for the elder Prescriptions card. A lone
    # dosage change with before != None reads as an UPDATE (not an add).
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "update_medication_dosage"
    assert action["entity_type"] == "medication"
    assert action["entity_id"] == "m1"
    assert action["changed_fields"] == {
        "dosage": {"before": "500mg", "after": "1000mg"}
    }


async def test_update_dosage_confirm_without_proposal_refused():
    tool = get_handler("update_medication_dosage")
    db = _db()
    ctx = _ctx(db)
    out = await tool(ctx, medication_name="Metformin", dosage="1000mg", confirmed=True)
    assert "Refused" in out
    assert not db.updated  # no write
    assert not ctx.committed_actions
    # Med row unchanged.
    row = await db.select("medications", filters={"id": "eq.m1"})
    assert row[0]["dosage"] == "500mg"


async def test_update_dosage_unknown_medication_does_not_propose():
    tool = get_handler("update_medication_dosage")
    db = FakeDB({"medications": []})
    ctx = _ctx(db)
    out = await tool(ctx, medication_name="Nope", dosage="1000mg", confirmed=False)
    assert "No medication named" in out
    assert not db.updated
    assert ctx.session.pending_dosage is None
    assert ctx.session.awaiting_confirmation is False
