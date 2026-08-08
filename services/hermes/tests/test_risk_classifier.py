"""Adversarial coverage for the RiskClassifier (``risk.py::assess_risk``) —
cross-cutting decision A of the Ask Mei walkthrough plan
(``for-the-ask-mei-iterative-wall.md``, Item 3).

Three required directions, each a real pytest test against the classifier
itself (not just its wiring into start_walkthrough, which test_walkthrough.py
covers separately):
  1. a deliberately RISKY instance -> flagged=True, with a reason naming the
     actual signal that fired.
  2. a deliberately ORDINARY instance -> flagged=False.
  3. a deliberately UNPARSEABLE/malformed dosage -> flagged=True — the
     required inversion of medications.py's own ``_dosage_warning``, which
     fails OPEN on the exact same input. See ``dosage_ratio``'s docstring
     (base.py) for why the two callers need opposite biases.

Everything below the three-direction section is additional, non-required
coverage proving each of the classifier's other individual signals in
isolation (irreversible task, low-confidence fuzzy match, schedule-time
delta, a DB-lookup failure also failing closed, the stringified-"times"
false-positive trap, and the always-flags-a-brand-new-drug tradeoff named
explicitly rather than left as an implicit side effect).
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext
from hermes.tools.risk import assess_risk
from hermes.tools.walkthrough import IRREVERSIBLE_AUTO_TASKS

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB) -> ToolContext:
    supa = FakeSupabase(db=db)
    return ToolContext(supabase=supa, elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A))


def _existing_metformin(**overrides) -> FakeDB:
    row = {
        "name": "Metformin",
        "dosage": "500mg",
        "archived": False,
        "schedule": {"times": ["08:00", "20:00"]},
    }
    row.update(overrides)
    return FakeDB({"medications": [row]})


# === Required direction 1: a deliberately RISKY instance flags, naming the
# === actual signal that fired (checked via the stable "signals" code, not by
# === substring-matching the human-readable "reasons" prose). ===============


async def test_risky_dosage_jump_on_existing_medication_flags():
    """A >=2x dose jump against an existing same-name medication must flag,
    naming the dosage-jump signal specifically (no other signal should also
    fire for an otherwise-clean exact-match instance)."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(
        ctx, "add_prescription_auto", {"name": "Metformin", "dose": "1500mg"}
    )
    assert result["flagged"] is True
    assert result["signals"] == ["dosage_jump"]
    assert any("3x" in r and "Metformin" in r for r in result["reasons"]), result["reasons"]


async def test_risky_zero_match_medication_name_flags():
    """The other RISKY shape the ask names explicitly: a medication name with
    zero match against the patient's profile at any find_medications tier."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(
        ctx, "add_prescription_auto", {"name": "Zzyzxprinol", "dose": "10mg"}
    )
    assert result["flagged"] is True
    assert "unknown_medication" in result["signals"]
    assert any(
        "does not match any medication" in r for r in result["reasons"]
    ), result["reasons"]


# === Required direction 2: a deliberately ORDINARY instance does not flag. =


async def test_ordinary_instance_does_not_flag():
    """Small dose change, exact-match name, non-irreversible task, in-range
    time — every individual signal clean, so the whole assessment is clean."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(
        ctx,
        "add_prescription_auto",
        {"name": "Metformin", "dose": "550mg", "time": "08:15"},
        irreversible_tasks=IRREVERSIBLE_AUTO_TASKS,
    )
    assert result == {"flagged": False, "signals": [], "reasons": []}


async def test_ordinary_task_with_no_medication_reference_does_not_flag():
    """End-to-end via the real start_walkthrough dispatch (not just the bare
    classifier): a task whose params carry no medication name at all trivially
    clears every medication-scoped signal."""
    tool = get_handler("start_walkthrough")
    ctx = _ctx(FakeDB({}))
    await tool(ctx, task_name="add_condition_auto", params={"condition": "Diabetes"})
    assert ctx.walkthrough["risk"] == {"flagged": False, "signals": [], "reasons": []}


# === Required direction 3: an unparseable/malformed dosage FAILS CLOSED —
# === the deliberate inversion of _dosage_warning's own fail-open bias. ======


async def test_unparseable_dosage_flags_fail_closed():
    """medications.py's own ``_dosage_warning`` fails OPEN on an unparseable
    dosage (never blocks a save on a caveat it can't compute — see
    test_dosage_warning.py's ``test_dosage_warning_non_numeric_or_missing_
    fails_open``). The risk classifier must do the OPPOSITE: an unparseable
    or incomparable dosage is exactly the kind of thing a human should see
    before it commits, so it FLAGS, naming the dosage as the reason."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(
        ctx, "add_prescription_auto", {"name": "Metformin", "dose": "some pills"}
    )
    assert result["flagged"] is True
    assert result["signals"] == ["dosage_unparseable"]
    assert any("could not be parsed" in r for r in result["reasons"]), result["reasons"]


async def test_unparseable_dosage_word_tbd_also_flags():
    """A second unparseable shape ("TBD") — proves this isn't a fluke of one
    specific string; matches the ask's own example malformed values."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(ctx, "add_prescription_auto", {"name": "Metformin", "dose": "TBD"})
    assert result["flagged"] is True
    assert result["signals"] == ["dosage_unparseable"]
    assert any("could not be parsed" in r for r in result["reasons"]), result["reasons"]


