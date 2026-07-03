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

import pytest

from hermes.db.supabase import Supabase

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
