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
        "set_medication_reminder",
        "update_medication_dosage",
        "discontinue_medication",
        "log_dose",
        "resolve_missed_doses",
        "log_doses",
        "undo_dose",
        "snooze_dose",
        "get_drug_info",
        "add_doctor_question",
        "message_caregiver",
        "add_care_note",
        "list_caregivers",
        "show_instruction_video",
        "request_human_help",
        "check_refills",
        "log_refill",
        "request_refill",
        "check_drug_interactions",
        "show_schedule",
        "update_medical_profile",
        "set_allergy_severity",
        "add_symptom",
        "start_walkthrough",
        "verify_medication_exists",
        "offer_choices",
    }


def test_minted_jwt_acts_as_elder():
    claims = verify_jwt(mint_user_jwt(ELDER_A))
    assert claims["sub"] == ELDER_A
    assert claims["role"] == "authenticated"
    assert claims["aud"] == "authenticated"


def test_verify_jwt_accepts_es256_via_jwks(monkeypatch):
    # Modern Supabase projects sign browser access tokens with ES256 (asymmetric),
    # not the legacy HS256 shared secret — verify_jwt must accept them via JWKS.
    import time
    from types import SimpleNamespace

    import jwt as pyjwt
    from cryptography.hazmat.primitives.asymmetric import ec

    from hermes.db import auth

    private_key = ec.generate_private_key(ec.SECP256R1())
    now = int(time.time())
    token = pyjwt.encode(
        {"sub": ELDER_A, "role": "authenticated", "aud": "authenticated",
         "iat": now, "exp": now + 60},
        private_key,
        algorithm="ES256",
        headers={"kid": "test-key"},
    )

    class _StubJWKS:
        def get_signing_key_from_jwt(self, tok):
            return SimpleNamespace(key=private_key.public_key())

    monkeypatch.setattr(auth, "_get_jwks_client", lambda: _StubJWKS())
    claims = auth.verify_jwt(token)
    assert claims["sub"] == ELDER_A
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
    # Nothing was written, so nothing should be reported as committed.
    assert ctx.committed_actions == []


async def test_add_prescription_records_committed_action_only_on_commit():
    # ctx.committed_actions is the reliable "a write really happened" signal the
    # web app uses to confirm + redirect — it must stay empty on the propose turn.
    add = get_handler("add_prescription")
    supa = _StubSupabase()
    session = SessionState(elder_id=ELDER_A)
    ctx = ToolContext(supabase=supa, elder_id=ELDER_A, session=session)

    await add(ctx, name="Metformin", confirmed=False, dosage="500mg")
    assert ctx.committed_actions == []

    await add(ctx, name="Metformin", confirmed=True, dosage="500mg")
    assert len(ctx.committed_actions) == 1
    assert ctx.committed_actions[0]["tool"] == "add_prescription"
    assert "Metformin" in ctx.committed_actions[0]["summary"]


def test_supabase_url_rest_suffix_is_normalized(monkeypatch):
    # A deployed SUPABASE_URL that already ends in /rest/v1[/] must not double the
    # path (PostgREST PGRST125) — the client methods prepend /rest/v1 themselves.
    from hermes.config import get_settings
    from hermes.db.supabase import Supabase

    monkeypatch.setattr(
        get_settings(), "supabase_url", "https://proj.supabase.co/rest/v1/", raising=False
    )
    assert str(Supabase()._http.base_url) == "https://proj.supabase.co"
