"""Dose logging: log_dose + resolve_missed_doses."""

from __future__ import annotations

from datetime import UTC, datetime, time
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
        "Record that the elder took a dose of a medication. Pass the BARE "
        "medication name (never a name+strength label); omit medication_name "
        "only when the user didn't name one ('I took my pills'). If more than "
        "one dose could be meant, the tool lists the options instead of "
        "guessing — relay its question to the user, then call again with their "
        "answer as `slot`."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Bare name of the medication that was taken (no dosage).",
            },
            "slot": {
                "type": "string",
                "description": (
                    "Which scheduled dose was taken, when the user said or was "
                    "asked: 'HH:MM' 24-hour (e.g. '08:00'), or a day part — "
                    "morning|noon|afternoon|evening|night."
                ),
            },
        },
        "required": [],
    },
}

# Day-part words map to an anchor wall-clock time; the nearest scheduled slot
# wins, so "morning" resolves an 07:30 dose as readily as an 08:00 one.
_DAY_PART_ANCHORS = {
    "morning": time(8, 0),
    "noon": time(12, 0),
    "afternoon": time(15, 0),
    "evening": time(19, 0),
    "night": time(21, 0),
}


def _parse_slot(slot: str | None) -> time | None:
    if not slot:
        return None
    s = slot.strip().lower()
    return _parse_hhmm(s) or _DAY_PART_ANCHORS.get(s)


def _minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def _local_hhmm(iso: str, zone: ZoneInfo) -> str:
    return datetime.fromisoformat(iso).astimezone(zone).strftime("%H:%M")


async def _dose_plan(
    ctx: ToolContext, med: dict, want: time | None
) -> tuple[str, object]:
    """Decide WHICH dose "the user took their {med}" refers to — no writes.

    Returns ``(kind, payload)``: ``("pending", dose_row)`` flip that row;
    ``("backdate", "HH:MM")`` insert back-dated to that slot today; ``("now",
    None)`` insert at the current time (unscheduled/as-needed med); ``("already",
    "HH:MM")`` everything due is logged — nothing to write; ``("ask", ["HH:MM",
    ...])`` genuinely ambiguous — the caller must ask the user, never guess.
    Attribution is earliest-first throughout, consistent with
    resolve_missed_doses/show_schedule (the old code took the LATEST pending row,
    which ticked tonight's dose when the user meant this morning's).
    """
    tz_name = get_settings().hermes_tz
    tz = ZoneInfo(tz_name)
    now = _now_utc()
    local_now = now.astimezone(tz)

    pending = await ctx.db().select(
        "doses",
        columns="id,scheduled_at",
        filters={"medication_id": f"eq.{med['id']}", "status": "eq.pending"},
    )
    pending = sorted(pending or [], key=lambda r: r["scheduled_at"])
    if pending:
        if want is not None:
            best = min(
                pending,
                key=lambda r: abs(
                    _minutes(_parse_hhmm(_local_hhmm(r["scheduled_at"], tz)))
                    - _minutes(want)
                ),
            )
            return ("pending", best)
        if len(pending) == 1:
            return ("pending", pending[0])
        return ("ask", [_local_hhmm(r["scheduled_at"], tz) for r in pending])

    # No pending rows — fall back to the schedule (doses aren't materialised
    # per-slot; same approximation as resolve_missed_doses).
    schedule = med.get("schedule") or {}
    times = (
        sorted(t for t in (schedule.get("times") or []) if _parse_hhmm(t))
        if scheduled_today(schedule, local_now.date())
        else []
    )
    taken_n = (await _taken_counts_today(ctx, now, tz_name)).get(med["id"], 0)
    due = [t for t in times if _parse_hhmm(t) <= local_now.time()]
    unmet = due[taken_n:]
    if want is not None and times:
        hhmm = min(times, key=lambda t: abs(_minutes(_parse_hhmm(t)) - _minutes(want)))
        if hhmm in due and hhmm not in unmet:
            return ("already", hhmm)
        return ("backdate", hhmm)
    if len(unmet) == 1:
        return ("backdate", unmet[0])
    if len(unmet) > 1:
        return ("ask", unmet)
    if due and taken_n >= len(due):
        return ("already", due[-1])
    return ("now", None)


