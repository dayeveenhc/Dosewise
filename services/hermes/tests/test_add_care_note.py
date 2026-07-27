"""add_care_note — the caregiver's own care log, via conversation_turns.

Chat identity IS the record owner (routes.py derives elder_id from the JWT sub;
no act-on-behalf-of exists), so the note lands in the CHATTING user's own
thread — the same insert shape message_caregiver uses, which 0002's RLS allows
via auth.uid() = elder_id. Immediate write.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from helpers import assert_row, reread_rows
from hermes.channels.session import SessionState
from hermes.tools.base import ToolContext, get_handler
from test_tools import CAREGIVER_C


def _caregiver_ctx(db: FakeDB) -> ToolContext:
    # In the caregiver chat, ctx.elder_id IS the caregiver's own profile id.
    return ToolContext(
        supabase=FakeSupabase(db=db),
        elder_id=CAREGIVER_C,
        session=SessionState(elder_id=CAREGIVER_C),
    )


async def test_note_lands_in_the_chatting_users_own_thread():
    db = FakeDB({"conversation_turns": []})
    ctx = _caregiver_ctx(db)
    out = await get_handler("add_care_note")(ctx, note="Mom seemed tired today.")
    assert "care log" in out.lower()

    # Independent re-read: the row exists, owned by the CAREGIVER's identity —
    # mirroring message_caregiver's insert shape (transcript column, system
    # speaker, tool tag).
    rows = await reread_rows(db, "conversation_turns", elder_id=CAREGIVER_C)
    row = assert_row(
        rows,
        speaker="system",
        tool="add_care_note",
        transcript="Mom seemed tired today.",
    )

    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "add_care_note"
    assert action["entity_type"] == "care_note"
    assert action["entity_id"] == str(row["id"])
    assert action["changed_fields"] == {
        "note": {"before": None, "after": "Mom seemed tired today."}
    }


async def test_empty_note_asks_and_writes_nothing():
    db = FakeDB({"conversation_turns": []})
    ctx = _caregiver_ctx(db)
    out = await get_handler("add_care_note")(ctx, note="   ")
    assert "Ask" in out
    assert not db.inserted and not ctx.committed_actions
    assert await reread_rows(db, "conversation_turns", elder_id=CAREGIVER_C) == []
