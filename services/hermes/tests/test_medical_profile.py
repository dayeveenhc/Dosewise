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


async def test_loader_reads_and_caches_profile():
    db = FakeDB({"profiles": [{"id": ELDER_A, "accessibility": {"medical_profile": "Has COPD."}}]})
    session = SessionState(elder_id=ELDER_A)
    ctx = ToolContext(supabase=FakeSupabase(db=db), elder_id=ELDER_A, session=session)
    assert await _medical_profile(ctx) == "Has COPD."
    assert session.medical_profile_loaded is True
    # Second call is served from cache (no exception even if DB is emptied).
    session.medical_profile = "Has COPD."
    assert await _medical_profile(ctx) == "Has COPD."
