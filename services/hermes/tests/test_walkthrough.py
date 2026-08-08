"""start_walkthrough tool + the prompt block that offers undone walkthroughs."""

from __future__ import annotations

import re
from pathlib import Path

from fakes import FakeDB, FakeSupabase
from hermes.agent.prompts import system_prompt_for
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext
from hermes.tools.walkthrough import (
    AUTONOMOUS_TASKS,
    CAREGIVER_ONLY_TASKS,
    IRREVERSIBLE_AUTO_TASKS,
    RISK_ASSESSED_TASKS,
    TASK_NAMES,
    TRAVEL_TIMEZONES,
    tasks_for_role,
)

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
    assert ctx.walkthrough["task_name"] == "add_prescription_auto"
    assert ctx.walkthrough["params"] == params
    assert ctx.committed_actions == []
    # add_prescription_auto is risk-assessed (RISK_ASSESSED_TASKS) — this only
    # proves the "risk" key is wired through with the right shape. Whether
    # THIS instance flags (and why) is a RiskClassifier behaviour question,
    # not a wiring one — see test_risk_classifier.py, which owns every
    # flagged/not-flagged assertion as a named, findable test.
    risk = ctx.walkthrough["risk"]
    assert set(risk.keys()) == {"flagged", "signals", "reasons"}
    assert isinstance(risk["flagged"], bool)


async def test_start_walkthrough_unknown_task_name_does_not_queue():
    tool = get_handler("start_walkthrough")
    ctx = _ctx()
    out = await tool(ctx, task_name="not_a_real_task")
    assert ctx.walkthrough is None
    assert "No walkthrough script" in out


def test_prompt_lists_undone_walkthroughs_and_omits_completed_ones():
    out = system_prompt_for(completed_walkthroughs=["onboarding"])
    assert "onboarding" not in _undone_line(out)
    for task in tasks_for_role("elder"):
        if task != "onboarding":
            assert task in _undone_line(out)


def test_prompt_never_offers_a_walkthrough_from_the_other_app_shell():
    """The elder and caregiver apps render entirely different screens, so a
    walkthrough offered to the wrong one can only spotlight elements that do not
    exist there. The client refuses such a task outright
    (steps/index.ts::walkthroughShellFor); this stops the offer being made."""
    elder = _undone_line(system_prompt_for(app_role="elder"))
    caregiver = _undone_line(system_prompt_for(app_role="caregiver"))

    for task in CAREGIVER_ONLY_TASKS:
        assert task not in elder, f"{task} offered to an elder"
        assert task in caregiver
    for task in ("add_prescription_auto", "log_dose", "emergency_contact_tour"):
        assert task in elder
        assert task not in caregiver, f"{task} offered to a caregiver"

    # link_caregiver resolves to a different script per role — both may see it.
    assert "link_caregiver" in elder and "link_caregiver" in caregiver


def test_prompt_defaults_to_the_elder_shell_when_no_role_is_given():
    """Telegram never sends a role, and it is an elder channel."""
    assert _undone_line(system_prompt_for()) == _undone_line(system_prompt_for(app_role="elder"))


def test_tasks_for_role_partitions_every_task_name():
    elder, caregiver = set(tasks_for_role("elder")), set(tasks_for_role("caregiver"))
    assert elder | caregiver == set(TASK_NAMES), "a task belongs to neither shell"
    assert elder & caregiver == {"link_caregiver"}


def test_prompt_offers_only_the_autonomous_family_once_everything_is_done():
    """The one-time INTRODUCTIONS all disappear once shown — but the *_auto
    family never does: those aren't tutorials, they're how a write is carried
    out, so they must stay offerable for the patient's second medicine and their
    twentieth. Nothing else may survive into the undone list."""
    out = system_prompt_for(completed_walkthroughs=list(TASK_NAMES))
    line = _undone_line(out)
    elder_autonomous = AUTONOMOUS_TASKS & set(tasks_for_role("elder"))
    for task in elder_autonomous:
        assert task in line
    for task in set(tasks_for_role("elder")) - AUTONOMOUS_TASKS:
        assert task not in line


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


