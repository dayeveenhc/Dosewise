"""start_walkthrough tool + the prompt block that offers undone walkthroughs."""

from __future__ import annotations

import re
from pathlib import Path

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


def test_task_names_parity():
    """All four owners of the walkthrough task-name vocabulary must agree:
    (1) tools/walkthrough.py TASK_NAMES, (2) agent/prompts.py
    _WALKTHROUGH_LABELS keys, (3) the web WalkthroughTaskName union
    (types.ts), (4) the web step-resolver mapping (steps/index.ts). STRICT by
    design — a name added on one side only must fail here with the exact set
    difference."""
    repo = Path(__file__).resolve().parents[3]
    hermes_src = repo / "services" / "hermes" / "src" / "hermes"
    web_walk = repo / "apps" / "web" / "src" / "app" / "lib" / "walkthrough"

    tools_py = (hermes_src / "tools" / "walkthrough.py").read_text(encoding="utf-8")
    m = re.search(r"TASK_NAMES\s*=\s*\[(.*?)\]", tools_py, re.S)
    assert m, "TASK_NAMES list not found in tools/walkthrough.py"
    tool_names = set(re.findall(r'"([a-z0-9_]+)"', m.group(1)))
    # Sanity: the regex read the same list the import exposes.
    assert tool_names == set(TASK_NAMES)

    prompts_py = (hermes_src / "agent" / "prompts.py").read_text(encoding="utf-8")
    m = re.search(r"_WALKTHROUGH_LABELS\s*=\s*\{(.*?)\n\}", prompts_py, re.S)
    assert m, "_WALKTHROUGH_LABELS dict not found in agent/prompts.py"
    label_keys = set(re.findall(r'"([a-z0-9_]+)"\s*:', m.group(1)))

    types_ts = (web_walk / "types.ts").read_text(encoding="utf-8")
    m = re.search(r"WalkthroughTaskName\s*=(.*?);", types_ts, re.S)
    assert m, "WalkthroughTaskName union not found in types.ts"
    union_body = re.sub(r"//[^\n]*", "", m.group(1))  # strip line comments
    ts_union = set(re.findall(r'"([a-z0-9_]+)"', union_body))

    steps_ts = (web_walk / "steps" / "index.ts").read_text(encoding="utf-8")
    ts_mapping = set(re.findall(r'case\s+"([a-z0-9_]+)"', steps_ts))
    # link_caregiver is resolved via an if-check, not a case.
    ts_mapping |= set(re.findall(r'taskName\s*===\s*"([a-z0-9_]+)"', steps_ts))

    base = set(TASK_NAMES)
    others = {
        "agent/prompts.py _WALKTHROUGH_LABELS keys": label_keys,
        "apps/web types.ts WalkthroughTaskName union": ts_union,
        "apps/web steps/index.ts mapping keys": ts_mapping,
    }
    problems = [
        f"- {label}: missing={sorted(base - got)} extra={sorted(got - base)}"
        for label, got in others.items()
        if got != base
    ]
    assert not problems, (
        "walkthrough task names out of sync with tools/walkthrough.py "
        f"TASK_NAMES ({len(base)} names):\n" + "\n".join(problems)
    )
