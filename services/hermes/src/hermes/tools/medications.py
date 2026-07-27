"""Medication tools: list_medications, add_prescription (scan -> propose -> confirm),
set_medication_reminder (propose -> confirm daily reminder times),
update_medication_dosage (propose -> confirm a dose change on an existing med),
discontinue_medication (propose -> confirm archiving a med — never a delete)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import uuid4

from ..dosing import WEEKDAY_NAMES, WEEKDAYS
from .base import (
    ToolContext,
    find_medications,
    first_id,
    match_pending,
    match_pending_bulk,
    record_action,
    register,
)
from .drug_info import interaction_text, label_mentions

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
        schedule = m.get("schedule") or {}
        times = schedule.get("times") or []
        when = ", ".join(times) if times else "as directed"
        days = schedule.get("days") or []
        cadence = f" {_days_phrase(days)}" if days else ""
        lines.append(
            f"- {m['name']} ({m.get('dosage') or 'dose n/a'}) — "
            f"{m.get('purpose') or 'purpose n/a'}; take at {when}{cadence}. "
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
                "description": "Daily dose times as HH:MM, e.g. ['08:00','20:00']. "
                "Convert any 'every N hours' / 'N times a day' frequency into "
                "explicit clock times and always include them.",
            },
            "frequency": {
                "type": "string",
                "description": "Plain-language cadence for display, e.g. 'every 8 "
                "hours', 'twice daily', 'at night'. The `times` list is what "
                "actually schedules the doses; this is the human label shown "
                "alongside them.",
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
    frequency: str | None = None,
) -> str:
    proposal = {
        "name": name,
        "dosage": dosage,
        "purpose": purpose,
        "instructions": instructions,
        "times": times or [],
        "frequency": frequency,
    }

    if not confirmed:
        if ctx.session is not None:
            # Tie any just-received photo to THIS proposal so it can only ever be
            # saved against the medication it was proposed with — never a later,
            # unrelated one. Consume it off the shared session slot; on a re-propose
            # of the same drug (model refined a field), carry the photo forward.
            image = ctx.session.pending_image
            if image is None:
                prev = ctx.session.pending_proposal
                if prev and prev.get("name") == name:
                    image = prev.get("image")
            proposal["image"] = image
            ctx.session.pending_image = None
            ctx.session.pending_proposal = proposal
            # Signal the channel to offer a Yes/No tap-keyboard for the confirmation.
            ctx.session.awaiting_confirmation = True
        readback = f"{name}" + (f" {dosage}" if dosage else "")
        if times:
            readback += f", taken at {', '.join(times)}"
        if frequency:
            readback += f" ({frequency})"
        if purpose:
            readback += f", for {purpose}"
        warning = await _interaction_warning(ctx, name)
        return (
            "PROPOSED (not yet saved). Read this back to the user and ask them to "
            f"confirm before saving: {readback}.{warning}"
        )

    # confirmed=true: guard that a matching proposal exists in this session.
    pending = match_pending(ctx, "pending_proposal", "name", name)
    if pending is None:
        return (
            "Refused to save: no matching pending proposal was confirmed. Propose "
            "the prescription first (confirmed=false) and get the user's explicit "
            "yes before saving."
        )

    # Prefer freshly-supplied values, else fall back to the matched proposal that was
    # read back and confirmed — so a tap/short "yes" that doesn't resupply every
    # field still saves the times and cadence the user actually agreed to.
    times = times or list(pending.get("times") or [])
    frequency = frequency or pending.get("frequency")
    dosage = dosage or pending.get("dosage")
    purpose = purpose or pending.get("purpose")
    instructions = instructions or pending.get("instructions")

    row = {
        "elder_id": ctx.elder_id,
        "name": name,
        "dosage": dosage,
        "purpose": purpose,
        "instructions": instructions,
        "schedule": {"times": times or [], "frequency": frequency or "daily"},
        "verified_by": ctx.elder_id,
        "verified_at": datetime.now(UTC).isoformat(),
    }

    # Persist the scanned photo (if any) to the private pill-photos bucket now that
    # the elder has confirmed. The image is read from the *matched proposal* (not a
    # shared session slot), so it is guaranteed to belong to this exact medication.
    # Best-effort: an upload failure must not lose the med.
    image = pending.get("image")
    if image:
        try:
            path = f"{ctx.elder_id}/{uuid4().hex}.jpg"
            await ctx.supabase.upload_object(
                "pill-photos", path, image, content_type="image/jpeg"
            )
            row["pill_photo_path"] = path
        except Exception:
            log.warning("failed to upload prescription photo", exc_info=True)

    inserted = await ctx.db().insert("medications", row, returning=True)
    if ctx.session is not None:
        ctx.session.pending_proposal = None
        ctx.session.pending_image = None
        ctx.session.awaiting_confirmation = False
    summary = name + (f" {dosage}" if dosage else "")
    if times:
        summary += f" — {', '.join(times)}"
    if frequency:
        summary += f" ({frequency})"
    new_id = first_id(inserted)
    record_action(
        ctx,
        tool="add_prescription",
        summary=summary,
        entity_type="medication",
        entity_id=new_id,
        changed_fields={
            "name": {"before": None, "after": name},
            "dosage": {"before": None, "after": dosage},
            "purpose": {"before": None, "after": purpose},
            "times": {"before": None, "after": times or []},
            "frequency": {"before": None, "after": frequency},
        },
        name=name,
    )
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
        text = await interaction_text(ctx, new_name)
        if not text:
            return ""
        hits = sorted(n for n in existing if label_mentions(text, n))
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


_REMINDER_SCHEMA = {
    "name": "set_medication_reminder",
    "description": (
        "Set or change the reminder times for a medication the elder already has on "
        "file. Use when they say things like 'remind me at 8am', 'change my reminder "
        "to the evening', 'add a night dose reminder', or 'remind me every Monday and "
        "Thursday'. This REPLACES the medication's reminder times (and days) with what "
        "you pass — it does NOT append. To ADD a time, first call list_medications and "
        "pass the full combined list. Pass `days` for a weekly schedule (e.g. a pill "
        "taken only on certain weekdays); omit `days` for an every-day reminder. "
        "SAFETY: the propose→confirm rule applies — first call with confirmed=false to "
        "read the times back, and only call again with confirmed=true after a clear "
        "yes. The reminder scheduler picks up the new times/days automatically."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Medication name (already on file)."},
            "times": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Reminder times as 24-hour HH:MM, e.g. ['08:00','20:00'].",
            },
            "days": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Weekdays for a weekly reminder, as mon/tue/wed/thu/fri/"
                "sat/sun, e.g. ['mon','thu']. Omit for an every-day reminder.",
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = propose only (no write); true = commit after "
                "the user confirmed.",
            },
        },
        "required": ["name", "confirmed"],
    },
}


def _normalize_days(days: list[str] | None) -> tuple[list[str], list[str]]:
    """Split ``days`` into (valid weekday tokens in mon..sun order, invalid).

    Accepts full or abbreviated names, any case ('Monday', 'mon', 'MON'). An empty
    or all-invalid input yields ``([], invalid)`` — the caller treats [] as
    'every day' (a daily schedule), preserving today's behaviour."""
    valid: set[str] = set()
    invalid: list[str] = []
    for raw in days or []:
        token = str(raw).strip().lower()[:3]
        if token in WEEKDAYS:
            valid.add(token)
        else:
            invalid.append(str(raw).strip())
    ordered = [d for d in WEEKDAYS if d in valid]
    return ordered, invalid