# === Additional axis coverage (not required by the 3 directions above, but
# === each signal the classifier promises gets its own direct proof). =======


async def test_low_confidence_fuzzy_match_flags():
    """Resolving via the wildcard/suffix tier rather than an exact match is
    its own distinct flag — separate from "not recognized" and "dosage jump"."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(ctx, "add_prescription_auto", {"name": "Metf"})
    assert result["flagged"] is True
    assert result["signals"] == ["fuzzy_match"]
    assert any("fuzzy" in r for r in result["reasons"]), result["reasons"]


async def test_schedule_time_far_off_file_flags():
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(ctx, "add_prescription_auto", {"name": "Metformin", "time": "15:00"})
    assert result["flagged"] is True
    assert result["signals"] == ["schedule_drift"]
    assert any(
        "more than" in r and "off every time" in r for r in result["reasons"]
    ), result["reasons"]


async def test_schedule_time_within_range_does_not_flag():
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(ctx, "add_prescription_auto", {"name": "Metformin", "time": "08:15"})
    assert result["flagged"] is False


async def test_schedule_time_key_ignores_stringified_multi_value_shape():
    """Regression: start_walkthrough stringifies every param value, so a
    hypothetical list-valued "times" param would arrive here as a Python list
    repr ("['08:00', '20:00']") — unparseable, and if this module treated
    "times" as a recognized key that would falsely flag an entirely ordinary
    multi-dose schedule. Only "time" (singular) is a recognized key today, so
    this must resolve clean regardless of what "times" holds."""
    ctx = _ctx(_existing_metformin())
    result = await assess_risk(
        ctx,
        "add_prescription_auto",
        {"name": "Metformin", "times": "['08:00', '20:00']"},
    )
    assert result == {"flagged": False, "signals": [], "reasons": []}


async def test_irreversible_task_always_flags_regardless_of_other_signals():
    ctx = _ctx(FakeDB({}))
    result = await assess_risk(
        ctx, "some_future_auto", {}, irreversible_tasks=frozenset({"some_future_auto"})
    )
    assert result["flagged"] is True
    assert result["signals"] == ["irreversible_task"]
    assert any("irreversible write" in r for r in result["reasons"]), result["reasons"]


async def test_lookup_failure_fails_closed():
    """A find_medications lookup that raises must count as a flag for that
    axis, not a silent pass — matching this module's fail-closed philosophy
    (the opposite bias from this codebase's other best-effort lookups, e.g.
    ``_existing_medication``, which fail open on any error)."""

    class _ExplodingDB:
        async def select(self, *_args, **_kwargs):
            raise RuntimeError("db unavailable")

    ctx = ToolContext(
        supabase=FakeSupabase(db=_ExplodingDB()),
        elder_id=ELDER_A,
        session=SessionState(elder_id=ELDER_A),
    )
    result = await assess_risk(ctx, "add_prescription_auto", {"name": "Metformin"})
    assert result["flagged"] is True
    assert result["signals"] == ["unknown_medication"]


async def test_brand_new_medication_always_flags_unknown_name():
    """NAMED, deliberate product-level consequence of decision A's literal
    rule ("0 matches at any fuzzy tier = flag") — not a bug, but load-bearing
    enough to need its own findable test rather than living as a side effect
    of an unrelated wiring test.

    add_prescription_auto's whole purpose is adding a drug NOT yet on the
    patient's list — so ``unknown_medication`` fires on essentially every
    real dispatch of the single most common *_auto task, and since risk always
    overrides trust (decision C), that means the Confirm-phase veteran
    auto-proceed path is effectively dead for add_prescription_auto for every
    user, forever — an add of a genuinely ordinary, expected, brand-new
    medication is indistinguishable here from a mis-heard/hallucinated name.
    This was NOT special-cased away: decision A's text is unconditional, and
    the "signals" list (this module) is exactly what would let a future
    product decision treat a bare ``unknown_medication`` on add_prescription_
    auto differently from the same signal on a task that references an
    EXISTING medication — with zero backend change required. If that product
    call is made, THIS test is the one that should change.
    """
    ctx = _ctx(_existing_metformin())  # Metformin already on file — irrelevant
    result = await assess_risk(
        ctx, "add_prescription_auto", {"name": "Lisinopril", "dose": "10mg"}
    )
    assert result["flagged"] is True
    assert result["signals"] == ["unknown_medication"]
