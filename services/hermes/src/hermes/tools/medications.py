"""Medication tools: list_medications, add_prescription (scan -> propose -> confirm)."""

from __future__ import annotations

from datetime import datetime, timezone

from .base import ToolContext, register

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
        return (
            "PROPOSED (not yet saved). Read this back to the user and ask them to "
            f"confirm before saving: {readback}."
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
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }
    await ctx.db().insert("medications", row, returning=False)
    if ctx.session is not None:
        ctx.session.pending_proposal = None
    return f"Saved {name} to the medication list and marked it confirmed."


register(_LIST_SCHEMA, list_medications)
register(_ADD_SCHEMA, add_prescription)
