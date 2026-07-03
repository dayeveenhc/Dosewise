"""Tests for the Claude tool-calling loop (agent/loop.py) with a fake Anthropic."""

from __future__ import annotations

from fakes import (
    FakeAnthropic,
    FakeDB,
    FakeSupabase,
    response,
    text_block,
    tool_use_block,
)
from hermes.agent.loop import run_agent_turn
from hermes.channels.session import SessionState
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


async def test_loop_dispatches_tool_then_replies():
    # profiles read (dialect lookup) + the medications the tool will list.
    db = FakeDB({
        "profiles": [{"dialect": "en"}],
        "medications": [{"name": "Metformin", "dosage": "500mg", "purpose": "x",
                         "schedule": {"times": ["08:00"]}, "priority": "critical",
                         "instructions": ""}],
        "conversation_turns": [],
    })
    anthropic = FakeAnthropic([
        response("tool_use", [tool_use_block("list_medications", {})]),
        response("end_turn", [text_block("You take Metformin 500mg in the morning.")]),
    ])
    reply, tools_used, messages = await run_agent_turn(
        anthropic, _ctx(db), "what do i take?"
    )
    assert tools_used == ["list_medications"]
    assert "Metformin" in reply
    # the turn was persisted (user + assistant rows).
    assert sum(1 for t, _ in db.inserted if t == "conversation_turns") == 2


async def test_loop_tailors_system_prompt_to_dialect():
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "hokkien"}],
                 "conversation_turns": []})
    anthropic = FakeAnthropic([response("end_turn", [text_block("ok")])])
    await run_agent_turn(anthropic, _ctx(db), "hello")
    system = anthropic.messages.calls[0]["system"]
    # System is sent as cached content blocks; the dialect is folded into the text.
    system_text = "".join(block["text"] for block in system)
    assert "hokkien" in system_text
    # The cache breakpoint is set so Anthropic reuses the prompt across iterations.
    assert system[-1]["cache_control"] == {"type": "ephemeral"}


async def test_loop_injects_dialect_slang(monkeypatch):
    async def fake_get_slang(dialect):
        return [("pang sai", "bowel movement")]

    # loop._elder_slang imports get_slang lazily from hermes.slang at call time.
    monkeypatch.setattr("hermes.slang.get_slang", fake_get_slang)
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "hokkien"}],
                 "conversation_turns": []})
    anthropic = FakeAnthropic([response("end_turn", [text_block("ok")])])
    await run_agent_turn(anthropic, _ctx(db), "i went pang sai")
    system = anthropic.messages.calls[0]["system"]
    system_text = "".join(block["text"] for block in system)
    assert "pang sai = bowel movement" in system_text


async def test_loop_iteration_cap_falls_back_to_human():
    db = FakeDB({"profiles": [{"dialect": "en"}], "medications": [],
                 "conversation_turns": []})
    # Always returns tool_use -> never terminates -> hits the cap.
    anthropic = FakeAnthropic([
        response("tool_use", [tool_use_block("list_medications", {})]),
    ])
    reply, tools_used, _ = await run_agent_turn(anthropic, _ctx(db), "loop forever")
    assert "person" in reply.lower()
    assert len(tools_used) >= 8  # one dispatch per capped iteration


async def test_loop_surfaces_unknown_tool_as_error():
    db = FakeDB({"profiles": [{"dialect": "en"}], "conversation_turns": []})
    anthropic = FakeAnthropic([
        response("tool_use", [tool_use_block("no_such_tool", {})]),
        response("end_turn", [text_block("sorry about that")]),
    ])
    reply, tools_used, _ = await run_agent_turn(anthropic, _ctx(db), "hi")
    assert tools_used == ["no_such_tool"]
    assert "sorry" in reply.lower()
