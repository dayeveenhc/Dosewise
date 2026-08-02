"""offer_choices — attaches tappable option buttons to the reply (Item 6).

Not a write: it only sets ctx.choices (a client-side UI hint the web app renders
as buttons and the response surfaces as `choices`). Mirrors start_walkthrough.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx() -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=FakeDB()),
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


async def test_offer_choices_records_label_value_pairs():
    tool = get_handler("offer_choices")
    ctx = _ctx()
    out = await tool(ctx, options=["Yes, save it", "No, not now"])
    assert ctx.choices == [
        {"label": "Yes, save it", "value": "Yes, save it"},
        {"label": "No, not now", "value": "No, not now"},
    ]
    assert "options" in out.lower()
    # Not a write — nothing committed.
    assert ctx.committed_actions == []


async def test_offer_choices_trims_dedups_and_caps_at_four():
    tool = get_handler("offer_choices")
    ctx = _ctx()
    await tool(ctx, options=["  A  ", "a", "B", "C", "D", "E"])
    labels = [c["label"] for c in ctx.choices]
    # "a" is a case-insensitive dup of "A"; capped at 4.
    assert labels == ["A", "B", "C", "D"]


async def test_offer_choices_needs_at_least_two_distinct_options():
    tool = get_handler("offer_choices")
    ctx = _ctx()
    out = await tool(ctx, options=["Yes", "yes", "   "])
    assert ctx.choices is None
    assert "at least 2" in out