def test_travel_timezones_match_the_web_select_exactly():
    """The travel-mode <select> options carry no value attribute, so an option's
    value IS its label — a single wrong character doesn't miss, it BLANKS the
    field, and the blank persists as the saved travel plan. This tool's schema
    names the real options so the model doesn't have to guess; if the web list
    ever changes and this one doesn't, that guidance starts lying."""
    src = (
        Path(__file__).resolve().parents[3]
        / "apps/web/src/app/lib/constants.ts"
    ).read_text(encoding="utf-8")
    body = re.search(r"export const TIMEZONES = \[(.*?)\];", src, re.S)
    assert body, "TIMEZONES not found in apps/web/src/app/lib/constants.ts"
    web = re.findall(r'"([^"]+)"', body.group(1))
    assert web, "no timezone strings parsed"
    assert web == TRAVEL_TIMEZONES


async def test_start_walkthrough_coerces_non_string_params():
    """Models send `{"value": 64}` for a weight despite the schema saying string.
    The client's step builders are Record<string, string> and call .trim() on
    what arrives, so an un-coerced number reaches the browser as a TypeError
    mid-walkthrough. Normalize at this boundary, not in every step builder."""
    tool = get_handler("start_walkthrough")
    ctx = _ctx()
    await tool(ctx, task_name="edit_profile_auto", params={"value": 64})
    assert ctx.walkthrough["params"] == {"value": "64"}

    ctx2 = _ctx()
    await tool(ctx2, task_name="travel_mode_auto", params={"start_date": None, "days": 7})
    assert ctx2.walkthrough["params"] == {"start_date": "", "days": "7"}


def test_prompt_survives_a_completed_walkthrough_that_no_longer_exists():
    """`completed_walkthroughs` is STORED USER DATA forwarded verbatim by the
    client, not a list derived from TASK_NAMES — so it can name a walkthrough
    that has since been renamed or removed. Indexing _WALKTHROUGH_LABELS
    directly would KeyError on EVERY turn for that patient: a 500 on every
    message they send. Renaming a task must never be able to do that."""
    out = system_prompt_for(completed_walkthroughs=["a_task_we_deleted", "log_dose"])
    assert "a_task_we_deleted" not in out
    assert "log_dose" in out


def test_prompt_omits_the_already_shown_block_when_only_stale_names_remain():
    """Otherwise a profile whose completed list is entirely stale emits a
    dangling 'ALREADY been shown: .' line with nothing after the colon."""
    out = system_prompt_for(completed_walkthroughs=["a_task_we_deleted"])
    assert "ALREADY been shown" not in out


def test_autonomous_tasks_are_a_subset_of_task_names():
    """AUTONOMOUS_TASKS drives what the prompt refuses to treat as 'already
    shown'. A typo there would silently re-break the re-run path."""
    assert AUTONOMOUS_TASKS <= set(TASK_NAMES)
    assert AUTONOMOUS_TASKS and all(t.endswith(("_auto", "_link")) for t in AUTONOMOUS_TASKS)


def test_completed_autonomous_walkthrough_stays_offerable():
    """THE regression this exists for. An *_auto walkthrough is not a one-time
    introduction — it is HOW the write is performed (Mei fills the real form, the
    patient taps Save). Once add_prescription_auto landed in
    profiles.accessibility.completedWalkthroughs, the old prompt told Mei never to
    guide them through it again, so adding a SECOND medicine silently became a
    direct write with no walkthrough at all."""
    out = system_prompt_for(completed_walkthroughs=["add_prescription_auto"])
    assert "add_prescription_auto" in out
    assert "NOT been shown yet" in out
    # …and it must not also be listed as done, or the model gets both signals.
    already = out.split("ALREADY been shown")[1] if "ALREADY been shown" in out else ""
    assert "add_prescription_auto" not in already


def test_already_shown_block_limits_offering_not_doing():
    """The anti-nagging rail must not read as 'never start this again'."""
    out = system_prompt_for(completed_walkthroughs=["log_dose"])
    block = out.split("ALREADY been shown")[1]
    assert "VOLUNTEER" in block
    assert "ask outright" in block


async def test_start_walkthrough_refuses_a_wrong_shell_task():
    """An elder's model can still NAME a caregiver-only task (the tool's enum is
    the flat TASK_NAMES). It used to queue fine and the client declined to
    console.warn, so Mei promised a walkthrough that never appeared."""
    tool = get_handler("start_walkthrough")
    ctx = _ctx()  # defaults to app_role="elder"
    out = await tool(ctx, task_name="weekly_summary_tour")
    assert ctx.walkthrough is None
    assert "NOT started" in out
    assert "caregiver app" in out


