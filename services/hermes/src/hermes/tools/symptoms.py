"""Symptom journal: add_symptom.

Records what the patient reports feeling — recording is never diagnosis. No
symptoms table exists, so entries land in the ``profiles.accessibility``
jsonb catch-all (``symptom_reports``, read-merge-write) where a caregiver or
doctor review can pick them up later. Immediate write (like
add_doctor_question): a health report should never stall on a confirm
round-trip or on medication-name matching.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from .base import ToolContext, find_medications, record_action, register

_SCHEMA = {
    "name": "add_symptom",
    "description": (
        "Record a symptom the patient reports ('I feel dizzy after my "
        "metformin', 'my stomach hurts'). Saves it to their health notes "
        "immediately — recording is never a diagnosis. Pass medication_name "
        "(bare name) when they linked the feeling to a medicine. For a real "
        "safety emergency use request_human_help instead."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "symptom": {
                "type": "string",
                "description": "What the patient reports feeling, in their words.",
            },
            "medication_name": {
                "type": "string",
                "description": "Bare name of the medicine they linked it to, if any.",
            },
        },
        "required": ["symptom"],
    },
}

# Words that make a symptom worth a gentle "want me to queue a doctor
# question?" nudge in the reply. A hint only — NEVER an automatic escalation.
_SEVERE_HINTS = (
    "chest", "breath", "faint", "collaps", "bleed", "swell", "dizz",
    "vomit", "confus", "fell", "fall", "allergic", "rash", "numb",
)


async def add_symptom(
    ctx: ToolContext, symptom: str, medication_name: str | None = None
) -> str:
    symptom = (symptom or "").strip()
    if not symptom:
        return "Ask the patient what they're feeling, then record it."

    # Best-effort med attachment. A miss or an ambiguous match must NEVER block
    # the health report — keep the free-text name and say so in the reply.
    med_id: str | None = None
    med_label: str | None = None
    unmatched_note = ""
    if medication_name and medication_name.strip():
        meds = await find_medications(
            ctx, medication_name, columns="id,name", limit=None
        )
        distinct: dict[str, dict] = {}
        for m in meds:
            distinct.setdefault((m.get("name") or "").strip().lower(), m)
        if len(distinct) == 1:
            med = next(iter(distinct.values()))
            med_id, med_label = str(med["id"]), med["name"]
        else:
            med_label = medication_name.strip()
            unmatched_note = (
                " (That name didn't match exactly one medication on file, so I "
                "kept it as written.)"
            )

    entry: dict = {
        "id": uuid4().hex,
        "symptom": symptom,
        "noted_at": datetime.now(UTC).isoformat(),
    }
    if med_id is not None:
        entry["medication_id"] = med_id
    if med_label is not None:
        entry["medication_name"] = med_label

    db = ctx.db()
    rows = await db.select(
        "profiles",
        columns="accessibility",
        filters={"id": f"eq.{ctx.elder_id}"},
        limit=1,
    )
    access = dict((rows[0].get("accessibility") if rows else None) or {})
    reports = list(access.get("symptom_reports") or [])
    reports.append(entry)
    access["symptom_reports"] = reports
    await db.update(
        "profiles",
        {"accessibility": access},
        filters={"id": f"eq.{ctx.elder_id}"},
        returning=False,
    )

    extra = {"medication_name": med_label} if med_label else {}
    record_action(
        ctx,
        tool="add_symptom",
        summary=symptom,
        entity_type="symptom",
        entity_id=entry["id"],
        changed_fields={"symptom": {"before": None, "after": symptom}},
        **extra,
    )

    linked = f" after {med_label}" if med_label else ""
    low = symptom.lower()
    nudge = ""
    if any(h in low for h in _SEVERE_HINTS):
        nudge = (
            " That sounds worth a professional's eyes: offer to queue a "
            "question for their doctor (add_doctor_question) — offer only, "
            "never diagnose and never escalate on your own."
        )
    return (
        f"Noted — recorded that they feel {symptom}{linked}.{unmatched_note} "
        "Reply warmly: show you heard them and say it's saved in their health "
        "notes." + nudge
    )


register(_SCHEMA, add_symptom)
