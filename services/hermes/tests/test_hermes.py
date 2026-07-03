"""Offline smoke tests: JWT identity claims and the scan-propose-confirm guard.

These need no live Supabase — the DB client is stubbed. The end-to-end RLS proof
(Caregiver C sees Elder A but not Elder B) is exercised against a running local
Supabase per the top-level README's verification steps.
"""

from hermes.channels.session import SessionState
from hermes.db.auth import mint_user_jwt, verify_jwt
from hermes.tools import get_handler, tool_schemas
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def test_all_tools_registered():
    names = {t["name"] for t in tool_schemas()}
    assert names == {
        "list_medications",
        "add_prescription",
        "log_dose",
        "get_drug_info",
        "add_doctor_question",
        "message_caregiver",
        "show_instruction_video",
        "request_human_help",
        "check_refills",
        "log_refill",
    }


def test_minted_jwt_acts_as_elder():
    claims = verify_jwt(mint_user_jwt(ELDER_A))
    assert claims["sub"] == ELDER_A
    assert claims["role"] == "authenticated"
    assert claims["aud"] == "authenticated"


class _StubDB:
    def __init__(self):
        self.inserted = []

    async def insert(self, table, row, returning=True):
        self.inserted.append((table, row))
        return []


class _StubSupabase:
    def __init__(self):
        self.db = _StubDB()

    def user_client(self, elder_id):
        return self.db


async def test_add_prescription_proposes_then_commits():
    add = get_handler("add_prescription")
    supa = _StubSupabase()
    session = SessionState(elder_id=ELDER_A)
    ctx = ToolContext(supabase=supa, elder_id=ELDER_A, session=session)

    # 1. Propose: no write, proposal stashed on the session.
    out = await add(ctx, name="Metformin", confirmed=False, dosage="500mg")
    assert "PROPOSED" in out
    assert supa.db.inserted == []
    assert session.pending_proposal["name"] == "Metformin"

    # 2. Confirm: writes exactly one medication row, clears the proposal.
    out = await add(ctx, name="Metformin", confirmed=True, dosage="500mg")
    assert "Saved" in out
    assert len(supa.db.inserted) == 1
    assert supa.db.inserted[0][0] == "medications"
    assert session.pending_proposal is None


async def test_add_prescription_refuses_confirm_without_proposal():
    add = get_handler("add_prescription")
    supa = _StubSupabase()
    ctx = ToolContext(
        supabase=supa, elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A)
    )
    # confirmed=true with no prior proposal must NOT write.
    out = await add(ctx, name="Warfarin", confirmed=True)
    assert "Refused" in out
    assert supa.db.inserted == []