def _normalize_times(times: list[str] | None) -> tuple[list[str], list[str]]:
    """Split ``times`` into (valid HH:MM, invalid). Accepts 'H:MM' too and
    zero-pads to 'HH:MM'; anything out of 00:00–23:59 is invalid."""
    valid: list[str] = []
    invalid: list[str] = []
    for raw in times or []:
        item = str(raw).strip()
        hh, sep, mm = item.partition(":")
        if sep and hh.isdigit() and mm.isdigit() and len(mm) == 2:
            h, m = int(hh), int(mm)
            if 0 <= h <= 23 and 0 <= m <= 59:
                valid.append(f"{h:02d}:{m:02d}")
                continue
        invalid.append(item)
    return valid, invalid


def _days_phrase(days: list[str]) -> str:
    """Plain-language 'every day' vs 'on Monday and Thursday' for read-backs."""
    if not days:
        return "every day"
    names = [WEEKDAY_NAMES[d] for d in days]
    if len(names) == 1:
        return f"every {names[0]}"
    return "on " + ", ".join(names[:-1]) + f" and {names[-1]}"


async def set_medication_reminder(
    ctx: ToolContext,
    name: str,
    confirmed: bool,
    times: list[str] | None = None,
    days: list[str] | None = None,
) -> str:
    valid, invalid = _normalize_times(times)
    if invalid:
        return (
            f"These times aren't clear: {', '.join(invalid)}. Ask the user for the "
            "time(s) as a 24-hour clock like 08:00 or 20:00, and don't save yet."
        )
    valid_days, invalid_days = _normalize_days(days)
    if invalid_days:
        return (
            f"These days aren't clear: {', '.join(invalid_days)}. Ask the user for "
            "weekdays like Monday or Thursday, and don't save yet."
        )

    if not confirmed:
        if not valid:
            return "Ask the user what time(s) they'd like the reminder, then propose it."
        if ctx.session is not None:
            ctx.session.pending_reminder = {"name": name, "times": valid, "days": valid_days}
            ctx.session.awaiting_confirmation = True
        return (
            "PROPOSED (not yet saved). Read this back to the user and ask them to "
            f"confirm before saving: remind them to take {name} at "
            f"{', '.join(valid)} {_days_phrase(valid_days)}."
        )

    # confirmed=true: guard that a matching proposal exists in this session.
    pending = match_pending(ctx, "pending_reminder", "name", name)
    if pending is None:
        return (
            "Refused to save: no matching pending reminder was confirmed. Propose "
            "the reminder first (confirmed=false) and get the user's explicit yes."
        )

    # Prefer freshly-supplied values; fall back to the ones already read back and
    # confirmed, so a tap-to-confirm that doesn't resupply them still saves.
    valid = valid or list(pending.get("times") or [])
    valid_days = valid_days or list(pending.get("days") or [])
    if not valid:
        return "Ask the user what time(s) they'd like the reminder, then propose it."

    meds = await find_medications(ctx, name, columns="id,schedule")
    if not meds:
        if ctx.session is not None:
            ctx.session.pending_reminder = None
            ctx.session.awaiting_confirmation = False
        return (
            f"No medication named '{name}' is on file, so I can't set a reminder for "
            "it. Ask the user to confirm the name or add the prescription first."
        )

    med = meds[0]
    old_schedule = dict(med.get("schedule") or {})
    schedule = dict(old_schedule)
    schedule["times"] = valid
    if valid_days:
        schedule["days"] = valid_days
        schedule["frequency"] = "weekly"
    else:
        # A plain daily reminder — drop any previous weekly restriction.
        schedule.pop("days", None)
        schedule["frequency"] = "daily"
    await ctx.db().update(
        "medications",
        {"schedule": schedule},
        filters={"id": f"eq.{med['id']}"},
        returning=False,
    )
    if ctx.session is not None:
        ctx.session.pending_reminder = None
        ctx.session.awaiting_confirmation = False
    changed_fields: dict[str, dict] = {
        "times": {"before": old_schedule.get("times") or [], "after": valid}
    }
    if valid_days:
        changed_fields["days"] = {
            "before": old_schedule.get("days") or [], "after": valid_days
        }
    record_action(
        ctx,
        tool="set_medication_reminder",
        summary=f"{name} at {', '.join(valid)}",
        entity_type="schedule_entry",
        entity_id=med["id"],
        changed_fields=changed_fields,
        name=name,
    )
    return (
        f"Saved. I'll remind you to take {name} at "
        f"{', '.join(valid)} {_days_phrase(valid_days)}."
    )


