"""start_walkthrough tool + the prompt block that offers undone walkthroughs."""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.agent.prompts import system_prompt_for
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext
from hermes.tools.walkthrough import TASK_NAMES

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx() -> ToolContext:
    supa = FakeSupabase(db=FakeDB({}))
    return ToolContext(supabase=supa, elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A))


async def test_start_walkthrough_queues_task_and_skips_committed_actions():
    tool = get_handler("start_walkthrough")
    ctx = _ctx()
    out = await tool(ctx, task_name="travel_mode_setup")
    assert ctx.walkthrough == {"task_name": "travel_mode_setup", "params": {}}
    assert ctx.committed_actions == []  # not a write — never a committed action
    assert "travel_mode_setup" in out


async def test_start_walkthrough_forwards_params_for_autonomous_task():
    tool = get_handler("start_walkthrough")
    ctx = _ctx()
    params = {"name": "Lisinopril", "dose": "10mg", "purpose": "Blood pressure"}
    await tool(ctx, task_name="add_prescription_auto", params=params)
    # VALUES (never selectors) pass through to the client, which injects them into
    # the walkthrough's fill/verify steps.
    assert ctx.walkthrough == {"task_name": "add_prescription_auto", "params": params}
    assert ctx.committed_actions == []


async def test_start_walkthrough_unknown_task_name_does_not_queue():
    tool = get_handler("start_walkthrough")
    ctx = _ctx()
    out = await tool(ctx, task_name="not_a_real_task")
    assert ctx.walkthrough is None
    assert "No walkthrough script" in out


def test_prompt_lists_undone_walkthroughs_and_omits_completed_ones():
    out = system_prompt_for(completed_walkthroughs=["onboarding"])
    assert "onboarding" not in _undone_line(out)
    for task in TASK_NAMES:
        if task != "onboarding":
            assert task in _undone_line(out)


def test_prompt_omits_the_whole_block_once_everything_is_done():
    out = system_prompt_for(completed_walkthroughs=list(TASK_NAMES))
    assert "Walkthroughs this patient has NOT been shown yet" not in out


def _undone_line(prompt: str) -> str:
    for line in prompt.splitlines():
        if "Walkthroughs this patient has NOT been shown yet" in line:
            return line
    raise AssertionError("undone-walkthroughs line not found in prompt")
