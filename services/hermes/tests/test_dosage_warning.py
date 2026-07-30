"""Dosage-safety warning — offline tests via FakeDB doubles.

"Warn if a dosage might be dangerously high": a caregiver/elder increasing an
existing medication's dose (`update_medication_dosage`), or "adding" a
prescription that's really a disguised dose change (`add_prescription` for a
drug already on file at a different strength), gets a non-blocking ⚠ caution
when the new dose is a big jump above the old one. Pure relative-jump
arithmetic on the two free-text dosage values (no OpenFDA grounding, no LLM
medical judgment) — mirrors `_interaction_warning`'s existing shape: fails
open on anything unparseable, never blocks a save.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.channels.session import SessionState
from hermes.tools import get_handler
from hermes.tools.base import ToolContext, parse_dosage
from hermes.tools.medications import _dosage_warning

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(db: FakeDB, **kw) -> ToolContext:
    supa = FakeSupabase(db=db)
    return ToolContext(
        supabase=supa, elder_id=ELDER_A, session=SessionState(elder_id=ELDER_A), **kw
    )


# --- parse_dosage ------------------------------------------------------------


def test_parse_dosage_recognizes_value_and_unit():
    assert parse_dosage("500mg") == (500.0, "mg")
    assert parse_dosage("500MG") == (500.0, "mg")  # case-insensitive
    assert parse_dosage("2.5 ml") == (2.5, "ml")


def test_parse_dosage_none_for_non_numeric_text():
    assert parse_dosage("2 tablets") is None
    assert parse_dosage("as needed") is None
    assert parse_dosage("") is None
    assert parse_dosage(None) is None


# --- _dosage_warning ----------------------------------------------------------


def test_dosage_warning_large_same_unit_increase_warns():
    out = _dosage_warning("500mg", "1000mg")
    assert "⚠" in out and "500mg" in out and "1000mg" in out


def test_dosage_warning_small_increase_is_silent():
    assert _dosage_warning("500mg", "600mg") == ""


def test_dosage_warning_decrease_is_silent():
    # Direction-only: a lower dose is never "dangerously high".
    assert _dosage_warning("1000mg", "500mg") == ""


def test_dosage_warning_cross_unit_normalizes():
    # 500mcg -> 1mg is exactly 2x once normalized to a common mass unit.
    out = _dosage_warning("500mcg", "1mg")
    assert "⚠" in out


def test_dosage_warning_incomparable_units_fail_open():
    assert _dosage_warning("500mg", "5ml") == ""


def test_dosage_warning_non_numeric_or_missing_fails_open():
    assert _dosage_warning("2 tablets", "4 tablets") == ""
    assert _dosage_warning(None, "1000mg") == ""
    assert _dosage_warning("500mg", None) == ""


# --- update_medication_dosage integration ------------------------------------


async def test_update_dosage_propose_big_jump_warns():
    tool = get_handler("update_medication_dosage")
    db = FakeDB({"medications": [
        {"id": "m1", "name": "Metformin", "dosage": "500mg", "archived": False},
    ]})
    out = await tool(_ctx(db), medication_name="Metformin", dosage="1000mg", confirmed=False)
    assert "⚠" in out and "add_doctor_question" in out


async def test_update_dosage_propose_small_change_no_warning():
    tool = get_handler("update_medication_dosage")
    db = FakeDB({"medications": [
        {"id": "m1", "name": "Metformin", "dosage": "500mg", "archived": False},
    ]})
    out = await tool(_ctx(db), medication_name="Metformin", dosage="550mg", confirmed=False)
    assert "⚠" not in out


async def test_update_dosage_propose_no_prior_dosage_does_not_crash():
    tool = get_handler("update_medication_dosage")
    db = FakeDB({"medications": [
        {"id": "m1", "name": "Metformin", "dosage": None, "archived": False},
    ]})
    out = await tool(_ctx(db), medication_name="Metformin", dosage="1000mg", confirmed=False)
    assert "PROPOSED" in out
    assert "⚠" not in out


# --- add_prescription integration --------------------------------------------


async def test_add_prescription_matching_existing_name_different_dose_warns(monkeypatch):
    import hermes.tools.medications as medications

    async def _no_interaction(ctx, name):
        return ""

    monkeypatch.setattr(medications, "interaction_text", _no_interaction)
    db = FakeDB({"medications": [
        {"name": "Metformin", "dosage": "500mg", "archived": False},
    ]})
    out = await get_handler("add_prescription")(
        _ctx(db), name="Metformin", dosage="2000mg", confirmed=False
    )
    assert "⚠" in out and "500mg" in out and "2000mg" in out


async def test_add_prescription_genuinely_new_drug_no_dosage_warning(monkeypatch):
    import hermes.tools.medications as medications

    async def _no_interaction(ctx, name):
        return ""

    monkeypatch.setattr(medications, "interaction_text", _no_interaction)
    db = FakeDB({"medications": [
        {"name": "Metformin", "dosage": "500mg", "archived": False},
    ]})
    out = await get_handler("add_prescription")(
        _ctx(db), name="Lisinopril", dosage="20mg", confirmed=False
    )
    assert "⚠" not in out


async def test_add_prescription_existing_name_match_is_case_insensitive(monkeypatch):
    import hermes.tools.medications as medications

    async def _no_interaction(ctx, name):
        return ""

    monkeypatch.setattr(medications, "interaction_text", _no_interaction)
    db = FakeDB({"medications": [
        {"name": "metformin", "dosage": "500mg", "archived": False},
    ]})
    out = await get_handler("add_prescription")(
        _ctx(db), name="Metformin", dosage="2000mg", confirmed=False
    )
    assert "⚠" in out
