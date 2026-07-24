"""verify_medication_exists: re-query real state to prove a write landed.

The crux case: a write the tool layer reported as 'Saved' whose row is NOT
actually present on re-query must Verify as NOT FOUND (passed=False), never a
false success. This is the guarantee the whole Guided Auto-Navigation "Verify"
phase rests on.
"""

from __future__ import annotations

from fakes import FakeDB, FakeSupabase
from hermes.tools import get_handler
from hermes.tools.base import ToolContext
from hermes.tools.verify import check_medication_exists

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _ctx(meds: list[dict]) -> ToolContext:
    return ToolContext(supabase=FakeSupabase(db=FakeDB({"medications": meds})), elder_id=ELDER_A)


async def test_verify_passes_when_medication_really_present():
    ctx = _ctx([{"name": "Metformin", "archived": False, "dosage": "500mg"}])
    result = await check_medication_exists(ctx, "Metformin")
    assert result.passed is True
    assert result.matched
    out = await get_handler("verify_medication_exists")(ctx, name="Metformin")
    assert out.startswith("VERIFIED")


async def test_verify_catches_false_success_when_row_absent():
    # The write "succeeded" at the tool layer but nothing actually persisted — the
    # medications table is empty on re-query. Verify must NOT false-succeed.
    ctx = _ctx([])
    result = await check_medication_exists(ctx, "Metformin")
    assert result.passed is False
    out = await get_handler("verify_medication_exists")(ctx, name="Metformin")
    assert out.startswith("NOT FOUND")


async def test_verify_is_case_insensitive_but_not_substring():
    ctx = _ctx([{"name": "Metformin", "archived": False}])
    assert (await check_medication_exists(ctx, "metformin")).passed is True
    # A partial name must NOT count as present (guards against an ilike substring hit).
    assert (await check_medication_exists(ctx, "Met")).passed is False


async def test_verify_ignores_archived_medications():
    ctx = _ctx([{"name": "Metformin", "archived": True}])
    assert (await check_medication_exists(ctx, "Metformin")).passed is False


async def test_verify_rejects_empty_name():
    ctx = _ctx([{"name": "Metformin", "archived": False}])
    assert (await check_medication_exists(ctx, "   ")).passed is False


async def test_verify_is_read_only_no_committed_actions():
    ctx = _ctx([{"name": "Metformin", "archived": False}])
    await get_handler("verify_medication_exists")(ctx, name="Metformin")
    assert ctx.committed_actions == []
