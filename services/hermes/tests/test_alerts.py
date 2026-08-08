"""raise_alert — the agent-initiated urgent popup signal.

See tools/alerts.py's module docstring for why this is a tool with a meaningful
return rather than a bare side effect.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx() -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=FakeDB({})),
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


async def test_raise_alert_sets_the_context_slot():
    ctx = _ctx()
    out = await get_handler("raise_alert")(
        ctx, severity="critical", title="You have run out of Metformin",
        body="Ask for a refill today.", medication_name="Metformin",
    )
    assert ctx.alert == {
        "severity": "critical",
        "title": "You have run out of Metformin",
        "body": "Ask for a refill today.",
        "medication_name": "Metformin",
    }
    # The return has to be worth reading, or the model skips the call entirely
    # (MEMORY.md 2026-08-07: offer_choices measured 0/6 as a pure side effect).
    assert "raised" in out.lower()


async def test_raise_alert_is_not_a_write():
    ctx = _ctx()
    await get_handler("raise_alert")(ctx, severity="urgent", title="t", body="b")
    # A UI signal, not a change to any record — same rule as walkthrough/choices.
    assert ctx.committed_actions == []


async def test_raise_alert_keeps_the_more_serious_of_two():
    ctx = _ctx()
    await get_handler("raise_alert")(ctx, severity="critical", title="first", body="b")
    out = await get_handler("raise_alert")(ctx, severity="urgent", title="second", body="b")

    # At most one interruption per turn, and it is the worse one.
    assert ctx.alert is not None and ctx.alert["title"] == "first"
    assert "NOT raised" in out
    # The verdict must tell the model what to do instead — this is the branch
    # that makes the tool worth calling at all.
    assert "reply" in out.lower()


async def test_a_critical_alert_supersedes_an_urgent_one_already_raised():
    ctx = _ctx()
    await get_handler("raise_alert")(ctx, severity="urgent", title="first", body="b")
    await get_handler("raise_alert")(ctx, severity="critical", title="second", body="b")
    assert ctx.alert is not None and ctx.alert["title"] == "second"


async def test_an_unknown_severity_degrades_to_urgent_rather_than_crashing():
    ctx = _ctx()
    await get_handler("raise_alert")(ctx, severity="apocalyptic", title="t", body="b")
    assert ctx.alert is not None and ctx.alert["severity"] == "urgent"
