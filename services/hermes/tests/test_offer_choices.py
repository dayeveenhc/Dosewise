"""offer_choices — attaches tappable option buttons to the reply (Item 6).

Not a write: it only sets ctx.choices (a client-side UI hint the web app renders
as buttons and the response surfaces as `choices`). Mirrors start_walkthrough.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext
from hermes.tools.choices import _SCHEMA

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


# --- What the model reads at tool-selection time ----------------------------
def test_schema_description_covers_the_conversational_yes_no():
    """The gap this tool kept missing. The description used to read as a
    PRE-SAVE affordance ("especially before saving anything"), so a purely
    conversational "Shall I look that up for you?" carried neither `choices` nor
    `awaiting_confirmation` and the web client had nothing to render — typing was
    the only way to answer. This is where the model decides, so it has to say so."""
    desc = _SCHEMA["description"].lower()
    assert "conversational" in desc
    # Named, so the case cannot be read as hypothetical.
    assert "shall i look that up for you?" in desc
    assert "not only" in desc  # ...a confirm before you save


def test_schema_description_names_no_symbol():
    """Mei cannot see how the answer control is drawn — it differs by channel and
    device (the web app has no tick at all; its buttons read "Yes, please" /
    "No, not now"). A description that names one teaches her to write "tap ✅"
    into replies where nothing of the sort appears."""
    desc = _SCHEMA["description"]
    assert "✅" not in desc
    assert "✖" not in desc
    assert "never describe" in desc.lower()
