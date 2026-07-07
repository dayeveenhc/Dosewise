"""Grounded drug-interaction checks: check_drug_interactions.

Answers "can I take X with Y?" from the OpenFDA label's interaction section (via
``drug_info.interaction_text``) — the same grounded source used at prescription
propose time, now exposed as a tool the agent can call for a direct question. When
no second drug is given, it cross-references the elder's current medications.

Informational only: it reports what the label says, never a clinical judgement.
"""

from __future__ import annotations

from .base import ToolContext, register
from .drug_info import interaction_text, label_mentions

_SCHEMA = {
    "name": "check_drug_interactions",
    "description": (
        "Check for drug interactions from grounded OpenFDA label data. Use for any "
        "'can I take X with Y?' or 'does X interact with anything I take?' question. "
        "Pass drug_a and optionally drug_b; if drug_b is omitted, it checks drug_a "
        "against the patient's current medications. Answer plainly from what it "
        "returns; offer add_doctor_question only when an interaction is flagged or "
        "the check couldn't run."
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


async def check_drug_interactions(
    ctx: ToolContext, drug_a: str, drug_b: str | None = None
) -> str:
    text_a = await interaction_text(ctx, drug_a)

    if drug_b:
        # Check both directions: does A's label mention B (under any of its name
        # forms — brand or generic), or B's label mention A?
        text_b = await interaction_text(ctx, drug_b)
        if not text_a and not text_b:
            # The check genuinely couldn't run — this is the case for a doctor.
            return (
                f"OpenFDA has no interaction section for {drug_a} or {drug_b}, so I "
                "can't confirm either way. Tell the patient this isn't a clearance — "
                "offer to queue the question for their doctor (add_doctor_question)."
            )
        hit = label_mentions(text_a, drug_b) or label_mentions(text_b, drug_a)
        if hit:
            return (
                f"⚠ OpenFDA's interaction notes flag a possible interaction between "
                f"{drug_a} and {drug_b}. Informational, not medical clearance — worth "
                "flagging with their doctor (offer add_doctor_question). "
                "(Source: OpenFDA.)"
            )
        return (
            f"OpenFDA's interaction notes for {drug_a}/{drug_b} don't specifically "
            "mention the other drug. Informational, not a full clearance. Tell the "
            "patient plainly what the label says. (Source: OpenFDA.)"
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
    hits = [n for n in names if label_mentions(text_a, n)]
    if hits:
        return (
            f"⚠ OpenFDA's interaction notes for {drug_a} mention "
            f"{', '.join(hits)}, which the patient already takes. Informational, not "
            "medical clearance — worth flagging with their doctor "
            "(offer add_doctor_question). (Source: OpenFDA.)"
        )
    return (
        f"OpenFDA's interaction notes for {drug_a} don't mention any of the "
        "patient's current medicines. Informational, not a full clearance. Tell the "
        "patient plainly what the label says. (Source: OpenFDA.)"
    )


register(_SCHEMA, check_drug_interactions)
