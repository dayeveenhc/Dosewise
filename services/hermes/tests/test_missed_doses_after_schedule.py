""""I took all" after Mei shows today's schedule, not after Mei was asked to
resolve missed doses — an agent-loop-level (not just tool-level) gap.

Live root-cause (2026-07-27, real turns against a working-tree hermes): Mei's
own `show_schedule` reply never stashes any session state, so a broad reply
("I took all") to HER OWN listing is a fresh trigger for `resolve_missed_doses`,
never a stray `confirmed=true` with nothing proposed. 5/5 live trials showed
the propose->confirm plumbing already works correctly (a `confirmed=false`
propose, then a separate "yes" commits) — the actual gap was requiring a
SECOND confirmation worded almost identically to what the user already said,
a dead end most users won't complete. The fix (soul.md only) teaches Mei that
when she JUST showed the specific list this same exchange and the reply is an
unhedged blanket "yes"/"I took all", that reply already IS the confirmation —
call `resolve_missed_doses` confirmed=false then confirmed=true in the SAME
turn (reusing the "Guided walkthroughs" section's sanctioned propose->confirm
exception: the patient's own clear words are the confirmation).

These tests are the deterministic regression guard for the PLUMBING, not proof
a real LLM now reliably follows the new rail — that's what the live
re-verification (repeated, since LLM tool-selection is probabilistic
throughout this project) is for.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

from fakes import (
    FakeAnthropic,
    FakeDB,
    FakeSupabase,
    response,
    text_block,
    tool_use_block,
    use_anthropic,
)
from hermes.agent.loop import run_agent_turn
from hermes.channels.session import SessionState
from hermes.config import get_settings
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"
TZ = "Asia/Singapore"
# 2026-07-27 14:00 SGT (06:00 UTC) -- the single 08:00 slot for each seeded
# medication is past due; nothing is upcoming.
FIXED_NOW = datetime(2026, 7, 27, 6, 0, tzinfo=UTC)


def _slot_utc_iso(hhmm: str) -> str:
    hh, mm = hhmm.split(":")
    local = datetime.combine(
        date(2026, 7, 27), time(int(hh), int(mm)), tzinfo=ZoneInfo(TZ)
    )
    return local.astimezone(UTC).isoformat()


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


def _db() -> FakeDB:
    """Mirrors the reported shape: two due-now-unmet meds, one already taken."""
    return FakeDB({
        "profiles": [{"id": ELDER_A, "dialect": "en"}],
        "medications": [
            {"id": "m1", "name": "Metformin Hydrochloride", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Empagliflozin", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m3", "name": "Tacrolimus", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
        ],
        "doses": [
            {"id": "d0", "medication_id": "m3", "elder_id": ELDER_A,
             "status": "taken", "scheduled_at": _slot_utc_iso("08:00")},
        ],
        "conversation_turns": [],
    })


def _pin_clock(monkeypatch):
    from hermes.tools import doses
    monkeypatch.setattr(doses, "_now_utc", lambda: FIXED_NOW)
    monkeypatch.setattr(get_settings(), "hermes_tz", TZ, raising=False)


async def test_confirm_true_with_no_propose_after_schedule_listing_is_refused(monkeypatch):
    """Safety-net control: even if the model (wrongly) jumps straight to
    confirmed=true after show_schedule stashed nothing, the tool refuses and
    nothing is silently written — proves the guard holds regardless of
    whether the model follows the new rail."""
    use_anthropic(monkeypatch)
    _pin_clock(monkeypatch)
    db = _db()
    ctx = _ctx(db)
    client = FakeAnthropic([
        response("tool_use", [tool_use_block("show_schedule", {})]),
        response("end_turn", [text_block(
            "Metformin and Empagliflozin are due now; Tacrolimus is already taken.")]),
        response("tool_use", [tool_use_block("resolve_missed_doses", {"confirmed": True})]),
        response("end_turn", [text_block("All set!")]),  # the confabulated reply
    ])

    _reply1, _tools1, messages = await run_agent_turn(client, ctx, "what do I take today?")
    assert ctx.session.pending_missed_doses is None
    assert ctx.session.awaiting_confirmation is False

    _reply2, tools2, _messages2 = await run_agent_turn(
        client, ctx, "i took all", history=messages
    )
    assert "resolve_missed_doses" in tools2
    assert ctx.committed_actions == []  # refused -> nothing committed
    taken_ids = {r["medication_id"] for r in db.tables["doses"] if r["status"] == "taken"}
    assert taken_ids == {"m3"}  # only the pre-seeded Tacrolimus dose


async def test_broad_confirm_after_schedule_listing_collapses_to_one_turn(monkeypatch):
    """The fixed shape: show_schedule (stashes nothing) -> "I took all" ->
    Mei calls resolve_missed_doses confirmed=false THEN confirmed=true in the
    SAME turn (the "yes IS the confirm" rule), because she just showed the
    exact list this same exchange and the reply is an unhedged blanket yes."""
    use_anthropic(monkeypatch)
    _pin_clock(monkeypatch)
    db = _db()
    ctx = _ctx(db)
    client = FakeAnthropic([
        response("tool_use", [tool_use_block("show_schedule", {})]),
        response("end_turn", [text_block(
            "Metformin and Empagliflozin are due now; Tacrolimus is already taken.")]),
        response("tool_use", [tool_use_block("resolve_missed_doses", {"confirmed": False})]),
        response("tool_use", [tool_use_block("resolve_missed_doses", {"confirmed": True})]),
        response("end_turn", [text_block("Done — both marked taken.")]),
    ])

    _reply1, _tools1, messages = await run_agent_turn(client, ctx, "what do I take today?")
    assert ctx.session.pending_missed_doses is None
    # show_schedule is read-only re: doses; only conversation_turns logging
    # happens (from _persist) -- confirm no DOSE row was touched yet.
    assert not any(t == "doses" for t, _ in db.inserted)
    assert not any(t == "doses" for t, _, _ in db.updated)

    reply2, tools2, _messages2 = await run_agent_turn(
        client, ctx, "i took all", history=messages
    )

    # Both calls happened within this ONE turn — no separate third user message.
    assert tools2 == ["resolve_missed_doses", "resolve_missed_doses"]
    assert ctx.session.pending_missed_doses is None  # cleared after commit
    assert "Done" in reply2

    # Independent re-read: exactly one bulk committed action, covering both
    # unmet doses; Tacrolimus (already taken) is untouched.
    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "resolve_missed_doses"
    entity_ids = {e["entity_id"] for e in action["entities"]}
    assert entity_ids == {"m1", "m2"}
    taken_med_ids = {r["medication_id"] for r in db.tables["doses"] if r["status"] == "taken"}
    assert taken_med_ids == {"m1", "m2", "m3"}