_SCHEMA_UPDATE_DOSAGE = {
    "name": "update_medication_dosage",
    "description": (
        "Update the dosage of a medication the elder ALREADY has on file. Use when "
        "the dose itself changed — 'the doctor changed my metformin to 1000mg', "
        "'increase my atorvastatin to 40mg', 'my dose went down to 250mg'. This is an "
        "UPDATE to an existing prescription; do NOT use add_prescription (that is for a "
        "brand-new medication) and do NOT start a walkthrough. SAFETY: the "
        "propose→confirm rule applies — first call with confirmed=false to read the "
        "change back (old dose → new dose), and only call again with confirmed=true "
        "after the user's explicit yes."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Medication name (already on file).",
            },
            "dosage": {
                "type": "string",
                "description": "The new dosage, e.g. '1000mg'.",
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = propose only (no write); true = commit after "
                "the user confirmed.",
            },
        },
        "required": ["medication_name", "dosage"],
    },
}


async def update_medication_dosage(
    ctx: ToolContext,
    medication_name: str,
    dosage: str,
    confirmed: bool = False,
) -> str:
    if not confirmed:
        meds = await find_medications(ctx, medication_name, columns="id,name,dosage")
        if not meds:
            return (
                f"No medication named '{medication_name}' is on file, so I can't change "
                "its dose. Ask the user to confirm the name, or add the prescription "
                "first with add_prescription."
            )
        med = meds[0]
        old = med.get("dosage") or "an unrecorded dose"
        if ctx.session is not None:
            ctx.session.pending_dosage = {"name": medication_name, "dosage": dosage}
            ctx.session.awaiting_confirmation = True
        return (
            "PROPOSED (not yet saved). Read this back to the user and ask them to "
            f"confirm before saving: change {med['name']} dose from {old} to {dosage}."
        )

    # confirmed=true: guard that a matching proposal exists in this session.
    pending = match_pending(ctx, "pending_dosage", "name", medication_name)
    if pending is None:
        return (
            "Refused to save: no matching pending dosage change was confirmed. Propose "
            "the change first (confirmed=false) and get the user's explicit yes."
        )
    # A tap/short "yes" that doesn't resupply the dose still saves the one read back.
    dosage = dosage or pending.get("dosage")

    meds = await find_medications(ctx, medication_name, columns="id,name,dosage")
    if not meds:
        if ctx.session is not None:
            ctx.session.pending_dosage = None
            ctx.session.awaiting_confirmation = False
        return (
            f"No medication named '{medication_name}' is on file, so I can't change its "
            "dose. Ask the user to confirm the name or add the prescription first."
        )
    med = meds[0]
    before = med.get("dosage")
    await ctx.db().update(
        "medications",
        {"dosage": dosage},
        filters={"id": f"eq.{med['id']}"},
        returning=False,
    )
    if ctx.session is not None:
        ctx.session.pending_dosage = None
        ctx.session.awaiting_confirmation = False
    record_action(
        ctx,
        tool="update_medication_dosage",
        summary=f"{med['name']}: {dosage}",
        entity_type="medication",
        entity_id=med["id"],
        changed_fields={"dosage": {"before": before, "after": dosage}},
        name=med["name"],
    )
    return f"Saved. I updated {med['name']} to {dosage}."


