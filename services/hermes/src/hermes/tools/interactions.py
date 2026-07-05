"""Grounded drug-interaction checks: check_drug_interactions.

Answers "can I take X with Y?" from the OpenFDA label's interaction section (via
``drug_info.interaction_text``) — the same grounded source used at prescription
propose time, now exposed as a tool the agent can call for a direct question. When
no second drug is given, it cross-references the elder's current medications.

Informational only: it reports what the label says, never a clinical judgement.
"""

from __future__ import annotations

from .base import ToolContext, register
from .drug_info import interaction_text

_SCHEMA = {
    "name": "check_drug_interactions",
    "description": (
        "Check for drug interactions from grounded OpenFDA label data. Use for any "
        "'can I take X with Y?' or 'does X interact with anything I take?' question. "
        "Pass drug_a and optionally drug_b; if drug_b is omitted, it checks drug_a "
        "against the patient's current medications. Informational only — never a "
        "diagnosis; if anything looks concerning, offer add_doctor_question."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "drug_a": {"type": "string", "description": "First drug name."},
            "drug_b": {
                "type": "string",
                "description": "Second drug name. Omit to check against current meds.",
            },
        },
        "required": ["drug_a"],
    },
}


async def _mentions(text: str, name: str) -> bool:
    return bool(name.strip()) and name.strip().lower() in text.lower()


async def check_drug_interactions(
    ctx: ToolContext, drug_a: str, drug_b: str | None = None
) -> str:
    text_a = await interaction_text(ctx, drug_a)

    if drug_b:
        # Check both directions: does A's label mention B, or B's label mention A?
        text_b = await interaction_text(ctx, drug_b)
        if not text_a and not text_b:
            return (
                f"OpenFDA has no interaction section for {drug_a} or {drug_b}, so I "
                "can't confirm either way. Tell the patient this isn't a clearance — "
                "offer to queue the question for their doctor (add_doctor_question)."
            )
        hit = await _mentions(text_a, drug_b) or await _mentions(text_b, drug_a)
        if hit:
            return (
                f"⚠ OpenFDA's interaction notes flag a possible interaction between "
                f"{drug_a} and {drug_b}. This is not medical advice — the patient "
                "should check with their doctor or pharmacist before taking them "
                "together (offer add_doctor_question). (Source: OpenFDA.)"
            )
        return (
            f"OpenFDA's interaction notes for {drug_a}/{drug_b} don't specifically "
            "mention the other drug. That is not a guarantee they're safe together — "
            "remind the patient to confirm with their doctor or pharmacist. "
            "(Source: OpenFDA.)"
        )

    # No drug_b: cross-reference against the elder's current medications.
    if not text_a:
        return (
            f"OpenFDA has no interaction section on file for {drug_a}, so I can't "
            "check it against the patient's medicines. Offer to queue a question for "
            "the doctor (add_doctor_question)."
        )
    current = await ctx.db().select(
        "medications", columns="name", filters={"archived": "eq.false"}
    )
    names = sorted(
        {(m.get("name") or "").strip() for m in current}
        - {"", drug_a.strip()},
        key=str.lower,
    )
    hits = [n for n in names if await _mentions(text_a, n)]
    if hits:
        return (
            f"⚠ OpenFDA's interaction notes for {drug_a} mention "
            f"{', '.join(hits)}, which the patient already takes. Not medical advice "
            "— the patient should flag this with their doctor before combining them "
            "(offer add_doctor_question). (Source: OpenFDA.)"
        )
    return (
        f"OpenFDA's interaction notes for {drug_a} don't mention any of the "
        "patient's current medicines. That isn't a full safety clearance — suggest "
        "confirming with their doctor or pharmacist. (Source: OpenFDA.)"
    )


register(_SCHEMA, check_drug_interactions)
