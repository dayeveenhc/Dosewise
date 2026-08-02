"""Refill tracking: check_refills, log_refill.

Backs the `refills` table (pills_remaining / threshold / run_out_forecast per
medication). `check_refills` reports how many pills are left and flags anything at
or below its low-stock threshold; `log_refill` updates the count after the elder
tops up (or reports what's left). Both act as the elder (RLS-scoped) like the
other elder-owned tools.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from .base import ToolContext, find_medications, first_id, record_action, register

_CHECK_SCHEMA = {
    "name": "check_refills",
    "description": (
        "Check how many pills the elder has left for each medication and whether "
        "any are running low (at or below their refill threshold). Use when the "
        "elder asks about supply, or proactively when they mention running out."
    ),
    "input_schema": {"type": "object", "properties": {}, "required": []},
}

_LOG_SCHEMA = {
    "name": "log_refill",
    "description": (
        "Update the pill count for a medication after the elder refills it or tells "
        "you how many are left. Set pills_remaining to the new total. Optionally set "
        "a low-stock threshold (default kept if omitted)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Name of the medication being refilled/counted.",
            },
            "pills_remaining": {
                "type": "integer",
                "description": "New total number of pills on hand.",
            },
            "threshold": {
                "type": "integer",
                "description": "Optional low-stock threshold to warn at.",
            },
        },
        "required": ["medication_name", "pills_remaining"],
    },
}


_REQUEST_SCHEMA = {
    "name": "request_refill",
    "description": (
        "Send a refill REQUEST to the elder's doctor — it goes into the Ask-a-Doctor "
        "thread the caregiver also sees, so the doctor can re-prescribe/approve it. "
        "Use this whenever the elder wants a refill or to re-order a medication "
        "('I need a refill for X', 'ask my doctor to renew X'). This is NOT for "
        "recording how many pills are left — that's log_refill. Commit immediately "
        "(no propose/confirm): queuing a question for the doctor is low-stakes."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Medication the elder wants refilled.",
            },
        },
        "required": ["medication_name"],
    },
}


def _daily_pills(schedule: dict | None) -> int:
    """Best-effort pills-per-day from a medication schedule (len of times, min 1)."""
    times = (schedule or {}).get("times") or []
    return max(len(times), 1)


async def check_refills(ctx: ToolContext) -> str:
    db = ctx.db()
    rows = await db.select(
        "refills",
        columns="pills_remaining,threshold,run_out_forecast,medications(name)",
        order="pills_remaining.asc",
    )
    if not rows:
        return (
            "No refill counts are on file yet. Offer to record how many pills the "
            "elder has for each medication (log_refill)."
        )
    lines: list[str] = []
    low: list[str] = []
    for r in rows:
        name = (r.get("medications") or {}).get("name") or "a medication"
        remaining = r.get("pills_remaining")
        threshold = r.get("threshold")
        forecast = r.get("run_out_forecast")
        note = f"- {name}: {remaining if remaining is not None else '?'} pills left"
        if forecast:
            note += f" (runs out around {forecast})"
        if remaining is not None and threshold is not None and remaining <= threshold:
            note += " — RUNNING LOW, time to refill"
            low.append(name)
        lines.append(note)
    summary = "\n".join(lines)
    if low:
        summary += (
            f"\n\nLow on: {', '.join(low)}. Offer to remind the caregiver "
            "(message_caregiver) or queue a doctor/pharmacy note."
        )
    return summary


async def log_refill(
    ctx: ToolContext,
    medication_name: str,
    pills_remaining: int,
    threshold: int | None = None,
) -> str:
    db = ctx.db()
    meds = await find_medications(ctx, medication_name, columns="id,name,schedule")
    if not meds:
        return (
            f"No medication named '{medication_name}' is on file. Confirm the name "
            "or list the medications first."
        )
    med = meds[0]

    # Forecast the run-out date from the daily pill count, if we can.
    per_day = _daily_pills(med.get("schedule"))
    forecast = (date.today() + timedelta(days=pills_remaining // per_day)).isoformat()
    now = datetime.now(UTC).isoformat()

    patch = {
        "pills_remaining": pills_remaining,
        "run_out_forecast": forecast,
        "updated_at": now,
    }
    if threshold is not None:
        patch["threshold"] = threshold

    existing = await db.select(
        "refills",
        columns="id,pills_remaining,threshold",
        filters={"medication_id": f"eq.{med['id']}"},
        limit=1,
    )
    if existing:
        before_remaining = existing[0].get("pills_remaining")
        refill_id = existing[0]["id"]
        await db.update(
            "refills",
            patch,
            filters={"id": f"eq.{refill_id}"},
            returning=False,
        )
    else:
        before_remaining = None
        inserted = await db.insert(
            "refills",
            {"medication_id": med["id"], "elder_id": ctx.elder_id, **patch},
            returning=True,
        )
        refill_id = first_id(inserted)
    tail = f" (about enough until {forecast})" if pills_remaining else ""
    # entity_id is the MEDICATION id (not the refills row id): the refill count is
    # shown on the medication card, so that's the element the UI highlights. The
    # refills row id is carried as `refill_id` for independent verification.
    record_action(
        ctx,
        tool="log_refill",
        summary=f"{med['name']}: {pills_remaining} pills",
        entity_type="refill_request",
        entity_id=med["id"],
        changed_fields={
            "pills_remaining": {"before": before_remaining, "after": pills_remaining}
        },
        name=med["name"],
        refill_id=str(refill_id),
    )
    return f"Updated {med['name']}: {pills_remaining} pills on hand{tail}."


async def request_refill(ctx: ToolContext, medication_name: str) -> str:
    # Resolve to the canonical name if the med is on file (so the doctor sees the
    # real name), but don't hard-fail if it isn't — the elder can still ask.
    meds = await find_medications(ctx, medication_name, columns="id,name")
    name = meds[0]["name"] if meds else medication_name

    # Don't queue a duplicate: if an open refill request for this same med is
    # already on the doctor's list, say so instead of inserting a second row (the
    # caregiver sees this thread too — two identical requests is just noise). The
    # jsonb `context` isn't filterable via FakeDB's eq semantics, so filter the
    # elder's own open agent rows in Python.
    existing = await ctx.db().select(
        "doctor_questions",
        columns="id,context,status,source",
        filters={
            "elder_id": f"eq.{ctx.elder_id}",
            "status": "eq.open",
            "source": "eq.agent",
        },
    )
    for row in existing:
        c = row.get("context") or {}
        if c.get("kind") == "refill" and str(c.get("medication", "")).lower() == name.lower():
            return (
                f"A refill request for {name} is already on your doctor's list and "
                "still open — I didn't add a duplicate."
            )

    question = f"Refill request: please re-prescribe {name}."
    inserted = await ctx.db().insert(
        "doctor_questions",
        {
            "elder_id": ctx.elder_id,
            "question": question,
            "context": {"kind": "refill", "medication": name},
            "source": "agent",
            "status": "open",
        },
        returning=True,
    )
    # entity_type="doctor_message" so the web client routes the highlight to the
    # Ask-a-Doctor thread (changeHighlight.ts), same as add_doctor_question — a
    # refill request belongs on the doctor's list, not in the pill-count card.
    record_action(
        ctx,
        tool="request_refill",
        summary=question,
        entity_type="doctor_message",
        entity_id=first_id(inserted),
        changed_fields={"question": {"before": None, "after": question}},
        name=name,
    )
    return (
        f"I've added a refill request for {name} to your doctor's list — they'll "
        "see it on their next review."
    )


register(_CHECK_SCHEMA, check_refills)
register(_LOG_SCHEMA, log_refill)
register(_REQUEST_SCHEMA, request_refill)
