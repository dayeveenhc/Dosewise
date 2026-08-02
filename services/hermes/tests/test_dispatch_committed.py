"""_dispatch_tool must tell the client whether THIS dispatch actually committed.

The web chat navigates the screen on a tool_end event ONLY when event.committed
is true — so a propose/clarify turn (a tool that RUNS but writes nothing, e.g.
update_medication_dosage's first call) must not yank the UI to a result screen.
This pins that signal directly; the SSE route test can't cover it (it fakes
run_agent_turn and never reaches _dispatch_tool).
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.agent import loop as loop_mod
from hermes.channels.session import SessionState
from hermes.tools.base import ToolContext, record_action

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx() -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=FakeDB()),
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


async def _dispatch(ctx, name, handler, monkeypatch) -> dict:
    # Resolve the loop's imported get_handler to our fake so the real registry
    # (and test_all_tools_registered) is untouched — same pattern as
    # test_actions_order.py.
    monkeypatch.setattr(loop_mod, "get_handler", lambda _n: handler)
    events: list[dict] = []

    async def on_event(e):
        events.append(e)

    await loop_mod._dispatch_tool(ctx, name, {}, on_event=on_event)
    return next(e for e in events if e["type"] == "tool_end")


async def test_tool_end_committed_true_when_the_handler_writes(monkeypatch):
    async def writing_handler(ctx, **_):
        record_action(
            ctx, tool="add_symptom", summary="headache",
            entity_type="symptom", entity_id="s1",
        )
        return "logged"

    end = await _dispatch(_ctx(), "add_symptom", writing_handler, monkeypatch)
    assert end["committed"] is True
    assert end["is_error"] is False


async def test_tool_end_committed_false_on_a_propose_only_turn(monkeypatch):
    async def propose_only(ctx, **_):
        return "PROPOSED (not yet saved)."  # runs, commits nothing

    end = await _dispatch(_ctx(), "update_medication_dosage", propose_only, monkeypatch)
    assert end["committed"] is False


async def test_tool_end_committed_false_when_the_handler_errors(monkeypatch):
    async def boom(ctx, **_):
        raise RuntimeError("nope")

    end = await _dispatch(_ctx(), "add_symptom", boom, monkeypatch)
    assert end["committed"] is False
    assert end["is_error"] is True
