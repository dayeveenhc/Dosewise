"""Automated RLS consent proof — the security-critical guarantee.

Encodes what the READMEs describe as a manual check: Caregiver C is ACTIVELY
linked to Elder A but NOT Elder B, so acting as C (via a minted JWT, exactly as
Hermes does) they can read Elder A's medications but must be blind to Elder B's.

Requires a live, seeded local Supabase — so it's marked `integration` and excluded
from the offline suite / CI. To run it:

    supabase start && supabase db reset          # applies migrations + seed
    # export the REAL local values so pytest's offline conftest defaults don't win:
    set -a && source ../../.env && set +a         # SUPABASE_URL / _ANON_KEY / _JWT_SECRET
    RUN_INTEGRATION=1 uv run pytest -m integration

It self-skips if RUN_INTEGRATION isn't set or Supabase isn't reachable.
"""

from __future__ import annotations

import os
import uuid

import httpx
import pytest

from hermes.config import get_settings
from hermes.db.supabase import PostgrestError, Supabase

pytestmark = pytest.mark.integration

ELDER_A = "00000000-0000-0000-0000-00000000000a"
ELDER_B = "00000000-0000-0000-0000-00000000000b"
CAREGIVER_C = "00000000-0000-0000-0000-00000000000c"


@pytest.fixture
async def supabase():
    if os.environ.get("RUN_INTEGRATION") != "1":
        pytest.skip("set RUN_INTEGRATION=1 (needs a live, seeded local Supabase)")
    supa = Supabase()
    try:
        # Connectivity probe as the service role.
        await supa.service_client().select("profiles", columns="id", limit=1)
    except Exception as exc:  # noqa: BLE001
        await supa.aclose()
        pytest.skip(f"local Supabase not reachable: {exc}")
    yield supa
    await supa.aclose()


async def test_caregiver_sees_linked_elder_only(supabase):
    """Acting as Caregiver C, medications visible are Elder A's — never Elder B's."""
    caregiver = supabase.user_client(CAREGIVER_C)
    rows = await caregiver.select("medications", columns="elder_id,name")
    visible_elders = {r["elder_id"] for r in rows}

    assert ELDER_A in visible_elders, "caregiver should see their linked elder's meds"
    assert ELDER_B not in visible_elders, "RLS breach: caregiver saw an unlinked elder"


async def test_caregiver_cannot_read_unlinked_elder_doses(supabase):
    """Explicitly querying Elder B's doses as Caregiver C returns nothing (RLS)."""
    caregiver = supabase.user_client(CAREGIVER_C)
    rows = await caregiver.select(
        "doses", columns="id", filters={"elder_id": f"eq.{ELDER_B}"}
    )
    assert rows == [], "RLS breach: caregiver read an unlinked elder's doses"


async def test_elder_sees_own_medications(supabase):
    """Elder A, acting as themselves, sees their own medications."""
    elder = supabase.user_client(ELDER_A)
    rows = await elder.select("medications", columns="elder_id,name")
    assert rows, "elder should see their own medications"
    assert all(r["elder_id"] == ELDER_A for r in rows)


async def test_elder_cannot_read_other_elders_medications(supabase):
    """Elder A explicitly querying Elder B's medications gets nothing (RLS)."""
    elder = supabase.user_client(ELDER_A)
    rows = await elder.select(
        "medications", columns="id", filters={"elder_id": f"eq.{ELDER_B}"}
    )
    assert rows == [], "RLS breach: elder read another elder's medications"


async def test_delete_is_denied_by_rls(supabase):
    """The restrictive deny policies in migration 0004 mean an authenticated user
    cannot DELETE even their own rows: the DELETE affects zero rows (empty result,
    not an error), so the medication survives."""
    elder = supabase.user_client(ELDER_A)
    before = await elder.select("medications", columns="id", limit=1)
    assert before, "seed should give Elder A at least one medication"
    med_id = before[0]["id"]

    deleted = await elder.delete("medications", filters={"id": f"eq.{med_id}"})
    assert deleted == [], "RLS breach: DELETE removed a row it should not have"

    still_there = await elder.select(
        "medications", columns="id", filters={"id": f"eq.{med_id}"}
    )
    assert still_there, "RLS breach: the medication was deleted despite the deny policy"


