"""request_refill — a refill REQUEST goes to the Ask-a-Doctor thread.

Item 3: the elder wanting a refill is distinct from recording a pill count
(log_refill). request_refill inserts a doctor_questions row and records a
committed action with entity_type="doctor_message" so the web client routes the
proof to the doctor thread (the caregiver sees it too), never the pill-count card.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A)
    )


def _db() -> FakeDB:
    return FakeDB({
        "medications": [{"id": "m1", "name": "Metformin", "dosage": "500mg", "archived": False}],
        "doctor_questions": [],
    })


async def test_request_refill_queues_a_doctor_question():
    tool = get_handler("request_refill")
    db = _db()
    ctx = _ctx(db)
    out = await tool(ctx, medication_name="metformin")
    assert "doctor" in out.lower()

    # A doctor_questions row was inserted for this elder, sourced from the agent.
    assert db.inserted and db.inserted[0][0] == "doctor_questions"
    row = db.inserted[0][1]
    assert row["elder_id"] == ELDER_A
    assert row["source"] == "agent"
    assert row["status"] == "open"
    # Canonical med name resolved from the lowercase input.
    assert "Metformin" in row["question"]
    assert row["context"] == {"kind": "refill", "medication": "Metformin"}


async def test_request_refill_routes_to_the_doctor_thread():
    tool = get_handler("request_refill")
    db = _db()
    ctx = _ctx(db)
    await tool(ctx, medication_name="Metformin")

    # Exactly one committed action, shaped so the web client highlights the
    # Ask-a-Doctor thread — NOT the pill-count / refill_request card.
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "request_refill"
    assert action["entity_type"] == "doctor_message"
    # No refills-table write happened.
    assert not db.updated
    assert all(t != "refills" for t, _ in db.inserted)


async def test_request_refill_works_even_if_med_not_on_file():
    tool = get_handler("request_refill")
    db = FakeDB({"medications": [], "doctor_questions": []})
    ctx = _ctx(db)
    out = await tool(ctx, medication_name="Ozempic")
    assert "Ozempic" in out or "doctor" in out.lower()
    assert db.inserted and db.inserted[0][0] == "doctor_questions"
    assert "Ozempic" in db.inserted[0][1]["question"]


async def test_request_refill_does_not_duplicate_an_open_request():
    tool = get_handler("request_refill")
    db = _db()
    ctx = _ctx(db)
    # First request queues one doctor_questions row.
    await tool(ctx, medication_name="metformin")
    assert sum(t == "doctor_questions" for t, _ in db.inserted) == 1

    # A second request for the same med (any casing) while the first is still
    # open must NOT insert a second row — the caregiver shouldn't see dupes.
    out = await tool(ctx, medication_name="Metformin")
    assert "already" in out.lower()
    assert sum(t == "doctor_questions" for t, _ in db.inserted) == 1
    # And no new committed action either (nothing changed).
    assert len(ctx.committed_actions) == 1
