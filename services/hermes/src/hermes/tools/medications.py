"""Medication tools: list_medications, add_prescription (scan -> propose -> confirm),
set_medication_reminder (propose -> confirm daily reminder times),
update_medication_dosage (propose -> confirm a dose change on an existing med),
discontinue_medication (propose -> confirm archiving a med — never a delete)."""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..dosing import WEEKDAY_NAMES, WEEKDAYS
from .base import (
    DOSAGE_INCREASE_MULTIPLIER,
    ToolContext,
    dosage_ratio,
    find_medications,
    first_id,
    match_pending,
    match_pending_bulk,
    record_action,
    register,
)
from .drug_info import interaction_text, label_mentions

log = logging.getLogger("hermes.tools.medications")


def _course_end_date(duration_days: int) -> date:
    """Last day of an N-day course, INCLUSIVE of today.

    ``duration_days=14`` -> today + 13, matching what the web sheet writes and
    what ``dosing.py::scheduled_today`` reads back. Uses the configured local
    timezone rather than naive ``date.today()`` — the rest of this service
    stores UTC, and a course boundary computed in the wrong zone is off by a
    whole day of doses for half of each day.
    """
    local_today = datetime.now(UTC).astimezone(ZoneInfo(get_settings().hermes_tz)).date()
    return local_today + timedelta(days=duration_days - 1)

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
        # A fixed course that has run out still has an un-archived row, but it
        # produces no more doses — say so rather than listing it as if it were
        # still being taken.
        course = ""
        end = schedule.get("end_date")
        if end:
            local_today = (
                datetime.now(UTC).astimezone(ZoneInfo(get_settings().hermes_tz)).date()
            )
            try:
                end_date = date.fromisoformat(str(end))
            except (ValueError, TypeError):
                end_date = None
            if end_date is not None:
                course = (
                    f" COURSE ENDED {end} — no more doses are scheduled; offer to "
                    "move it to past medicines"
                    if local_today > end_date
                    else f" (a fixed course, last day {end})"
                )
        lines.append(
            f"- {m['name']} ({m.get('dosage') or 'dose n/a'}) — "
            f"{m.get('purpose') or 'purpose n/a'}; take at {when}{cadence}.{course} "
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
            "duration_days": {
                "type": "integer",
                "description": "How many days the course runs, when the "
                "prescription is for a FIXED period ('take for 2 weeks', 'a "
                "5-day course'). Counted INCLUSIVELY from today, so 14 means "
                "today plus the next 13 days; reminders stop on their own after "
                "the last day. OMIT for an ongoing or repeat prescription — "
                "most maintenance medicines have no end date, and guessing one "
                "would stop their reminders early.",
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
    duration_days: int | None = None,
) -> str:
    proposal = {
        "name": name,
        "dosage": dosage,
        "purpose": purpose,
        "instructions": instructions,
        "times": times or [],
        "frequency": frequency,
        "duration_days": duration_days,
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
        if duration_days:
            # Show the end date too — "for 14 days" alone is easy to mis-hear,
            # and this is the number the person is confirming.
            readback += (
                f", for {duration_days} days (until "
                f"{_course_end_date(duration_days).isoformat()})"
            )
        warning = await _interaction_warning(ctx, name)
        # A same-name medication already on file at a different dose is really
        # a disguised dose CHANGE, not a new prescription — flag it the same
        # way update_medication_dosage does, even though this is add_prescription.
        existing = await _existing_medication(ctx, name)
        if existing:
            warning += _dosage_warning(existing.get("dosage"), dosage)
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
    if duration_days is None:
        duration_days = pending.get("duration_days")

    # Recomputed at COMMIT, not carried from the proposal: a proposal held
    # overnight would otherwise write an end date a day short.
    schedule: dict = {"times": times or [], "frequency": frequency or "daily"}
    if duration_days and int(duration_days) > 0:
        schedule["end_date"] = _course_end_date(int(duration_days)).isoformat()

    row = {
        "elder_id": ctx.elder_id,
        "name": name,
        "dosage": dosage,
        "purpose": purpose,
        "instructions": instructions,
        "schedule": schedule,
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
            **(
                {"end_date": {"before": None, "after": schedule["end_date"]}}
                if "end_date" in schedule
                else {}
            ),
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


def _dosage_warning(old_dosage: str | None, new_dosage: str | None) -> str:
    """Best-effort, non-blocking caution when a new dosage is a big jump above
    the old one — pure arithmetic on the two free-text values (``dosage_ratio``,
    base.py), no medical judgment. Mirrors ``_interaction_warning``'s shape:
    fails open (returns "") on anything unparseable or incomparable, so it
    only ever adds a caveat, never blocks or crashes the propose flow.
    ``risk.py``'s classifier calls the SAME ratio helper with the opposite,
    fail-CLOSED bias — see ``dosage_ratio``'s docstring for why the two need
    to differ.
    """
    ratio = dosage_ratio(old_dosage, new_dosage)
    if ratio is None or ratio < DOSAGE_INCREASE_MULTIPLIER:
        return ""
    return (
        f" ⚠ That's a big increase — {old_dosage} to {new_dosage} is "
        f"{ratio:.3g}x the previous dose. This is not medical advice — tell "
        "the patient to flag it with their doctor (offer add_doctor_question) "
        "before starting the higher dose."
    )


async def _existing_medication(ctx: ToolContext, name: str) -> dict | None:
    """The one non-archived medication already on file matching ``name``, or
    ``None`` for a genuinely new drug. Reuses ``find_medications``'s existing
    exact/suffix-stripped/wildcard matching tiers (the same lookup every other
    tool uses) so a name that arrives with its own dosage suffix still
    resolves. Fails open on any error — a lookup hiccup should never crash a
    propose.
    """
    try:
        meds = await find_medications(ctx, name, columns="name,dosage")
        return meds[0] if meds else None
    except Exception:
        return None


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
        raw_old = med.get("dosage")
        old = raw_old or "an unrecorded dose"
        if ctx.session is not None:
            # Stash the CANONICAL med name (not the raw query) so a confirm that
            # echoes back the "Metformin" we just displayed still matches a
            # "metformin" the user originally typed — mirrors discontinue_medication
            # / set_allergy_severity, which also stash+compare the resolved name.
            ctx.session.pending_dosage = {"name": med["name"], "dosage": dosage}
            ctx.session.awaiting_confirmation = True
        warning = _dosage_warning(raw_old, dosage)
        return (
            "PROPOSED (not yet saved). Read this back to the user and ask them to "
            f"confirm before saving: change {med['name']} dose from {old} to "
            f"{dosage}.{warning}"
        )

    # confirmed=true: guard that a matching proposal exists in this session.
    # Read the slot directly and compare case-insensitively against the canonical
    # name we stashed — match_pending's exact-string compare used to wrongly refuse
    # a confirm that echoed the displayed "Metformin" when the user typed
    # "metformin" (case-only mismatch). Same normalization the sibling tools use.
    pending = getattr(ctx.session, "pending_dosage", None) if ctx.session else None
    stashed = ((pending or {}).get("name") or "").strip().lower()
    if pending is None or stashed != (medication_name or "").strip().lower():
        return (
            "Refused to save: no matching pending dosage change was confirmed. Propose "
            "the change first (confirmed=false) and get the user's explicit yes."
        )
    # Commit ONLY the dose that was proposed and read back to the user. A confirm
    # turn that resupplies a DIFFERENT dose must not silently save it — that would
    # write an un-agreed value and skip the _dosage_warning the propose ran. A
    # tap/short "yes" resupplies nothing and lands on the proposed dose anyway; a
    # genuinely different dose is refused so it goes back through propose→confirm.
    proposed_dosage = (pending.get("dosage") or "").strip()
    incoming = (dosage or "").strip()
    if incoming and proposed_dosage and incoming.lower() != proposed_dosage.lower():
        return (
            "Refused to save: the dose in this confirmation "
            f"('{incoming}') doesn't match the one I proposed and read back "
            f"('{proposed_dosage}'). Propose the new dose again (confirmed=false) "
            "so the user can confirm it."
        )
    dosage = proposed_dosage or dosage

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
