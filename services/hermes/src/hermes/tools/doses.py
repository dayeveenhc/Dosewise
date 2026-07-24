"""Dose logging: log_dose."""

from __future__ import annotations

from datetime import UTC, datetime

from .base import ToolContext, find_medications, first_id, record_action, register

_SCHEMA = {
    "name": "log_dose",
    "description": (
        "Record that the elder took a dose of a medication (by name). Marks the "
        "most recent still-pending scheduled dose for that medication as taken; if "
        "none is pending, logs a new taken dose at the current time."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Name of the medication that was taken.",
            }
        },
        "required": ["medication_name"],
    },
}


async def log_dose(ctx: ToolContext, medication_name: str) -> str:
    db = ctx.db()
    meds = await find_medications(ctx, medication_name, columns="id,name")
    if not meds:
        return (
            f"No medication named '{medication_name}' is on file. Ask the user to "
            "confirm the name, or list their medications first."
        )
    med = meds[0]
    now = datetime.now(UTC).isoformat()

    pending = await db.select(
        "doses",
        columns="id,scheduled_at",
        filters={"medication_id": f"eq.{med['id']}", "status": "eq.pending"},
        order="scheduled_at.desc",
        limit=1,
    )
    if pending:
        await db.update(
            "doses",
            {"status": "taken", "logged_at": now, "logged_by": ctx.elder_id},
            filters={"id": f"eq.{pending[0]['id']}"},
            returning=False,
        )
        record_action(
            ctx,
            tool="log_dose",
            summary=med["name"],
            entity_type="dose",
            entity_id=pending[0]["id"],
            changed_fields={"status": {"before": "pending", "after": "taken"}},
            name=med["name"],
        )
        return f"Logged {med['name']} as taken."

    inserted = await db.insert(
        "doses",
        {
            "medication_id": med["id"],
            "elder_id": ctx.elder_id,
            "scheduled_at": now,
            "status": "taken",
            "logged_at": now,
            "logged_by": ctx.elder_id,
        },
        returning=True,
    )
    record_action(
        ctx,
        tool="log_dose",
        summary=med["name"],
        entity_type="dose",
        entity_id=first_id(inserted),
        changed_fields={"status": {"before": None, "after": "taken"}},
        name=med["name"],
    )
    return f"Logged {med['name']} as taken just now."


register(_SCHEMA, log_dose)