async def _commit_dose(ctx: ToolContext, med: dict, kind: str, payload) -> str:
    """Perform the planned write and record the committed action."""
    db = ctx.db()
    now = _now_utc()
    now_iso = now.isoformat()

    if kind == "already":
        return (
            f"{med['name']} is already logged as taken for today's "
            f"{_fmt_slot(payload)} dose — nothing new to record; reassure the user."
        )

    # entity_id is the MEDICATION id (not the dose row id): the Home timeline
    # renders medication cards (`data-testid="medication-{medId}"`), so that's
    # the element the UI highlights. The dose row id is carried as `dose_id`
    # for independent verification — mirrors log_refill's `refill_id`.
    if kind == "pending":
        await db.update(
            "doses",
            {"status": "taken", "logged_at": now_iso, "logged_by": ctx.elder_id},
            filters={"id": f"eq.{payload['id']}"},
            returning=False,
        )
        record_action(
            ctx,
            tool="log_dose",
            summary=med["name"],
            entity_type="dose",
            entity_id=med["id"],
            changed_fields={"status": {"before": "pending", "after": "taken"}},
            name=med["name"],
            dose_id=str(payload["id"]),
        )
        return f"Logged {med['name']} as taken."

    if kind == "backdate":
        zone = ZoneInfo(get_settings().hermes_tz)
        slot_utc = datetime.combine(
            now.astimezone(zone).date(), _parse_hhmm(payload), tzinfo=zone
        ).astimezone(UTC)
        scheduled_at = slot_utc.isoformat()
    else:  # "now" — unscheduled/as-needed med
        scheduled_at = now_iso

    inserted = await db.insert(
        "doses",
        {
            "medication_id": med["id"],
            "elder_id": ctx.elder_id,
            "scheduled_at": scheduled_at,
            "status": "taken",
            "logged_at": now_iso,
            "logged_by": ctx.elder_id,
        },
        returning=True,
    )
    extra = {"slot": payload} if kind == "backdate" else {}
    record_action(
        ctx,
        tool="log_dose",
        summary=med["name"],
        entity_type="dose",
        entity_id=med["id"],
        changed_fields={"status": {"before": None, "after": "taken"}},
        name=med["name"],
        dose_id=first_id(inserted),
        **extra,
    )
    if kind == "backdate":
        return f"Logged {med['name']} as taken for the {_fmt_slot(payload)} dose."
    return f"Logged {med['name']} as taken just now."


def _ask_slots(name: str, slots: list[str]) -> str:
    opts = ", ".join(f'{_fmt_slot(s)} (slot "{s}")' for s in slots)
    return (
        f"{name} has more than one dose that could be meant today: {opts}. "
        "Ask the user WHICH one they took — do not guess — then call log_dose "
        "again with their answer as slot."
    )


async def log_dose(
    ctx: ToolContext,
    medication_name: str | None = None,
    slot: str | None = None,
) -> str:
    want = _parse_slot(slot)

    if medication_name:
        meds = await find_medications(
            ctx, medication_name, columns="id,name,schedule", limit=None
        )
        if not meds:
            return (
                f"No medication named '{medication_name}' is on file. Ask the user to "
                "confirm the name, or list their medications first."
            )
        # Same-name duplicates collapse to the first row; DIFFERENT names (a
        # substring match hit several meds) are a genuine ambiguity — ask.
        distinct: dict[str, dict] = {}
        for m in meds:
            distinct.setdefault((m.get("name") or "").strip().lower(), m)
        if len(distinct) > 1:
            names = ", ".join(m.get("name") or "?" for m in distinct.values())
            return (
                f"More than one medication matches '{medication_name}': {names}. "
                "Ask the user which one they mean, then call log_dose again with "
                "that exact name."
            )
        med = next(iter(distinct.values()))
        kind, payload = await _dose_plan(ctx, med, want)
        if kind == "ask":
            return _ask_slots(med["name"], payload)
        return await _commit_dose(ctx, med, kind, payload)

    # No name given ("I took my pills") — log only when exactly one medication
    # plausibly has a dose to record; otherwise ask, never guess.
    meds = await ctx.db().select(
        "medications", columns="id,name,schedule", filters={"archived": "eq.false"}
    )
    if not meds:
        return "No medications are on file yet — nothing to log."
    zone = ZoneInfo(get_settings().hermes_tz)
    plans: list[tuple[dict, str, object]] = []
    for m in meds:
        kind, payload = await _dose_plan(ctx, m, want)
        if kind in ("pending", "backdate", "ask"):
            plans.append((m, kind, payload))
    if not plans:
        return (
            "Nothing looks due right now — today's doses so far are all logged. "
            "Ask the user which medication they mean before logging anything."
        )
    if len(plans) == 1:
        m, kind, payload = plans[0]
        if kind == "ask":
            return _ask_slots(m["name"], payload)
        return await _commit_dose(ctx, m, kind, payload)

    def label(kind: str, payload) -> str:
        if kind == "pending":
            return _fmt_slot(_local_hhmm(payload["scheduled_at"], zone))
        if kind == "backdate":
            return _fmt_slot(payload)
        return " / ".join(_fmt_slot(s) for s in payload)

    listing = ", ".join(f"{m['name']} ({label(k, p)})" for m, k, p in plans)
    return (
        f"Several medications have doses to log: {listing}. Ask the user WHICH "
        "medication they took, then call log_dose again with that medication_name."
    )


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
