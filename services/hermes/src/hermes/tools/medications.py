"""Medication tools: list_medications, add_prescription (scan -> propose -> confirm)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import uuid4

from .base import ToolContext, register
from .drug_info import interaction_text

log = logging.getLogger("hermes.tools.medications")

_LIST_SCHEMA = {
    "name": "list_medications",
    "description": (
        "List the elder's current (non-archived) medications, with dosage, "
        "schedule, purpose, and plain-language instructions."
    ),
    "input_schema": {"type": "object", "properties": {}, "required": []},
}


async def list_medications(ctx: ToolContext) -> str:
    rows = await ctx.db().select(
        "medications",
        columns="name,dosage,purpose,schedule,priority,instructions",
        filters={"archived": "eq.false"},
        order="priority.asc",
    )
    if not rows:
        return "No medications on file for this patient."
    lines = []
    for m in rows:
        times = (m.get("schedule") or {}).get("times") or []
        when = ", ".join(times) if times else "as directed"
        lines.append(
            f"- {m['name']} ({m.get('dosage') or 'dose n/a'}) — "
            f"{m.get('purpose') or 'purpose n/a'}; take at {when}. "
            f"{m.get('instructions') or ''}".strip()
        )
    return "\n".join(lines)


_ADD_SCHEMA = {
    "name": "add_prescription",
    "description": (
        "Add a new prescription for the elder. SAFETY: a scan or spoken "
        "prescription must first be PROPOSED (confirmed=false) and read back to "
        "the user for explicit confirmation. Only after the user clearly says yes "
        "may you call again with confirmed=true to commit the write. Never set "
        "confirmed=true without an explicit user confirmation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Medication name."},
            "dosage": {"type": "string", "description": "e.g. '500mg'."},
            "purpose": {"type": "string", "description": "What it treats."},
            "instructions": {
                "type": "string",
                "description": "Plain-language 'how to take it' guidance.",
            },
            "times": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Daily dose times as HH:MM, e.g. ['08:00','20:00'].",
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = propose only (no write); true = commit "
                "after the user confirmed.",
            },
        },
        "required": ["name", "confirmed"],
    },
}


async def add_prescription(
    ctx: ToolContext,
    name: str,
    confirmed: bool,
    dosage: str | None = None,
    purpose: str | None = None,
    instructions: str | None = None,
    times: list[str] | None = None,
) -> str:
    proposal = {
        "name": name,
        "dosage": dosage,
        "purpose": purpose,
        "instructions": instructions,
        "times": times or [],
    }

    if not confirmed:
        if ctx.session is not None:
            ctx.session.pending_proposal = proposal
        readback = f"{name}" + (f" {dosage}" if dosage else "")
        if times:
            readback += f", taken at {', '.join(times)}"
        if purpose:
            readback += f", for {purpose}"
        warning = await _interaction_warning(ctx, name)
        return (
            "PROPOSED (not yet saved). Read this back to the user and ask them to "
            f"confirm before saving: {readback}.{warning}"
        )

    # confirmed=true: guard that a matching proposal exists in this session.
    pending = getattr(ctx.session, "pending_proposal", None) if ctx.session else None
    if pending is None or pending.get("name") != name:
        return (
            "Refused to save: no matching pending proposal was confirmed. Propose "
            "the prescription first (confirmed=false) and get the user's explicit "
            "yes before saving."
        )

    row = {
        "elder_id": ctx.elder_id,
        "name": name,
        "dosage": dosage,
        "purpose": purpose,
        "instructions": instructions,
        "schedule": {"times": times or [], "frequency": "daily"},
        "verified_by": ctx.elder_id,
        "verified_at": datetime.now(UTC).isoformat(),
    }

    # Persist the scanned photo (if any) to the private pill-photos bucket now that
    # the elder has confirmed. Best-effort: an upload failure must not lose the med.
    image = getattr(ctx.session, "pending_image", None) if ctx.session else None
    if image:
        try:
            path = f"{ctx.elder_id}/{uuid4().hex}.jpg"
            await ctx.supabase.upload_object(
                "pill-photos", path, image, content_type="image/jpeg"
            )
            row["pill_photo_path"] = path
        except Exception:
            log.warning("failed to upload prescription photo", exc_info=True)

    await ctx.db().insert("medications", row, returning=False)
    if ctx.session is not None:
        ctx.session.pending_proposal = None
        ctx.session.pending_image = None
    return f"Saved {name} to the medication list and marked it confirmed."


async def _interaction_warning(ctx: ToolContext, new_name: str) -> str:
    """Best-effort, grounded interaction check at propose time: does OpenFDA's
    interaction section for the *new* drug mention any medication the elder already
    takes? Returns a caveated warning to append to the read-back, or "".

    Non-diagnostic and non-blocking: any lookup failure simply yields no warning,
    so a network hiccup never stops the propose-confirm flow.
    """
    try:
        current = await ctx.db().select(
            "medications", columns="name", filters={"archived": "eq.false"}
        )
        existing = {
            (m.get("name") or "").strip()
            for m in current
            if (m.get("name") or "").strip().lower() != new_name.strip().lower()
        }
        existing.discard("")
        if not existing:
            return ""
        text = (await interaction_text(ctx, new_name)).lower()
        if not text:
            return ""
        hits = sorted(n for n in existing if n.lower() in text)
        if not hits:
            return ""
        return (
            f" ⚠ Possible interaction: OpenFDA's interaction notes for {new_name} "
            f"mention {', '.join(hits)}, which this patient already takes. This is "
            "not medical advice — tell the patient to flag it with their doctor "
            "(offer add_doctor_question) before relying on the two together."
        )
    except Exception:
        return ""


register(_LIST_SCHEMA, list_medications)
register(_ADD_SCHEMA, add_prescription)