# ---------------------------------------------------------------------------
# Adversarial RLS probes — Track A of the security-verification pass.
#
# These mint DISPOSABLE identities (never the shared seed Elder A/B/Caregiver C)
# so they can't corrupt state the tests above depend on. `profiles.id` is a FK
# to `auth.users(id)`, and PostgREST only exposes the `public` schema, so a
# disposable identity has to be created via the GoTrue admin API (service role)
# before a `profiles` row can reference it. Deleting the auth user cascades
# through profiles -> care_links/medications (all `on delete cascade`), so
# cleanup is a single admin-API delete per identity.
# ---------------------------------------------------------------------------


async def _create_disposable_profile(supabase: Supabase, role: str) -> str:
    """Create a throwaway auth.users row (via the GoTrue admin API) plus its
    matching public.profiles row (via the service role). Returns the user id."""
    settings = get_settings()
    email = f"track-a-{uuid.uuid4().hex}@dosewise.local"
    resp = await supabase._http.post(
        "/auth/v1/admin/users",
        json={"email": email, "password": "password", "email_confirm": True},
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
            "Content-Type": "application/json",
        },
    )
    resp.raise_for_status()
    user_id = resp.json()["id"]
    await supabase.service_client().insert(
        "profiles", {"id": user_id, "role": role, "full_name": f"track-a {role}"}
    )
    return user_id


