"""Agent-loop-level regression guard for "label all the meds i took at 8 am as
taken" — the reported bug, live-reproduced (2026-07-28, real turns against a
working-tree hermes on an isolated local Supabase) before this fix existed.

Live evidence, independently re-verified against the database: pre-fix, a
message like this either (a) fell to `log_dose`'s no-name ambiguous path and
asked "which one(s)?", writing nothing, or (b) reached `resolve_missed_doses`
but with NO way to say "just the 8am ones" — the tool has no time concept at
all, so a subsequent "yes" (or, live, a user simply repeating themselves)
marked EVERY missed dose taken regardless of its time, including one at a
completely different hour the user never claimed. That is the dangerous
direction: a false "taken" on a dose that was actually skipped.

The fix threads a `slot` filter through `resolve_missed_doses` (see
`tools/doses.py::_parse_slot_filter`/`_slot_filter_matches`) plus a soul.md
rail teaching Mei to pass it when the ask names a time. These tests script
the tool calls directly (via `FakeAnthropic`) rather than relying on a real
LLM to extract "08:00" from "8 am" — they are the deterministic regression
guard for the PLUMBING (the filter narrows correctly, the confirm only
commits the filtered subset), not proof a real LLM reliably calls it this
way every time. That proof is the repeated live re-verification described in
this project's own standing discipline (LLM tool-selection is probabilistic
throughout this codebase) — done once live for this exact fix already, and
worth repeating after any soul.md wording change.
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
# 2026-07-28 10:10 SGT (02:10 UTC) -- mirrors the live repro: 06:00 and 08:00
# are both past due, nothing is upcoming.
FIXED_NOW = datetime(2026, 7, 28, 2, 10, tzinfo=UTC)


def _slot_utc_iso(hhmm: str) -> str:
    hh, mm = hhmm.split(":")
    local = datetime.combine(
        date(2026, 7, 28), time(int(hh), int(mm)), tzinfo=ZoneInfo(TZ)
    )
    return local.astimezone(UTC).isoformat()


def _ctx(db: FakeDB) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db), elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )


def _db() -> FakeDB:
    """Mirrors the live repro exactly: two meds at 8am, one distractor at 6am."""
    return FakeDB({
        "profiles": [{"id": ELDER_A, "dialect": "en"}],
        "medications": [
            {"id": "m1", "name": "Metformin", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m2", "name": "Lisinopril", "archived": False,
             "schedule": {"times": ["08:00"], "frequency": "daily"}},
            {"id": "m3", "name": "Atorvastatin", "archived": False,
             "schedule": {"times": ["06:00"], "frequency": "daily"}},
        ],
        "doses": [],
        "conversation_turns": [],
    })


def _pin_clock(monkeypatch):
    from hermes.tools import doses
    monkeypatch.setattr(doses, "_now_utc", lambda: FIXED_NOW)
    monkeypatch.setattr(get_settings(), "hermes_tz", TZ, raising=False)


async def test_time_qualified_all_proposes_only_the_matching_slot(monkeypatch):
    use_anthropic(monkeypatch)
    _pin_clock(monkeypatch)
    db = _db()
    ctx = _ctx(db)
    client = FakeAnthropic([
        response("tool_use", [tool_use_block(
            "resolve_missed_doses", {"confirmed": False, "slot": "08:00"}
        )]),
        response("end_turn", [text_block(
            "Metformin and Lisinopril were due at 8:00 AM and aren't logged "
            "yet — mark both as taken?"
        )]),
    ])

    reply, tools, _messages = await run_agent_turn(
        client, ctx, "label all the meds i took at 8 am as taken"
    )

    assert tools == ["resolve_missed_doses"]
    assert "Atorvastatin" not in reply
    assert ctx.session.pending_missed_doses == [
        {"medication_id": "m1", "name": "Metformin", "slot": "08:00"},
        {"medication_id": "m2", "name": "Lisinopril", "slot": "08:00"},
    ]
    # Nothing written on the propose turn.
    assert not any(t == "doses" for t, _ in db.inserted)
    assert ctx.committed_actions == []


async def test_time_qualified_confirm_only_marks_the_filtered_subset(monkeypatch):
    use_anthropic(monkeypatch)
    _pin_clock(monkeypatch)
    db = _db()
    ctx = _ctx(db)
    client = FakeAnthropic([
        response("tool_use", [tool_use_block(
            "resolve_missed_doses", {"confirmed": False, "slot": "08:00"}
        )]),
        response("end_turn", [text_block(
            "Metformin and Lisinopril were due at 8:00 AM — mark both as taken?"
        )]),
        response("tool_use", [tool_use_block(
            "resolve_missed_doses", {"confirmed": True}
        )]),
        response("end_turn", [text_block("Done — both marked taken.")]),
    ])

    _reply1, _tools1, messages = await run_agent_turn(
        client, ctx, "label all the meds i took at 8 am as taken"
    )
    reply2, tools2, _messages2 = await run_agent_turn(
        client, ctx, "yes", history=messages
    )

    assert tools2 == ["resolve_missed_doses"]
    assert "Done" in reply2
    assert ctx.session.pending_missed_doses is None

    # Independent re-read: exactly the two 8am doses landed; the 6am
    # distractor (Atorvastatin) was never touched -- the dangerous direction
    # this fix exists to close.
    taken_ids = {r["medication_id"] for r in db.tables["doses"] if r["status"] == "taken"}
    assert taken_ids == {"m1", "m2"}
    assert "m3" not in taken_ids

    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    entity_ids = {e["entity_id"] for e in action["entities"]}
    assert entity_ids == {"m1", "m2"}
