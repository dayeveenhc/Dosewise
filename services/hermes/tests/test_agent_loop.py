"""Tests for the Claude tool-calling loop (agent/loop.py) with a fake Anthropic."""

from __future__ import annotations

import base64
import copy

from fakes import (
    FakeAnthropic,
    FakeDB,
    FakeSupabase,
    response,
    text_block,
    tool_use_block,
    use_anthropic,
)
from hermes.agent.loop import _RETRY_REPLY, run_agent_turn
from hermes.channels.session import SessionState
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


async def test_loop_dispatches_tool_then_replies(monkeypatch):
    use_anthropic(monkeypatch)
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


async def test_image_is_stripped_from_threaded_history(monkeypatch):
    """A prescription photo is analysed on its turn but must not stay in the history
    threaded forward (it would re-send the base64 image on every later turn)."""
    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"dialect": "en"}], "conversation_turns": []})
    anthropic = FakeAnthropic([response("end_turn", [text_block("Got your photo.")])])
    _reply, _tools, messages = await run_agent_turn(
        anthropic, _ctx(db), "here is my prescription", image_bytes=b"JPEG",
    )
    # The returned history carries no image block...
    for m in messages:
        if isinstance(m["content"], list):
            assert all(b.get("type") != "image" for b in m["content"])
    # ...but the user turn still keeps its text (never emptied).
    user_lists = [m["content"] for m in messages
                  if m["role"] == "user" and isinstance(m["content"], list)]
    assert user_lists and all(
        any(b.get("type") == "text" for b in content) for content in user_lists
    )


def _record_sent_messages(anthropic) -> list[list]:
    """Snapshot what each create() call actually sent.

    FakeMessages.calls keeps the live list, which the loop goes on to mutate —
    it appends the assistant reply and then _strip_images() removes the very
    image blocks these tests are about. A deep copy taken at call time is the
    only way to see the request as the model saw it.
    """
    sent: list[list] = []
    create = anthropic.messages.create

    async def spy(**kwargs):
        sent.append(copy.deepcopy(kwargs["messages"]))
        return await create(**kwargs)

    anthropic.messages.create = spy
    return sent


def _image_data(user_content: list) -> list[str]:
    return [b["source"]["data"] for b in user_content if b.get("type") == "image"]


async def test_several_images_each_become_their_own_block(monkeypatch):
    """The web composer can stage a few photos on one turn (`images=[...]`), and
    every one of them must reach the model — not just the first."""
    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"dialect": "en"}], "conversation_turns": []})
    anthropic = FakeAnthropic([response("end_turn", [text_block("Got both photos.")])])
    sent = _record_sent_messages(anthropic)
    await run_agent_turn(
        anthropic, _ctx(db), "here are both sides of the box",
        images=[b"JPEG-front", b"JPEG-back"],
    )
    user_content = sent[0][-1]["content"]
    assert _image_data(user_content) == [
        base64.standard_b64encode(b"JPEG-front").decode(),
        base64.standard_b64encode(b"JPEG-back").decode(),
    ]
    # The text still rides along after them, as it does on the single-image path.
    assert any(b.get("type") == "text" for b in user_content)


async def test_single_image_bytes_still_works_alongside_the_list_form(monkeypatch):
    """`image_bytes` is what Telegram and the CLI pass; adding `images` must not
    have quietly retired it."""
    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"dialect": "en"}], "conversation_turns": []})
    anthropic = FakeAnthropic([response("end_turn", [text_block("Got your photo.")])])
    sent = _record_sent_messages(anthropic)
    await run_agent_turn(anthropic, _ctx(db), "here is my prescription", image_bytes=b"JPEG")
    assert _image_data(sent[0][-1]["content"]) == [
        base64.standard_b64encode(b"JPEG").decode()
    ]


async def test_loop_tailors_system_prompt_to_dialect(monkeypatch):
    use_anthropic(monkeypatch)
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
    use_anthropic(monkeypatch)

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


async def test_loop_iteration_cap_recovers_with_retry(monkeypatch):
    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"dialect": "en"}], "medications": [],
                 "conversation_turns": []})
    # Always returns tool_use -> never terminates -> hits the cap.
    anthropic = FakeAnthropic([
        response("tool_use", [tool_use_block("list_medications", {})]),
    ])
    reply, tools_used, _ = await run_agent_turn(anthropic, _ctx(db), "loop forever")
    # Hitting the cap now recovers with a gentle retry, not a human handoff.
    assert reply == _RETRY_REPLY
    assert len(tools_used) >= 8  # one dispatch per capped iteration


async def test_loop_surfaces_unknown_tool_as_error(monkeypatch):
    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"dialect": "en"}], "conversation_turns": []})
    anthropic = FakeAnthropic([
        response("tool_use", [tool_use_block("no_such_tool", {})]),
        response("end_turn", [text_block("sorry about that")]),
    ])
    reply, tools_used, _ = await run_agent_turn(anthropic, _ctx(db), "hi")
    assert tools_used == ["no_such_tool"]
    assert "sorry" in reply.lower()