async def test_start_walkthrough_allows_a_caregiver_task_in_the_caregiver_shell():
    tool = get_handler("start_walkthrough")
    supa = FakeSupabase(db=FakeDB({}))
    ctx = ToolContext(
        supabase=supa,
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
        app_role="caregiver",
    )
    await tool(ctx, task_name="weekly_summary_tour")
    assert ctx.walkthrough == {"task_name": "weekly_summary_tour", "params": {}}


async def test_start_walkthrough_refuses_an_elder_task_in_the_caregiver_shell():
    tool = get_handler("start_walkthrough")
    supa = FakeSupabase(db=FakeDB({}))
    ctx = ToolContext(
        supabase=supa,
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
        app_role="caregiver",
    )
    out = await tool(ctx, task_name="log_dose")
    assert ctx.walkthrough is None
    assert "patient app" in out


def test_risk_assessed_tasks_is_autonomous_minus_the_consent_flow():
    """RISK_ASSESSED_TASKS must never drift from AUTONOMOUS_TASKS by anything
    other than the one deliberate exclusion (accept_caregiver_link is already
    always-human-tap end to end, so RiskClassifier has nothing to gate there)."""
    assert RISK_ASSESSED_TASKS == AUTONOMOUS_TASKS - {"accept_caregiver_link"}
    assert "accept_caregiver_link" not in RISK_ASSESSED_TASKS


def test_irreversible_auto_tasks_parity():
    """IRREVERSIBLE_AUTO_TASKS is a new source-of-truth table (cross-cutting
    decision A). No TS-side mirror exists yet (Phase B builds one later), so
    this only proves the raw-text-extraction pattern the eventual two-sided
    test will use resolves the SAME set the import exposes — following
    TASK_NAMES/AUTONOMOUS_TASKS/TRAVEL_TIMEZONES's established convention
    above, just one-sided until a TS table exists to compare against."""
    repo = Path(__file__).resolve().parents[3]
    tools_py = (
        repo / "services" / "hermes" / "src" / "hermes" / "tools" / "walkthrough.py"
    ).read_text(encoding="utf-8")
    # Annotation is optional in the regex on purpose: a future edit dropping
    # the ": frozenset[str]" type hint (e.g. to match the unannotated sibling
    # tables AUTONOMOUS_TASKS/CAREGIVER_ONLY_TASKS just above it) must not
    # make this test claim the table is MISSING when it's only unannotated.
    m = re.search(
        r"IRREVERSIBLE_AUTO_TASKS(?:\s*:\s*frozenset\[str\])?\s*=\s*frozenset\((.*?)\)",
        tools_py,
        re.S,
    )
    assert m, "IRREVERSIBLE_AUTO_TASKS not found in tools/walkthrough.py"
    extracted = set(re.findall(r'"([a-z0-9_]+)"', m.group(1)))
    assert extracted == set(IRREVERSIBLE_AUTO_TASKS)
    assert IRREVERSIBLE_AUTO_TASKS <= set(TASK_NAMES)


def test_autonomous_tasks_match_the_web_client():
    """Both sides carry the list — Hermes decides (it subtracts these from the
    forwarded completed_walkthroughs), the client uses it to avoid recording
    meaningless entries. Drift means one of them silently reverts the fix."""
    src = Path(__file__).resolve().parents[3] / "apps/web/src/app/lib/walkthrough/types.ts"
    body = src.read_text(encoding="utf-8").split("AUTONOMOUS_TASKS", 1)[1].split("]", 1)[0]
    web = set(re.findall(r'"([a-z_]+)"', body))
    assert web == set(AUTONOMOUS_TASKS), f"web={sorted(web)} hermes={sorted(AUTONOMOUS_TASKS)}"


def test_prompt_states_todays_date():
    """Without it the model dates relative phrases from its training data: asked
    for Travel Mode "next Monday" it returned 2023-10-30 and the walkthrough
    saved a plan three years in the past. Found by a live drive, not a unit test
    — nothing here can catch a wrong DATE, only a missing one."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    out = system_prompt_for()
    today = datetime.now(ZoneInfo("Asia/Singapore"))
    assert f"({today:%Y-%m-%d})" in out
    assert "Today is" in out
