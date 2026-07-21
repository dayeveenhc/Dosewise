"""Tests for the Gemini path of the agent loop (agent/loop.py) with a fake client.

No API key or network: FakeGemini stands in for genai.Client and returns scripted
generate_content responses. Provider is forced to "gemini" per-test.
"""

from __future__ import annotations

from fakes import (
    FakeDB,
    FakeGemini,
    FakeSupabase,
    gemini_function_call,
    gemini_response,
    gemini_text_part,
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


def _use_gemini(monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_provider", "gemini", raising=False)
    monkeypatch.setattr(get_settings(), "gemini_model", "gemini-2.5-flash", raising=False)
    # A dummy key so effective_provider resolves to gemini (no real client is built).
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key", raising=False)


async def test_gemini_loop_dispatches_tool_then_replies(monkeypatch):
    _use_gemini(monkeypatch)
    db = FakeDB({
        "profiles": [{"id": ELDER_A, "dialect": "en"}],
        "medications": [{"name": "Metformin", "dosage": "500mg", "purpose": "x",
                         "schedule": {"times": ["08:00"]}, "priority": "critical",
                         "instructions": "", "archived": False}],
        "conversation_turns": [],
    })
    client = FakeGemini([
        gemini_response([gemini_function_call("list_medications", {})]),
        gemini_response([gemini_text_part("You take Metformin 500mg in the morning.")]),
    ])
    reply, tools_used, _ = await run_agent_turn(client, _ctx(db), "what do i take?")
    assert tools_used == ["list_medications"]
    assert "Metformin" in reply
    assert sum(1 for t, _ in db.inserted if t == "conversation_turns") == 2
    # It called the configured Gemini model.
    assert client.aio.models.calls[0]["model"] == "gemini-2.5-flash"


async def test_gemini_loop_passes_dialect_system_instruction(monkeypatch):
    _use_gemini(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "hokkien"}],
                 "conversation_turns": []})
    client = FakeGemini([gemini_response([gemini_text_part("ok")])])
    await run_agent_turn(client, _ctx(db), "hello")
    system = client.aio.models.calls[0]["config"].system_instruction
    assert "hokkien" in system


async def test_gemini_loop_iteration_cap_falls_back(monkeypatch):
    _use_gemini(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "dialect": "en"}], "medications": [],
                 "conversation_turns": []})
    # Always returns a function call -> never terminates -> hits the cap.
    client = FakeGemini([
        gemini_response([gemini_function_call("list_medications", {})]),
    ])
    reply, tools_used, _ = await run_agent_turn(client, _ctx(db), "loop forever")
    # Hitting the cap now recovers with a gentle retry, not a human handoff.
    assert reply == _RETRY_REPLY
    assert len(tools_used) >= 8
