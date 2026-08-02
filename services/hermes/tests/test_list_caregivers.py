"""list_caregivers — "who is my emergency contact?" answered from care_links.

Read-only. The behaviour that matters and is easy to get wrong:
  * a REVOKED link must never leak a name (withdrawn consent),
  * a PENDING link is not a caregiver (only the elder's own tap activates one,
    per 0005_care_links_consent_hardening.sql),
  * an elder cannot read their caregiver's profiles row under
    0002_rls_policies.sql, so the name comes from the link's permissions blob
    and the "no name available" path is a NORMAL path, not an edge case,
  * no phone number exists anywhere in the schema, so the tool must never
    produce one.
"""

from __future__ import annotations

import re

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext

ELDER_A = "00000000-0000-0000-0000-00000000000a"
ELDER_B = "00000000-0000-0000-0000-00000000000b"
CAREGIVER = "00000000-0000-0000-0000-00000000000c"


def _ctx(db: FakeDB, elder_id: str = ELDER_A) -> ToolContext:
    return ToolContext(
        supabase=FakeSupabase(db=db),
        elder_id=elder_id,
        session=SessionState(elder_id=elder_id),
    )


def _link(**over) -> dict:
    row = {
        "id": "link-1",
        "elder_id": ELDER_A,
        "caregiver_id": CAREGIVER,
        "relationship": "daughter",
        "permissions": {},
        "status": "active",
        "created_at": "2026-01-01T00:00:00Z",
    }
    row.update(over)
    return row


async def test_names_an_active_caregiver_from_the_permissions_blob():
    db = FakeDB({"care_links": [
        _link(permissions={"requested_by_name": "Tan Wei Ming", "relationship": "son"})
    ]})
    ctx = _ctx(db)
    out = await get_handler("list_caregivers")(ctx)
    assert "Tan Wei Ming" in out
    assert "son" in out
    # Read-only: nothing committed, so the client never navigates or highlights.
    assert ctx.committed_actions == []


async def test_seeded_link_without_a_name_falls_back_honestly():
    """The common path, not an edge case: seed.sql / provision_hosted.py write a
    permissions blob with no requested_by_name, and RLS forbids the elder from
    reading the caregiver's profiles row to find one."""
    db = FakeDB({"care_links": [
        _link(permissions={"view_meds": True}, relationship="daughter")
    ]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "name not recorded" in out
    assert "daughter" in out
    # Must NOT have gone looking in profiles — the elder cannot read that row,
    # so a select there is dead code that only LOOKS like it works.
    assert not any(table == "profiles" for table, *_ in db.inserted)


async def test_blank_requested_by_name_is_treated_as_missing():
    db = FakeDB({"care_links": [_link(permissions={"requested_by_name": "   "})]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "name not recorded" in out


async def test_permissions_relationship_wins_over_the_stale_column():
    """careLinks.ts's re-arm path updates only {status, permissions}, so the
    top-level relationship column can be stale."""
    db = FakeDB({"care_links": [
        _link(
            relationship="son",
            permissions={"requested_by_name": "A", "relationship": "daughter"},
        )
    ]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "daughter" in out
    assert "son" not in out


async def test_revoked_link_never_leaks_a_name():
    db = FakeDB({"care_links": [
        _link(status="revoked", permissions={"requested_by_name": "Tan Wei Ming"})
    ]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "Tan Wei Ming" not in out
    assert "No caregiver is linked" in out


async def test_pending_link_is_reported_as_waiting_not_as_a_caregiver():
    db = FakeDB({"care_links": [
        _link(status="pending", permissions={"requested_by_name": "Tan Wei Ming"})
    ]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "waiting" in out
    assert "No caregiver is linked to this account yet" in out
    assert "accept_caregiver_link" in out


async def test_no_links_at_all_says_so_plainly_and_offers_the_walkthrough():
    out = await get_handler("list_caregivers")(_ctx(FakeDB({"care_links": []})))
    assert "No caregiver is linked" in out
    assert "link_caregiver" in out


async def test_two_active_caregivers_are_both_named_with_a_count():
    db = FakeDB({"care_links": [
        _link(id="l1", permissions={"requested_by_name": "Wei Ming", "relationship": "son"}),
        _link(id="l2", permissions={"requested_by_name": "Siew Ling", "relationship": "daughter"}),
    ]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "Wei Ming" in out and "Siew Ling" in out
    assert "(2)" in out


async def test_caregiver_direction_lists_their_patients_from_profiles():
    """Rows on caregiver_id mean "these are my patients". Here the profiles read
    IS permitted (is_linked_caregiver is true for an active link)."""
    db = FakeDB({
        "care_links": [_link(elder_id=ELDER_B, caregiver_id=ELDER_A, relationship="daughter")],
        "profiles": [{"id": ELDER_B, "full_name": "Mdm Tan"}],
    })
    out = await get_handler("list_caregivers")(_ctx(db, elder_id=ELDER_A))
    assert "Mdm Tan" in out
    assert "caregiver for" in out
    # Not misreported as a caregiver FOR them.
    assert "Caregivers linked to this account" not in out


async def test_never_produces_anything_shaped_like_a_phone_number():
    db = FakeDB({"care_links": [
        _link(permissions={"requested_by_name": "Tan Wei Ming", "relationship": "son"})
    ]})
    out = await get_handler("list_caregivers")(_ctx(db))
    assert "no phone number" in out.lower()
    assert not re.search(r"\d[\d\s\-]{6,}", out)


async def test_db_failure_degrades_softly_instead_of_raising():
    class Boom(FakeDB):
        async def select(self, *a, **k):
            raise RuntimeError("postgrest down")

    out = await get_handler("list_caregivers")(_ctx(Boom()))
    assert "couldn't check" in out
    assert "guess" in out
