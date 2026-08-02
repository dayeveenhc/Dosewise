"""actions[] must follow the model's tool-call order, not gather completion order.

When one model iteration commits ≥2 writes, the handlers append to
ctx.committed_actions in asyncio.gather COMPLETION order — nondeterministic.
_stabilize_actions pins the slice back to call order in all three provider
loops. The fake handlers make the SECOND-scheduled tool complete FIRST (the
first sleeps), so without the fix the order is provably reversed.
"""

from __future__ import annotations

import asyncio

from fakes import (
    FakeAnthropic,
    FakeDB,
    FakeGemini,
    FakeOpenAI,
    FakeSupabase,
    gemini_function_call,
    gemini_response,
    gemini_text_part,
    openai_message,
    openai_response,
    openai_tool_call,
    response,
    text_block,
    tool_use_block,
    use_anthropic,
)
from hermes.agent import loop as loop_mod
from hermes.agent.loop import _stabilize_actions, run_agent_turn
from hermes.channels.session import SessionState
from hermes.config import get_settings
from hermes.tools.base import ToolContext, record_action

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


def _db() -> FakeDB:
    return FakeDB({"profiles": [{"id": ELDER_A, "dialect": "en"}],
                   "conversation_turns": []})


def _fake_write_tools(monkeypatch):
    """Two write tools; slow_first is CALLED first but COMPLETES second."""
    async def slow_first(ctx, **_):
        await asyncio.sleep(0.05)
        record_action(ctx, tool="slow_first", summary="a",
                      entity_type="x", entity_id="1")
        return "ok"

    async def fast_second(ctx, **_):
        record_action(ctx, tool="fast_second", summary="b",
                      entity_type="x", entity_id="2")
        return "ok"

    handlers = {"slow_first": slow_first, "fast_second": fast_second}
    # Patch the loop module's imported get_handler so the fake tools resolve
    # without touching the real registry (test_all_tools_registered stays exact).
    monkeypatch.setattr(loop_mod, "get_handler", lambda name: handlers.get(name))


async def test_completion_order_really_is_reversed_without_the_fix(monkeypatch):
    """Control: prove the nondeterminism the fix targets — the second-scheduled
    handler appends first under gather, so an unsorted slice IS reversed."""
    _fake_write_tools(monkeypatch)
    ctx = _ctx(_db())
    await asyncio.gather(
        loop_mod._dispatch_tool(ctx, "slow_first", {}),
        loop_mod._dispatch_tool(ctx, "fast_second", {}),
    )
    assert [a["tool"] for a in ctx.committed_actions] == [
        "fast_second", "slow_first",
    ]
    # ...and _stabilize_actions restores call order.
    _stabilize_actions(ctx, 0, ["slow_first", "fast_second"])
    assert [a["tool"] for a in ctx.committed_actions] == [
        "slow_first", "fast_second",
    ]


async def test_anthropic_loop_actions_follow_call_order(monkeypatch):
    use_anthropic(monkeypatch)
    _fake_write_tools(monkeypatch)
    client = FakeAnthropic([
        response("tool_use", [tool_use_block("slow_first", {}, "tu_1"),
                              tool_use_block("fast_second", {}, "tu_2")]),
        response("end_turn", [text_block("done")]),
    ])
    ctx = _ctx(_db())
    await run_agent_turn(client, ctx, "do both")
    assert [a["tool"] for a in ctx.committed_actions] == [
        "slow_first", "fast_second",
    ]


async def test_openai_loop_actions_follow_call_order(monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_provider", "openai", raising=False)
    monkeypatch.setattr(get_settings(), "openai_model", "gpt-4o", raising=False)
    monkeypatch.setattr(get_settings(), "openai_api_key", "test-key", raising=False)
    _fake_write_tools(monkeypatch)
    client = FakeOpenAI([
        openai_response(openai_message(tool_calls=[
            openai_tool_call("slow_first", {}, "c1"),
            openai_tool_call("fast_second", {}, "c2"),
        ])),
        openai_response(openai_message(content="done")),
    ])
    ctx = _ctx(_db())
    await run_agent_turn(client, ctx, "do both")
    assert [a["tool"] for a in ctx.committed_actions] == [
        "slow_first", "fast_second",
    ]


async def test_gemini_loop_actions_follow_call_order(monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_provider", "gemini", raising=False)
    monkeypatch.setattr(
        get_settings(), "gemini_model", "gemini-2.5-flash", raising=False
    )
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key", raising=False)
    _fake_write_tools(monkeypatch)
    client = FakeGemini([
        gemini_response([gemini_function_call("slow_first", {}),
                         gemini_function_call("fast_second", {})]),
        gemini_response([gemini_text_part("done")]),
    ])
    ctx = _ctx(_db())
    await run_agent_turn(client, ctx, "do both")
    assert [a["tool"] for a in ctx.committed_actions] == [
        "slow_first", "fast_second",
    ]


def test_stabilize_is_stable_within_one_tool_and_keeps_earlier_iterations():
    ctx = ToolContext(supabase=None, elder_id=ELDER_A)
    ctx.committed_actions = [
        {"tool": "earlier_iteration", "summary": "kept"},
        {"tool": "b_tool", "summary": "b1"},
        {"tool": "a_tool", "summary": "a1"},
        {"tool": "b_tool", "summary": "b2"},
    ]
    _stabilize_actions(ctx, 1, ["a_tool", "b_tool"])
    assert [(a["tool"], a["summary"]) for a in ctx.committed_actions] == [
        ("earlier_iteration", "kept"),  # pre-slice untouched
        ("a_tool", "a1"),
        ("b_tool", "b1"),  # same-tool actions keep their relative order
        ("b_tool", "b2"),
    ]