async def _delete_disposable_profile(supabase: Supabase, user_id: str) -> None:
    """Best-effort cleanup: deleting the auth user cascades to profiles and
    everything that references it. Not critical (whole instance gets torn
    down later) so failures here are swallowed."""
    settings = get_settings()
    try:
        await supabase._http.delete(
            f"/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
    except Exception:  # noqa: BLE001
        pass


async def _create_disposable_auth_user(supabase: Supabase, tag: str) -> str:
    """Create a throwaway auth.users row via the GoTrue admin API ONLY — no
    matching public.profiles row. Used when a test needs a valid-but-unclaimed
    user id (e.g. the id a forged profiles-INSERT targets), so a pre-existing
    profiles row for that id can't confound the RLS check with a primary-key
    conflict. Cleanup reuses ``_delete_disposable_profile`` (it just deletes the
    auth user; there is no profiles row to cascade from)."""
    settings = get_settings()
    email = f"track-e-{tag}-{uuid.uuid4().hex}@dosewise.local"
    resp = await supabase._http.post(
        "/auth/v1/admin/users",
        json={"email": email, "password": "password", "email_confirm": True},
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
            "Content-Type": "application/json",
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# Track E of Round 2 — owner-or-linked-caregiver write policies on
# refills / doctor_questions / conversation_turns (0002 covers SELECT/INSERT/
# UPDATE identically per table; Round 1 / Track A only exercised
# medications/doses SELECT plus the care_links bugs fixed in 0005). Also
# covers profiles INSERT/UPDATE, untouched by Round 1.
#
# Each table gets: an unlinked-caregiver INSERT probe, an unlinked-caregiver
# UPDATE probe, and a linked-caregiver positive control (insert + update must
# still work — guards against an over-restrictive fix breaking the feature).
# care_links itself and migration 0005 are NOT touched by this track.
# ---------------------------------------------------------------------------


async def _setup_e1_e2_c(supabase: Supabase) -> tuple[str, str, str]:
    """Disposable elder E1, elder E2 (victim), caregiver C linked ACTIVELY to
    E1 only. The care_links row is inserted via the service role (bypasses
    RLS for setup), exactly like the existing seed/tests do."""
    e1 = await _create_disposable_profile(supabase, "elder")
    e2 = await _create_disposable_profile(supabase, "elder")
    c = await _create_disposable_profile(supabase, "caregiver")
    await supabase.service_client().insert(
        "care_links", {"elder_id": e1, "caregiver_id": c, "status": "active"}
    )
    return e1, e2, c


async def _teardown_e1_e2_c(supabase: Supabase, e1: str, e2: str, c: str) -> None:
    await _delete_disposable_profile(supabase, c)
    await _delete_disposable_profile(supabase, e2)
    await _delete_disposable_profile(supabase, e1)


# --- refills -----------------------------------------------------------------
# refills.medication_id is NOT NULL / FK -> medications, so each elder needs a
# backing medications row (service role) before a refill can reference it.


async def test_refills_unlinked_caregiver_cannot_insert(supabase):
    """Suspected-safe: refills_insert_owner_or_caregiver's with_check is
    `auth.uid() = elder_id or is_linked_caregiver(elder_id)`. Caregiver C is
    linked to E1 only, so a C-authored INSERT naming E2 (the unlinked victim)
    as elder_id must be rejected — or, if PostgREST returns success at all, the
    row must not actually have landed. This test asserts the SECURE outcome."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        med_e2 = (
            await supabase.service_client().insert(
                "medications", {"elder_id": e2, "name": "track-e refill probe med"}
            )
        )[0]["id"]

        caregiver = supabase.user_client(c)
        insert_error: Exception | None = None
        row: dict | None = None
        try:
            rows = await caregiver.insert(
                "refills",
                {
                    "elder_id": e2,
                    "medication_id": med_e2,
                    "pills_remaining": 3,
                    "threshold": 10,
                },
            )
            row = rows[0] if rows else None
        except PostgrestError as exc:
            insert_error = exc

        landed = await supabase.service_client().select(
            "refills", columns="id", filters={"elder_id": f"eq.{e2}"}
        )

        assert insert_error is not None or row is None, (
            "VULNERABILITY CONFIRMED (refills-insert): an unlinked caregiver's "
            f"INSERT for another elder's refill returned a row: {row!r}"
        )
        assert landed == [], (
            "VULNERABILITY CONFIRMED (refills-insert): a refills row for an "
            f"unlinked elder landed despite RLS: {landed!r}"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


async def test_refills_unlinked_caregiver_cannot_update(supabase):
    """Suspected-safe: refills_update_owner_or_caregiver's using-clause should
    make E2's refill invisible to C, so C's UPDATE affects zero rows (PostgREST
    returns an empty list, not an error — same shape as the migration-0004
    DELETE-deny test above). Asserts the SECURE outcome: the seeded value
    survives unchanged."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        med_e2 = (
            await supabase.service_client().insert(
                "medications", {"elder_id": e2, "name": "track-e refill probe med"}
            )
        )[0]["id"]
        seeded = await supabase.service_client().insert(
            "refills",
            {
                "elder_id": e2,
                "medication_id": med_e2,
                "pills_remaining": 42,
                "threshold": 10,
            },
        )
        refill_id = seeded[0]["id"]

        caregiver = supabase.user_client(c)
        update_result: list | None = None
        update_error: Exception | None = None
        try:
            update_result = await caregiver.update(
                "refills",
                {"pills_remaining": 0},
                filters={"id": f"eq.{refill_id}"},
            )
        except PostgrestError as exc:
            update_error = exc

        current = await supabase.service_client().select(
            "refills", columns="pills_remaining", filters={"id": f"eq.{refill_id}"}
        )
        unchanged = bool(current) and current[0]["pills_remaining"] == 42

        assert unchanged, (
            "VULNERABILITY CONFIRMED (refills-update): an unlinked caregiver's "
            f"UPDATE altered another elder's refill (update_result={update_result!r}, "
            f"update_error={update_error!r}, row now={current!r})"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


async def test_refills_linked_caregiver_can_insert_and_update(supabase):
    """Positive control: C is ACTIVELY linked to E1, so both INSERT and UPDATE
    on E1's refills must succeed — guards against an over-restrictive fix
    breaking the real feature."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        med_e1 = (
            await supabase.service_client().insert(
                "medications", {"elder_id": e1, "name": "track-e refill probe med"}
            )
        )[0]["id"]

        caregiver = supabase.user_client(c)
        inserted = await caregiver.insert(
            "refills",
            {
                "elder_id": e1,
                "medication_id": med_e1,
                "pills_remaining": 20,
                "threshold": 5,
            },
        )
        assert inserted, "linked caregiver should be able to insert a refill for their elder"
        refill_id = inserted[0]["id"]

        updated = await caregiver.update(
            "refills", {"pills_remaining": 5}, filters={"id": f"eq.{refill_id}"}
        )
        assert updated and updated[0]["pills_remaining"] == 5, (
            "linked caregiver should be able to update their elder's refill"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# --- doctor_questions ----------------------------------------------------------


async def test_doctor_questions_unlinked_caregiver_cannot_insert(supabase):
    """Same shape as the refills insert probe, for doctor_questions. Asserts
    the SECURE outcome: an unlinked caregiver cannot create an escalation
    entry for an elder they are not linked to."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        caregiver = supabase.user_client(c)
        insert_error: Exception | None = None
        row: dict | None = None
        try:
            rows = await caregiver.insert(
                "doctor_questions",
                {"elder_id": e2, "question": "track-e doctor_questions probe"},
            )
            row = rows[0] if rows else None
        except PostgrestError as exc:
            insert_error = exc

        landed = await supabase.service_client().select(
            "doctor_questions", columns="id", filters={"elder_id": f"eq.{e2}"}
        )

        assert insert_error is not None or row is None, (
            "VULNERABILITY CONFIRMED (doctor_questions-insert): an unlinked "
            f"caregiver's INSERT for another elder returned a row: {row!r}"
        )
        assert landed == [], (
            "VULNERABILITY CONFIRMED (doctor_questions-insert): a "
            f"doctor_questions row for an unlinked elder landed: {landed!r}"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


async def test_doctor_questions_unlinked_caregiver_cannot_update(supabase):
    """Same shape as the refills update probe, for doctor_questions. Asserts
    the SECURE outcome: the seeded question's status survives unchanged."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        seeded = await supabase.service_client().insert(
            "doctor_questions",
            {
                "elder_id": e2,
                "question": "track-e doctor_questions probe",
                "status": "open",
            },
        )
        question_id = seeded[0]["id"]

        caregiver = supabase.user_client(c)
        update_result: list | None = None
        update_error: Exception | None = None
        try:
            update_result = await caregiver.update(
                "doctor_questions",
                {"status": "dismissed"},
                filters={"id": f"eq.{question_id}"},
            )
        except PostgrestError as exc:
            update_error = exc

        current = await supabase.service_client().select(
            "doctor_questions", columns="status", filters={"id": f"eq.{question_id}"}
        )
        unchanged = bool(current) and current[0]["status"] == "open"

        assert unchanged, (
            "VULNERABILITY CONFIRMED (doctor_questions-update): an unlinked "
            f"caregiver's UPDATE altered another elder's question "
            f"(update_result={update_result!r}, update_error={update_error!r}, "
            f"row now={current!r})"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


async def test_doctor_questions_linked_caregiver_can_insert_and_update(supabase):
    """Positive control: C linked to E1 can INSERT and UPDATE E1's
    doctor_questions rows."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        caregiver = supabase.user_client(c)
        inserted = await caregiver.insert(
            "doctor_questions",
            {"elder_id": e1, "question": "track-e doctor_questions probe"},
        )
        assert inserted, (
            "linked caregiver should be able to insert a doctor_question for their elder"
        )
        question_id = inserted[0]["id"]

        updated = await caregiver.update(
            "doctor_questions",
            {"status": "dismissed"},
            filters={"id": f"eq.{question_id}"},
        )
        assert updated and updated[0]["status"] == "dismissed", (
            "linked caregiver should be able to update their elder's doctor_question"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# --- conversation_turns --------------------------------------------------------


async def test_conversation_turns_unlinked_caregiver_cannot_insert(supabase):
    """Same shape as the refills insert probe, for conversation_turns. Asserts
    the SECURE outcome: an unlinked caregiver cannot inject a conversation
    turn into another elder's agent memory."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        caregiver = supabase.user_client(c)
        insert_error: Exception | None = None
        row: dict | None = None
        try:
            rows = await caregiver.insert(
                "conversation_turns",
                {
                    "elder_id": e2,
                    "speaker": "user",
                    "transcript": "track-e conversation_turns probe",
                },
            )
            row = rows[0] if rows else None
        except PostgrestError as exc:
            insert_error = exc

        landed = await supabase.service_client().select(
            "conversation_turns", columns="id", filters={"elder_id": f"eq.{e2}"}
        )

        assert insert_error is not None or row is None, (
            "VULNERABILITY CONFIRMED (conversation_turns-insert): an unlinked "
            f"caregiver's INSERT for another elder returned a row: {row!r}"
        )
        assert landed == [], (
            "VULNERABILITY CONFIRMED (conversation_turns-insert): a "
            f"conversation_turns row for an unlinked elder landed: {landed!r}"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


async def test_conversation_turns_unlinked_caregiver_cannot_update(supabase):
    """Same shape as the refills update probe, for conversation_turns. Asserts
    the SECURE outcome: the seeded transcript survives unchanged."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        seeded = await supabase.service_client().insert(
            "conversation_turns",
            {
                "elder_id": e2,
                "speaker": "user",
                "transcript": "track-e original transcript",
            },
        )
        turn_id = seeded[0]["id"]

        caregiver = supabase.user_client(c)
        update_result: list | None = None
        update_error: Exception | None = None
        try:
            update_result = await caregiver.update(
                "conversation_turns",
                {"transcript": "track-e tampered transcript"},
                filters={"id": f"eq.{turn_id}"},
            )
        except PostgrestError as exc:
            update_error = exc

        current = await supabase.service_client().select(
            "conversation_turns", columns="transcript", filters={"id": f"eq.{turn_id}"}
        )
        unchanged = (
            bool(current) and current[0]["transcript"] == "track-e original transcript"
        )

        assert unchanged, (
            "VULNERABILITY CONFIRMED (conversation_turns-update): an unlinked "
            f"caregiver's UPDATE altered another elder's conversation turn "
            f"(update_result={update_result!r}, update_error={update_error!r}, "
            f"row now={current!r})"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


async def test_conversation_turns_linked_caregiver_can_insert_and_update(supabase):
    """Positive control: C linked to E1 can INSERT and UPDATE E1's
    conversation_turns rows."""
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        caregiver = supabase.user_client(c)
        inserted = await caregiver.insert(
            "conversation_turns",
            {
                "elder_id": e1,
                "speaker": "user",
                "transcript": "track-e original transcript",
            },
        )
        assert inserted, (
            "linked caregiver should be able to insert a conversation turn for their elder"
        )
        turn_id = inserted[0]["id"]

        updated = await caregiver.update(
            "conversation_turns",
            {"transcript": "track-e updated transcript"},
            filters={"id": f"eq.{turn_id}"},
        )
        assert updated and updated[0]["transcript"] == "track-e updated transcript", (
            "linked caregiver should be able to update their elder's conversation turn"
        )
    finally:
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# --- profiles ------------------------------------------------------------------


async def test_profiles_insert_with_arbitrary_id_is_rejected(supabase):
    """Suspected-safe: profiles_insert_self's with_check is `auth.uid() = id`.
    User A should not be able to INSERT a profiles row whose id is some other
    (unclaimed) user's auth id. The victim id is a bare auth.users row with NO
    pre-existing profiles row, so a primary-key conflict can't be confused with
    the RLS rejection this test is actually probing. Asserts the SECURE
    outcome: rejected, or at least never lands."""
    a = await _create_disposable_profile(supabase, "elder")
    victim = await _create_disposable_auth_user(supabase, "victim")
    try:
        a_client = supabase.user_client(a)
        insert_error: Exception | None = None
        row: dict | None = None
        try:
            rows = await a_client.insert(
                "profiles",
                {"id": victim, "role": "elder", "full_name": "track-e forged profile"},
            )
            row = rows[0] if rows else None
        except PostgrestError as exc:
            insert_error = exc

        landed = await supabase.service_client().select(
            "profiles", columns="id", filters={"id": f"eq.{victim}"}
        )

        assert insert_error is not None or row is None, (
            "VULNERABILITY CONFIRMED (profiles-insert): user A inserted a "
            f"profiles row with an id they do not own: row={row!r}"
        )
        assert landed == [], (
            "VULNERABILITY CONFIRMED (profiles-insert): a forged profiles row "
            f"landed for an id user A does not own: {landed!r}"
        )
    finally:
        await _delete_disposable_profile(supabase, a)
        await _delete_disposable_profile(supabase, victim)


async def test_linked_caregiver_cannot_update_elders_profile(supabase):
    """Suspected-safe: profiles_update_self's using/with_check are both
    `auth.uid() = id` — there is no owner-or-caregiver clause on profiles'
    UPDATE policy (unlike medications/doses/refills/etc), so even an ACTIVELY
    linked caregiver should have zero write effect on their elder's profile
    row. Asserts the SECURE outcome: the elder's profile survives unchanged."""
    e = await _create_disposable_profile(supabase, "elder")
    c = await _create_disposable_profile(supabase, "caregiver")
    try:
        await supabase.service_client().insert(
            "care_links", {"elder_id": e, "caregiver_id": c, "status": "active"}
        )
        baseline = await supabase.service_client().select(
            "profiles", columns="full_name", filters={"id": f"eq.{e}"}
        )
        baseline_name = baseline[0]["full_name"]

        caregiver = supabase.user_client(c)
        update_result: list | None = None
        update_error: Exception | None = None
        try:
            update_result = await caregiver.update(
                "profiles",
                {"full_name": "track-e tampered elder name"},
                filters={"id": f"eq.{e}"},
            )
        except PostgrestError as exc:
            update_error = exc

        current = await supabase.service_client().select(
            "profiles", columns="full_name", filters={"id": f"eq.{e}"}
        )
        unchanged = bool(current) and current[0]["full_name"] == baseline_name

        assert unchanged, (
            "VULNERABILITY CONFIRMED (profiles-update): a linked caregiver was "
            f"able to modify their elder's profile row (update_result="
            f"{update_result!r}, update_error={update_error!r}, "
            f"row now={current!r})"
        )
    finally:
        await _delete_disposable_profile(supabase, c)
        await _delete_disposable_profile(supabase, e)


async def test_linked_caregiver_can_read_elders_profile(supabase):
    """Positive control: profiles_select_self_or_caregiver DOES grant a linked
    caregiver read access to their elder's profile — confirms the write-side
    denial above is a targeted gap, not a wholesale RLS misconfiguration that
    would also (wrongly) block reads."""
    e = await _create_disposable_profile(supabase, "elder")
    c = await _create_disposable_profile(supabase, "caregiver")
    try:
        await supabase.service_client().insert(
            "care_links", {"elder_id": e, "caregiver_id": c, "status": "active"}
        )
        caregiver = supabase.user_client(c)
        rows = await caregiver.select(
            "profiles", columns="id,full_name", filters={"id": f"eq.{e}"}
        )
        assert rows and rows[0]["id"] == e, (
            "linked caregiver should be able to read their elder's profile"
        )
    finally:
        await _delete_disposable_profile(supabase, c)
        await _delete_disposable_profile(supabase, e)


async def test_care_links_self_grant_active_is_rejected(supabase):
    """Suspected bug: care_links_insert_as_caregiver's `with check (auth.uid() =
    caregiver_id)` has no consent/status constraint, and `status` defaults to
    'active'. So any authenticated caregiver should be able to self-grant an
    ACTIVE link to an elder who never consented, and immediately gain RLS-granted
    read access to that elder's medications. This test asserts the SECURE
    behaviour (insert rejected, or at least not landing as 'active', or — if it
    does — that the attacker still can't read the victim's data). Expected result
    right now: FAILS, because the vulnerability is real and unfixed."""
    victim_elder = await _create_disposable_profile(supabase, "elder")
    attacker_caregiver = await _create_disposable_profile(supabase, "caregiver")
    try:
        await supabase.service_client().insert(
            "medications",
            {"elder_id": victim_elder, "name": "track-a blast-radius probe"},
        )

        attacker = supabase.user_client(attacker_caregiver)
        insert_error: Exception | None = None
        row: dict | None = None
        try:
            rows = await attacker.insert(
                "care_links",
                {
                    "elder_id": victim_elder,
                    "caregiver_id": attacker_caregiver,
                    "status": "active",
                },
            )
            row = rows[0] if rows else None
        except PostgrestError as exc:
            insert_error = exc

        self_granted_active = row is not None and row.get("status") == "active"

        leaked_meds: list = []
        if self_granted_active:
            leaked_meds = await attacker.select(
                "medications",
                columns="id,name",
                filters={"elder_id": f"eq.{victim_elder}"},
            )

        assert insert_error is not None or not self_granted_active, (
            "VULNERABILITY CONFIRMED (care_links-insert): "
            "care_links_insert_as_caregiver allowed an unlinked caregiver to "
            f"self-grant an ACTIVE care_links row with zero elder consent "
            f"(inserted row={row!r}); blast radius — the attacker's own "
            f"user_client could then read {len(leaked_meds)} of the victim "
            f"elder's medication row(s) via RLS: {leaked_meds!r}."
        )
    finally:
        await _delete_disposable_profile(supabase, attacker_caregiver)
        await _delete_disposable_profile(supabase, victim_elder)


async def test_care_links_caregiver_cannot_self_reactivate(supabase):
    """Suspected bug: care_links_update_party's `using`/`with check` are both
    `(auth.uid() = elder_id or auth.uid() = caregiver_id)` with no restriction
    on which party may perform which status transition. So after an elder
    revokes a caregiver (status='revoked'), the same caregiver should be able to
    PATCH the row back to 'active' themselves. This test asserts the SECURE
    behaviour (the caregiver-initiated reactivation has no effect). Expected
    result right now: FAILS, because the vulnerability is real and unfixed."""
    elder = await _create_disposable_profile(supabase, "elder")
    caregiver = await _create_disposable_profile(supabase, "caregiver")
    try:
        created = await supabase.service_client().insert(
            "care_links",
            {"elder_id": elder, "caregiver_id": caregiver, "status": "revoked"},
        )
        link_id = created[0]["id"]

        caregiver_client = supabase.user_client(caregiver)
        update_result: list | None = None
        update_error: Exception | None = None
        try:
            update_result = await caregiver_client.update(
                "care_links",
                {"status": "active"},
                filters={"id": f"eq.{link_id}"},
            )
        except PostgrestError as exc:
            update_error = exc

        current = await supabase.service_client().select(
            "care_links", columns="status", filters={"id": f"eq.{link_id}"}
        )
        now_active = bool(current) and current[0]["status"] == "active"

        assert not now_active, (
            "VULNERABILITY CONFIRMED (care_links-update): "
            "care_links_update_party places no restriction on which party may "
            "perform which status transition — the revoked caregiver "
            f"reactivated their own link (update_result={update_result!r}, "
            f"update_error={update_error!r}, row now={current!r})."
        )
    finally:
        await _delete_disposable_profile(supabase, caregiver)
        await _delete_disposable_profile(supabase, elder)


# --- Pure HTTP: no Supabase needed, same in-process ASGI pattern as
# tests/test_ratelimit.py / tests/test_api_agent_turn.py. -------------------

_RAW_PYJWT_LEAK_SUBSTRINGS = (
    "Signature",
    "signature",
    "decode",
    "jwt.exceptions",
    "invalid jwt: ",
    "DecodeError",
)


async def test_jwt_invalid_error_detail_is_generic(monkeypatch):
    """Suspected bug: routes.py's `raise HTTPException(status_code=401,
    detail=f"invalid jwt: {exc}")` echoes the raw PyJWT exception string back to
    the caller. This test asserts the SECURE behaviour (a generic 401 body with
    no raw exception leakage). Expected result right now: FAILS, since the real
    code echoes the raw exception verbatim."""
    from fakes import FakeSupabase
    from hermes.api import routes
    from hermes.main import create_app
    from hermes.ratelimit import SlidingWindowLimiter

    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        return "ok", [], history or []

    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        resp = await c.post(
            "/agent/turn", json={"message": "hi", "jwt": "not-a-real-jwt"}
        )

    assert resp.status_code == 401
    body = resp.text
    leaked = [s for s in _RAW_PYJWT_LEAK_SUBSTRINGS if s in body]
    assert not leaked, (
        "VULNERABILITY CONFIRMED (jwt-error-detail): the 401 response body "
        f"leaks raw PyJWT exception internals: {leaked!r} found in body={body!r}"
    )
