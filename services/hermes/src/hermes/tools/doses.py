"""Dose logging: log_dose + resolve_missed_doses."""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..dosing import _parse_hhmm, scheduled_today
from .base import (
    ToolContext,
    find_medications,
    first_id,
    record_action,
    record_bulk_action,
    register,
)
from .schedule import _taken_counts_today

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
        # entity_id is the MEDICATION id (not the dose row id): the Home timeline
        # renders medication cards (`data-testid="medication-{medId}"`), so that's
        # the element the UI highlights. The dose row id is carried as `dose_id`
        # for independent verification — mirrors log_refill's `refill_id`.
        record_action(
            ctx,
            tool="log_dose",
            summary=med["name"],
            entity_type="dose",
            entity_id=med["id"],
            changed_fields={"status": {"before": "pending", "after": "taken"}},
            name=med["name"],
            dose_id=str(pending[0]["id"]),
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
        entity_id=med["id"],
        changed_fields={"status": {"before": None, "after": "taken"}},
        name=med["name"],
        dose_id=first_id(inserted),
    )
    return f"Logged {med['name']} as taken just now."


register(_SCHEMA, log_dose)


_RESOLVE_SCHEMA = {
    "name": "resolve_missed_doses",
    "description": (
        "Find ALL of today's missed (past-due, not yet taken) doses across every "
        "medication and, after the user confirms, mark them all as taken. Use when "
        "the user asks to tick/resolve/log all missed or missing doses at once. "
        "SAFETY: first call with confirmed=false to read the full list back, and "
        "only call again with confirmed=true after the user's explicit yes."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "confirmed": {
                "type": "boolean",
                "description": "false = list the missed doses only (no write); true "
                "= mark them all taken after the user confirmed the read-back.",
            }
        },
        "required": [],
    },
}


def _now_utc() -> datetime:
    """Current UTC instant — a seam so tests can pin the clock."""
    return datetime.now(UTC)


def _fmt_slot(hhmm: str) -> str:
    """``"08:00"`` → ``"8:00 AM"`` for read-backs."""
    t = _parse_hhmm(hhmm)
    return t.strftime("%I:%M %p").lstrip("0") if t else hhmm


async def _missed_doses_today(ctx: ToolContext) -> list[dict]:
    """Every dose slot due earlier today with no taken dose to cover it.

    Mirrors show_schedule's approximation (doses aren't materialised per-slot):
    for each active med scheduled today, slots at/before local now are "due", and
    today's logged-taken count consumes the EARLIEST due slots first — whatever
    due slots remain are missed. Returns ``[{medication_id, name, slot}, ...]``
    with slots as ``HH:MM``, meds in select order, slots ascending.
    """
    tz = get_settings().hermes_tz
    now = _now_utc()
    local_now = now.astimezone(ZoneInfo(tz))
    meds = await ctx.db().select(
        "medications",
        columns="id,name,schedule",
        filters={"archived": "eq.false"},
    )
    taken = await _taken_counts_today(ctx, now, tz)
    missed: list[dict] = []
    for med in meds:
        schedule = med.get("schedule") or {}
        if not scheduled_today(schedule, local_now.date()):
            continue
        times = sorted(t for t in (schedule.get("times") or []) if _parse_hhmm(t))
        due = [t for t in times if _parse_hhmm(t) <= local_now.time()]
        # Earliest-first attribution: N taken doses cover the N earliest due slots.
        for hhmm in due[taken.get(med.get("id"), 0):]:
            missed.append(
                {"medication_id": med["id"], "name": med.get("name") or "your medicine",
                 "slot": hhmm}
            )
    return missed


async def resolve_missed_doses(ctx: ToolContext, confirmed: bool = False) -> str:
    if not confirmed:
        missed = await _missed_doses_today(ctx)
        if not missed:
            return "No missed doses today — everything due so far is logged."
        if ctx.session is not None:
            ctx.session.pending_missed_doses = missed
            ctx.session.awaiting_confirmation = True
        listing = ", ".join(f"{m['name']} at {_fmt_slot(m['slot'])}" for m in missed)
        return (
            "PROPOSED (not yet saved). These doses were due earlier today and are "
            f"not logged yet: {listing} — ask the user to confirm marking ALL of "
            "these as taken."
        )

    # confirmed=true: only honor a confirm when the list was proposed this session.
    pending = getattr(ctx.session, "pending_missed_doses", None) if ctx.session else None
    if pending is None:
        return (
            "Refused to save: no pending missed-dose list was proposed and "
            "confirmed. Propose first (confirmed=false), read the full list back, "
            "and get the user's explicit yes."
        )

    # Re-compute fresh (state may have changed since the propose) and only keep
    # slots the user actually saw read back — never write an unproposed slot.
    proposed = {(m.get("medication_id"), m.get("slot")) for m in pending}
    missed = [
        m for m in await _missed_doses_today(ctx)
        if (m["medication_id"], m["slot"]) in proposed
    ]
    if ctx.session is not None:
        ctx.session.pending_missed_doses = None
        ctx.session.awaiting_confirmation = False
    if not missed:
        return (
            "Nothing left to mark — the proposed missed doses are already logged."
        )

    tz = get_settings().hermes_tz
    zone = ZoneInfo(tz)
    now = _now_utc()
    local_today = now.astimezone(zone).date()
    db = ctx.db()
    done: list[dict] = []
    failed: list[dict] = []
    for m in missed:
        # Back-date scheduled_at to the slot's wall-clock time TODAY (elder tz →
        # UTC), so the record reflects when the dose was due, not "now".
        slot_utc = datetime.combine(
            local_today, _parse_hhmm(m["slot"]), tzinfo=zone
        ).astimezone(UTC)
        try:
            inserted = await db.insert(
                "doses",
                {
                    "medication_id": m["medication_id"],
                    "elder_id": ctx.elder_id,
                    "scheduled_at": slot_utc.isoformat(),
                    "status": "taken",
                    "logged_at": now.isoformat(),
                    "logged_by": ctx.elder_id,
                },
                returning=True,
            )
        except Exception:
            failed.append(m)
            continue
        done.append({**m, "dose_id": first_id(inserted)})

    if done:
        # entity_id is the MEDICATION id (the UI renders medication cards, not
        # dose rows — same precedent as log_dose); the dose row id + slot ride
        # along per entity for independent verification.
        record_bulk_action(
            ctx,
            tool="resolve_missed_doses",
            summary=f"{len(done)} missed doses marked taken",
            entities=[
                {
                    "entity_type": "dose",
                    "entity_id": m["medication_id"],
                    "changed_fields": {"status": {"before": None, "after": "taken"}},
                    "dose_id": m["dose_id"],
                    "slot": m["slot"],
                    "name": m["name"],
                }
                for m in done
            ],
            dose_ids=[m["dose_id"] for m in done],
        )
    listing = ", ".join(f"{m['name']} ({_fmt_slot(m['slot'])})" for m in done)
    if failed:
        failed_listing = ", ".join(
            f"{m['name']} ({_fmt_slot(m['slot'])})" for m in failed
        )
        saved = f"Marked {len(done)} of {len(missed)} missed doses as taken"
        saved += f": {listing}. " if done else ". "
        return saved + f"Could not save: {failed_listing} — tell the user honestly."
    return f"Marked {len(done)} missed doses as taken: {listing}."


register(_RESOLVE_SCHEMA, resolve_missed_doses)
