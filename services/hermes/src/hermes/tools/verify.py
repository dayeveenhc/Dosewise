"""Verify tools: read-only re-queries that PROVE a write actually landed.

The Guided Auto-Navigation walkthrough (apps/web) has Mei drive a write herself,
then call a ``verify_*`` tool to re-query the REAL state as the elder (RLS) and
confirm the change is really there — never trusting the write call's own "Saved"
message. A verify tool is strictly read-only: it does NOT append to
``ctx.committed_actions`` (same precedent as ``walkthrough.py``).

This module ships the flagship check, ``verify_medication_exists``. Later
scenario batches add siblings (``verify_profile_field``,
``verify_care_link_pending``, …) following the same ``VerifyResult`` shape and
``render()`` contract, so the "re-query real state → structured pass/fail"
pattern is defined once here and reused.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .base import ToolContext, find_medications, register


@dataclass
class VerifyResult:
    """Structured outcome of a re-queried write. ``render()`` is the plain-text
    string the tool returns to the model; callers and tests read ``passed``
    directly. The ``VERIFIED`` / ``NOT FOUND`` prefix is a stable machine- and
    model-legible signal — don't reword it without updating both."""

    passed: bool
    detail: str
    matched: list[dict] = field(default_factory=list)

    def render(self) -> str:
        return f"{'VERIFIED' if self.passed else 'NOT FOUND'}: {self.detail}"


async def check_medication_exists(ctx: ToolContext, name: str) -> VerifyResult:
    """Re-query the elder's live (non-archived) medications for one by name.

    Case-insensitive but EXACT — a partial name ('Met') must not count as
    present ('Metformin'), so a substring hit can't be mistaken for the real
    write landing. (Real PostgREST ``ilike`` with no wildcards is already an
    exact case-insensitive compare; the Python guard makes it exact regardless
    of the query double's looser substring semantics.)
    """
    wanted = (name or "").strip()
    if not wanted:
        return VerifyResult(passed=False, detail="No medication name was given to verify.")
    rows = await find_medications(ctx, wanted, columns="name,dosage,schedule", limit=None)
    exact = [r for r in rows if (r.get("name") or "").strip().lower() == wanted.lower()]
    if exact:
        n = len(exact)
        return VerifyResult(
            passed=True,
            detail=f"'{wanted}' is on the medication list ({n} "
            f"{'entry' if n == 1 else 'entries'}).",
            matched=exact,
        )
    return VerifyResult(
        passed=False,
        detail=f"No medication named '{wanted}' is on the list — the write did not land.",
    )


_SCHEMA = {
    "name": "verify_medication_exists",
    "description": (
        "Re-check that a medication is REALLY on the elder's list by re-querying "
        "the database, after an add or change you believe succeeded. Use this to "
        "confirm a write actually landed before telling the user it's done — never "
        "rely on the add/change tool's own 'Saved' message alone. Returns VERIFIED "
        "with a count, or NOT FOUND if the medication isn't there."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Medication name to confirm is on the list.",
            },
        },
        "required": ["name"],
    },
}


async def verify_medication_exists(ctx: ToolContext, name: str) -> str:
    result = await check_medication_exists(ctx, name)
    return result.render()


register(_SCHEMA, verify_medication_exists)
