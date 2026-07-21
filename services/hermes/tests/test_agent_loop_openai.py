"""Tests for the OpenAI path of the agent loop (agent/loop.py) with a fake client.

No API key or network: FakeOpenAI stands in for AsyncOpenAI and returns scripted
chat.completions.create responses. Provider is forced to "openai" per-test.
"""

from __future__ import annotations

from fakes import (
    FakeDB,
    FakeOpenAI,
    FakeSupabase,
    openai_message,
    openai_response,
    openai_tool_call,
)
from hermes.agent.loop import _RETRY_REPLY, run_agent_turn
from hermes.channels.session import SessionState
from hermes.config import get_settings
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


def _use_openai(monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_provider", "openai", raising=False)
    monkeypatch.setattr(get_settings(), "openai_model", "gpt-4o", raising=False)
    # A dummy key so effective_provider resolves to openai (no real client is built).
    monkeypatch.setattr(get_settings(), "openai_api_key", "test-key", raising=False)


async def test_openai_loop_dispatches_tool_then_replies(monkeypatch):
    _use_openai(monkeypatch)
    db = FakeDB({
        "profiles": [{"id": ELDER_A, "dialect": "en"}],
        "medications": [{"name": "Metformin", "dosage": "500mg", "purpose": "x",
                         "schedule": {"times": ["08:00"]}, "priority": "critical",
                         "instructions": "", "archived": False}],
        "conversation_turns": [],
    })
    client = FakeOpenAI([
        openai_response(openai_message(tool_calls=[openai_tool_call("list_medications", {})])),
        openai_response(openai_message(content="You take Metformin 500mg in the morning.")),
    ])
    reply, tools_used, _ = await run_agent_turn(client, _ctx(db), "what do i take?")
    assert tools_used == ["list_medications"]
    assert "Metformin" in reply
    assert sum(1 for t, _ in db.inserted if t == "conversation_turns") == 2
    # It called the configured OpenAI model.
    assert client.chat.completions.calls[0]["model"] == "gpt-4o"
    # tool_call_id round-trips into the tool-role message so the API can match it.
    tool_msg = client.chat.completions.calls[1]["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "call_1"


async def test_openai_loop_passes_dialect_system_prompt(monkeypatch):
    _use_openai(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "hokkien"}],
                 "conversation_turns": []})
    client = FakeOpenAI([openai_response(openai_message(content="ok"))])
    await run_agent_turn(client, _ctx(db), "hello")
    system_msg = client.chat.completions.calls[0]["messages"][0]
    assert system_msg["role"] == "system"
    assert "hokkien" in system_msg["content"]


async def test_openai_loop_iteration_cap_falls_back(monkeypatch):
    _use_openai(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "en"}], "medications": [],
                 "conversation_turns": []})
    # Always returns a tool call -> never terminates -> hits the cap.
    client = FakeOpenAI([
        openai_response(openai_message(tool_calls=[openai_tool_call("list_medications", {})])),
    ])
    reply, tools_used, _ = await run_agent_turn(client, _ctx(db), "loop forever")
    # Hitting the cap now recovers with a gentle retry, not a human handoff.
    assert reply == _RETRY_REPLY
    assert len(tools_used) >= 8
