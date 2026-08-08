"""Medical-profile injection into the system prompt (Item 2b)."""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.agent.loop import _medical_profile
from hermes.agent.prompts import system_prompt_for
from hermes.channels.session import SessionState
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


_INJECT_MARKER = "saved medical profile (allergies"


def test_system_prompt_includes_profile():
    out = system_prompt_for(medical_profile="Allergic to penicillin.")
    assert "Allergic to penicillin." in out
    assert _INJECT_MARKER in out.lower()  # the injected, non-diagnostic block


def test_system_prompt_omits_profile_when_absent():
    assert _INJECT_MARKER not in system_prompt_for().lower()


def test_reply_language_injected_firmly():
    out = system_prompt_for(reply_language="Malay")
    assert "Malay" in out
    # Firm, whole-reply directive (not the old soft "reply in X unless they switch").
    assert "ENTIRE reply in Malay" in out


def test_reply_language_omitted_when_absent():
    assert "ENTIRE reply" not in system_prompt_for()


async def test_loader_reads_and_caches_profile():
    db = FakeDB({"profiles": [{"id": ELDER_A, "accessibility": {"medical_profile": "Has COPD."}}]})
    session = SessionState(elder_id=ELDER_A)
    ctx = ToolContext(supabase=FakeSupabase(db=db), elder_id=ELDER_A, session=session)
    assert await _medical_profile(ctx) == "Has COPD."
    assert session.medical_profile_loaded is True
    # Second call is served from cache (no exception even if DB is emptied).
    session.medical_profile = "Has COPD."
    assert await _medical_profile(ctx) == "Has COPD."


# --- Guided first-time intake (onboarding) ----------------------------------
def test_system_prompt_includes_intake_block_when_onboarding():
    out = system_prompt_for(onboarding=True)
    assert "FIRST-TIME SETUP" in out
    assert "update_medical_profile" in out


def test_system_prompt_omits_intake_block_by_default():
    assert "FIRST-TIME SETUP" not in system_prompt_for()
    assert "FIRST-TIME SETUP" not in system_prompt_for(medical_profile="Has COPD.")


async def test_empty_profile_puts_agent_turn_in_intake_mode(monkeypatch):
    from fakes import FakeAnthropic, response, text_block, use_anthropic
    from hermes.agent.loop import run_agent_turn

    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A, "accessibility": {}}],
                 "conversation_turns": []})
    session = SessionState(elder_id=ELDER_A)
    ctx = ToolContext(supabase=FakeSupabase(db=db), elder_id=ELDER_A, session=session)
    anthropic = FakeAnthropic([response("end_turn", [text_block("Welcome!")])])

    await run_agent_turn(anthropic, ctx, "hello")
    system_text = "".join(b["text"] for b in anthropic.messages.calls[0]["system"])
    assert "FIRST-TIME SETUP" in system_text


async def test_populated_profile_skips_intake_mode(monkeypatch):
    from fakes import FakeAnthropic, response, text_block, use_anthropic
    from hermes.agent.loop import run_agent_turn

    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A,
                               "accessibility": {"medical_profile": "Has COPD."}}],
                 "conversation_turns": []})
    session = SessionState(elder_id=ELDER_A)
    ctx = ToolContext(supabase=FakeSupabase(db=db), elder_id=ELDER_A, session=session)
    anthropic = FakeAnthropic([response("end_turn", [text_block("Hi!")])])

    await run_agent_turn(anthropic, ctx, "hello")
    system_text = "".join(b["text"] for b in anthropic.messages.calls[0]["system"])
    assert "FIRST-TIME SETUP" not in system_text
    assert "Has COPD." in system_text


async def test_intake_active_forces_intake_mode_and_commit_clears_it(monkeypatch):
    from fakes import FakeAnthropic, response, text_block, use_anthropic
    from hermes.agent.loop import run_agent_turn
    from hermes.tools.profile import update_medical_profile

    use_anthropic(monkeypatch)
    db = FakeDB({"profiles": [{"id": ELDER_A,
                               "accessibility": {"medical_profile": "Has COPD."}}],
                 "conversation_turns": []})
    session = SessionState(elder_id=ELDER_A)
    session.intake_active = True  # /setup re-run despite an existing profile
    ctx = ToolContext(supabase=FakeSupabase(db=db), elder_id=ELDER_A, session=session)
    anthropic = FakeAnthropic([response("end_turn", [text_block("Let's redo it.")])])

    await run_agent_turn(anthropic, ctx, "redo my profile")
    system_text = "".join(b["text"] for b in anthropic.messages.calls[0]["system"])
    assert "FIRST-TIME SETUP" in system_text

    # Committing a profile update ends the re-run.
    await update_medical_profile(ctx, content="Allergic to aspirin.", confirmed=False)
    await update_medical_profile(ctx, content="Allergic to aspirin.", confirmed=True)
    assert session.intake_active is False


# --- ANSWER BUTTONS (unconditional) -----------------------------------------
def test_answer_buttons_block_is_unconditional():
    """Both shells, always. The web client renders answer buttons only when a turn
    carries `choices` (offer_choices) or `awaiting_confirmation` (a tool PROPOSE),
    so a purely conversational yes/no left the person with only the keyboard. This
    block is what steers the model to call offer_choices for that case too, so it
    must not sit behind a role/dialect/onboarding branch the way every other
    appended block does — a caregiver asking "Shall I look that up?" has the same
    problem an elder does."""
    for role in ("elder", "caregiver"):
        out = system_prompt_for(app_role=role)
        assert "ANSWER BUTTONS" in out, role
        assert "offer_choices" in out, role
        # The conversational case named explicitly — the omission this closes.
        assert "conversational" in out.lower(), role
    # Present on the bare default too (no role, no profile, no language).
    assert "ANSWER BUTTONS" in system_prompt_for()


def test_answer_buttons_block_names_no_symbol():
    """Mei cannot see how the answer control is drawn — the web app has no tick at
    all. Instructing her to say "tap ✅" writes a lie into the reply text."""
    out = system_prompt_for()
    block = out[out.index("ANSWER BUTTONS") :]
    assert "✅" not in block
    assert "✖" not in block
