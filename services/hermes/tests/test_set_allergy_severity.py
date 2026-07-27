"""set_allergy_severity — propose→confirm grade on a SAVED allergy.

The commit promotes accessibility.allergies in place: every legacy plain-string
entry becomes {"name", "severity"} (order/names preserved) before the matching
entry's severity is set. entity_id is the documented slug so the frontend can
target data-testid="allergy-{slug}".
"""

from __future__ import annotations

from fakes import FakeDB
from helpers import reread_rows
from hermes.tools.base import get_handler
from hermes.tools.profile import _allergy_slug
from test_tools import ELDER_A, _ctx


def _db(allergies: list | None = None) -> FakeDB:
    return FakeDB({"profiles": [{
        "id": ELDER_A,
        "accessibility": {
            "medical_profile": "Has diabetes.",
            "allergies": list(allergies if allergies is not None
                              else ["Penicillin G", "Aspirin"]),
        },
    }]})


def test_slug_rule_matches_the_documented_contract():
    # lowercase, keep [a-z0-9], any run of other chars → single "-", trim "-".
    assert _allergy_slug("Penicillin G") == "penicillin-g"
    assert _allergy_slug("  Tree nut (all)  ") == "tree-nut-all"
    assert _allergy_slug("Aspirin") == "aspirin"
    assert _allergy_slug("Bee/Wasp stings!") == "bee-wasp-stings"


async def test_propose_stashes_and_writes_nothing():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("set_allergy_severity")(
        ctx, allergy="penicillin g", severity="severe"
    )
    assert "PROPOSED" in out and "severe" in out
    assert ctx.session.pending_bulk == {
        "tool": "set_allergy_severity",
        "items": [{"allergy": "penicillin g", "severity": "severe"}],
    }
    assert ctx.session.awaiting_confirmation is True
    assert not db.updated and not ctx.committed_actions
    # Independent re-read: the legacy string list is untouched by a propose.
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    assert rows[0]["accessibility"]["allergies"] == ["Penicillin G", "Aspirin"]


async def test_confirm_promotes_every_entry_and_sets_severity():
    db = _db()
    ctx = _ctx(db)
    tool = get_handler("set_allergy_severity")
    await tool(ctx, allergy="penicillin g", severity="severe")
    out = await tool(ctx, allergy="penicillin g", severity="severe", confirmed=True)
    assert "Saved" in out and "severe" in out

    # Independent re-read: EVERY entry promoted to the dict shape, order and
    # names preserved; only the matched entry gained a severity.
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    access = rows[0]["accessibility"]
    assert access["allergies"] == [
        {"name": "Penicillin G", "severity": "severe"},
        {"name": "Aspirin", "severity": None},
    ]
    assert access["medical_profile"] == "Has diabetes."  # read-merge-write

    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "set_allergy_severity"
    assert action["entity_type"] == "allergy"
    assert action["entity_id"] == "penicillin-g"  # the documented slug
    assert action["name"] == "Penicillin G"
    assert action["changed_fields"] == {
        "severity": {"before": None, "after": "severe"}
    }
    assert ctx.session.pending_bulk is None
    assert ctx.session.awaiting_confirmation is False


async def test_confirm_on_already_promoted_entry_keeps_shape_and_old_value():
    db = _db(allergies=[{"name": "Penicillin G", "severity": "mild"}, "Aspirin"])
    ctx = _ctx(db)
    tool = get_handler("set_allergy_severity")
    await tool(ctx, allergy="Penicillin G", severity="severe")
    await tool(ctx, allergy="Penicillin G", severity="severe", confirmed=True)
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    assert rows[0]["accessibility"]["allergies"] == [
        {"name": "Penicillin G", "severity": "severe"},
        {"name": "Aspirin", "severity": None},
    ]
    # The honest before is the previous grade.
    assert ctx.committed_actions[0]["changed_fields"] == {
        "severity": {"before": "mild", "after": "severe"}
    }


async def test_invalid_severity_rejected_no_stash():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("set_allergy_severity")(
        ctx, allergy="Penicillin G", severity="catastrophic"
    )
    assert "mild, moderate, severe" in out
    assert ctx.session.pending_bulk is None
    assert not db.updated


async def test_unknown_allergy_is_honest_miss_listing_saved_ones():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("set_allergy_severity")(
        ctx, allergy="Latex", severity="severe"
    )
    assert "No allergy named 'Latex'" in out
    assert "Penicillin G" in out and "Aspirin" in out  # lists the saved ones
    assert ctx.session.pending_bulk is None
    assert not db.updated and not ctx.committed_actions


async def test_confirm_without_proposal_refused():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("set_allergy_severity")(
        ctx, allergy="Penicillin G", severity="severe", confirmed=True
    )
    assert "Refused" in out
    assert not db.updated and not ctx.committed_actions
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    assert rows[0]["accessibility"]["allergies"] == ["Penicillin G", "Aspirin"]