_DISCONTINUE_SCHEMA = {
    "name": "discontinue_medication",
    "description": (
        "Stop a medication the elder no longer takes ('stop taking my X', "
        "'discontinue X', 'remove X'). Marks it Stopped in the record — it is "
        "NEVER deleted; the history stays visible under past medications. "
        "SAFETY: propose→confirm — first call with confirmed=false to read the "
        "stop back, and only call again with confirmed=true after the user's "
        "explicit yes. Not for a dose change (update_medication_dosage) or a "
        "time change (set_medication_reminder)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Name of the medication to stop (already on file).",
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = propose only (no write); true = commit "
                "after the user confirmed.",
            },
        },
        "required": ["medication_name"],
    },
}


async def discontinue_medication(
    ctx: ToolContext, medication_name: str, confirmed: bool = False
) -> str:
    if not confirmed:
        meds = await find_medications(
            ctx, medication_name, columns="id,name,dosage", limit=None
        )
        # Same-name duplicates collapse to the first row; DIFFERENT matched
        # names are a genuine ambiguity — ask, never guess which to stop.
        distinct: dict[str, dict] = {}
        for m in meds:
            distinct.setdefault((m.get("name") or "").strip().lower(), m)
        if not distinct:
            return (
                f"No medication named '{medication_name}' is on file, so there's "
                "nothing to stop. Ask the user to confirm the name, or list "
                "their medications first."
            )
        if len(distinct) > 1:
            names = ", ".join(m.get("name") or "?" for m in distinct.values())
            return (
                f"More than one medication matches '{medication_name}': {names}. "
                "Ask the user which one they mean, then call "
                "discontinue_medication again with that exact name."
            )
        med = next(iter(distinct.values()))
        if ctx.session is not None:
            ctx.session.pending_bulk = {
                "tool": "discontinue_medication",
                "items": [{"medication_id": med["id"], "name": med["name"]}],
            }
            ctx.session.awaiting_confirmation = True
        label = med["name"] + (f" {med['dosage']}" if med.get("dosage") else "")
        return (
            f"PROPOSED (not yet saved). Stop {label} — it stays in the record "
            "as Stopped, never deleted. Read this back and ask the user one "
            "yes/no before saving."
        )

    # confirmed=true: only honor a confirm for the med that was read back.
    items = match_pending_bulk(ctx, "discontinue_medication")
    item = items[0] if items else None
    stashed = ((item or {}).get("name") or "").strip().lower()
    if item is None or stashed != (medication_name or "").strip().lower():
        return (
            "Refused to save: no matching pending stop was confirmed. Propose "
            "it first (confirmed=false) and get the user's explicit yes."
        )
    if ctx.session is not None:
        ctx.session.pending_bulk = None
        ctx.session.awaiting_confirmation = False

    # Re-read fresh by id (never trust the stash's snapshot of the row).
    meds = await ctx.db().select(
        "medications",
        columns="id,name,archived",
        filters={"id": f"eq.{item.get('medication_id')}"},
        limit=1,
    )
    if not meds or meds[0].get("archived"):
        return (
            f"{item.get('name') or 'That medication'} is no longer active on "
            "file — there's nothing to stop. Tell the user honestly."
        )
    med = meds[0]
    # NEVER a delete: archived=true is the Stopped state the UI shows.
    await ctx.db().update(
        "medications",
        {"archived": True},
        filters={"id": f"eq.{med['id']}"},
        returning=False,
    )
    record_action(
        ctx,
        tool="discontinue_medication",
        summary=f"{med['name']} stopped",
        entity_type="medication",
        entity_id=med["id"],
        changed_fields={"status": {"before": "active", "after": "discontinued"}},
        name=med["name"],
    )
    return (
        f"Done. {med['name']} is marked as Stopped — it stays in the record, "
        "nothing was deleted."
    )


register(_LIST_SCHEMA, list_medications)
register(_ADD_SCHEMA, add_prescription)
register(_REMINDER_SCHEMA, set_medication_reminder)
register(_SCHEMA_UPDATE_DOSAGE, update_medication_dosage)
register(_DISCONTINUE_SCHEMA, discontinue_medication)
