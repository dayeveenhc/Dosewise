"""Dose logging: log_dose, resolve_missed_doses, log_doses (explicit-list bulk),
undo_dose (flip a mistaken tick back), snooze_dose (today-only reminder snooze)."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..dosing import _parse_hhmm, scheduled_today, start_of_day_utc
from .base import (
    ToolContext,
    find_medications,
    first_id,
    match_pending_bulk,
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

# How wide a day-part word reaches when FILTERING (resolve_missed_doses), as
# opposed to _parse_slot's nearest-neighbor TIEBREAKING (log_dose): a bounded
# window, not "closest anchor wins" — a med scheduled only at noon must never
# match a "morning" filter just because noon is the closest anchor to it.
_DAY_PART_WINDOW_MINUTES = 60


def _parse_slot(slot: str | None) -> time | None:
    if not slot:
        return None
    s = slot.strip().lower()
    return _parse_hhmm(s) or _DAY_PART_ANCHORS.get(s)


def _parse_slot_filter(slot: str | None) -> tuple[str, time] | None:
    """Parse a resolve_missed_doses ``slot`` FILTER: ``("exact", HH:MM)`` or
    ``("window", day-part anchor)``. Unlike ``_parse_slot`` (log_dose's
    nearest-neighbor tiebreaker among one medication's own times), this has no
    "closest wins" fallback — an unrecognized value returns ``None`` so the
    caller can refuse and ask again rather than silently widening scope to
    every missed dose today.
    """
    if not slot:
        return None
    s = slot.strip().lower()
    exact = _parse_hhmm(s)
    if exact is not None:
        return ("exact", exact)
    anchor = _DAY_PART_ANCHORS.get(s)
    if anchor is not None:
        return ("window", anchor)
    return None


def _minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def _slot_filter_matches(hhmm: str, filt: tuple[str, time] | None) -> bool:
    """Whether a missed-dose slot ("HH:MM") is in scope for a resolve_missed_doses
    filter. ``None`` always matches (today's existing unfiltered behavior);
    ``"exact"`` requires equality; ``"window"`` requires being within
    ``_DAY_PART_WINDOW_MINUTES`` of the day part's anchor (circular distance, so
    a window near midnight still wraps correctly). Never nearest-neighbor: a
    slot outside every window matches nothing rather than being forced onto the
    closest anchor — under-matching is the safe direction here.
    """
    if filt is None:
        return True
    kind, anchor = filt
    slot_time = _parse_hhmm(hhmm)
    if slot_time is None:
        return False
    if kind == "exact":
        return slot_time == anchor
    diff = abs(_minutes(slot_time) - _minutes(anchor))
    diff = min(diff, 1440 - diff)
    return diff <= _DAY_PART_WINDOW_MINUTES


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


async def _resolve_one_med(
    ctx: ToolContext, medication_name: str, tool: str
) -> tuple[dict | None, str | None]:
    """Exactly one non-archived med for ``medication_name``, or ``(None, reply)``.

    Shared by every by-name dose tool. Same-name duplicate rows collapse to the
    first; DIFFERENT matched names (a substring match hit several meds) are a
    genuine ambiguity — the reply asks which, naming ``tool`` for the retry.
    """
    meds = await find_medications(
        ctx, medication_name, columns="id,name,schedule", limit=None
    )
    if not meds:
        return None, (
            f"No medication named '{medication_name}' is on file. Ask the user to "
            "confirm the name, or list their medications first."
        )
    distinct: dict[str, dict] = {}
    for m in meds:
        distinct.setdefault((m.get("name") or "").strip().lower(), m)
    if len(distinct) > 1:
        names = ", ".join(m.get("name") or "?" for m in distinct.values())
        return None, (
            f"More than one medication matches '{medication_name}': {names}. "
            f"Ask the user which one they mean, then call {tool} again with "
            "that exact name."
        )
    return next(iter(distinct.values())), None


async def log_dose(
    ctx: ToolContext,
    medication_name: str | None = None,
    slot: str | None = None,
) -> str:
    want = _parse_slot(slot)

    if medication_name:
        med, problem = await _resolve_one_med(ctx, medication_name, "log_dose")
        if med is None:
            return problem
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
        "Find today's missed (past-due, not yet taken) doses and, after the user "
        "confirms, mark them as taken. Use when the user asks to tick/resolve/log "
        "all missed or missing doses at once — optionally scoped to one time with "
        "`slot` (e.g. 'the ones I took at 8am'). SAFETY: first call with "
        "confirmed=false to read the full list back, and only call again with "
        "confirmed=true after the user's explicit yes."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "confirmed": {
                "type": "boolean",
                "description": "false = list the missed doses only (no write); true "
                "= mark them all taken after the user confirmed the read-back.",
            },
            "slot": {
                "type": "string",
                "description": (
                    "Only include doses at this time, when the user's ask names "
                    "one: 'HH:MM' 24-hour (e.g. '08:00'), or a day part — "
                    "morning|noon|afternoon|evening|night. Matches doses at "
                    "exactly that time, or within an hour of the day part's "
                    "usual time. Omit for every missed dose today (the default). "
                    "Not needed on the confirmed=true call."
                ),
            },
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


def _scope_phrase(filt: tuple[str, time] | None) -> str:
    """``" at 8:00 AM"`` / ``" around 8:00 AM"`` / ``""`` for a resolve_missed_doses
    read-back, so a filtered proposal always states exactly what's in scope."""
    if filt is None:
        return ""
    kind, anchor = filt
    formatted = _fmt_slot(anchor.strftime("%H:%M"))
    return f" around {formatted}" if kind == "window" else f" at {formatted}"


async def _missed_doses_today(
    ctx: ToolContext, slot_filter: tuple[str, time] | None = None
) -> list[dict]:
    """Every dose slot due earlier today with no taken dose to cover it.

    Mirrors show_schedule's approximation (doses aren't materialised per-slot):
    for each active med scheduled today, slots at/before local now are "due", and
    today's logged-taken count consumes the EARLIEST due slots first — whatever
    due slots remain are missed. Returns ``[{medication_id, name, slot}, ...]``
    with slots as ``HH:MM``, meds in select order, slots ascending.

    ``slot_filter`` (from ``_parse_slot_filter``), when given, narrows the
    result to slots matching it (``_slot_filter_matches``) — applied as a POST-
    PASS after the full missed-slot computation below, so which slots count as
    missed at all (the earliest-first taken-attribution) is unaffected by what
    the caller asked to see.
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
    if slot_filter is not None:
        missed = [m for m in missed if _slot_filter_matches(m["slot"], slot_filter)]
    return missed


async def resolve_missed_doses(
    ctx: ToolContext, confirmed: bool = False, slot: str | None = None
) -> str:
    if not confirmed:
        slot_filter = None
        if slot:
            slot_filter = _parse_slot_filter(slot)
            if slot_filter is None:
                return (
                    "That time isn't clear. Ask the user for it as a clock time "
                    "like 08:00, or morning/noon/afternoon/evening/night, and "
                    "don't propose anything yet."
                )
        scope = _scope_phrase(slot_filter)
        missed = await _missed_doses_today(ctx, slot_filter)
        if not missed:
            return f"No missed doses today{scope} — everything due so far is logged."
        if ctx.session is not None:
            ctx.session.pending_missed_doses = missed
            ctx.session.awaiting_confirmation = True
        listing = ", ".join(f"{m['name']} at {_fmt_slot(m['slot'])}" for m in missed)
        return (
            f"PROPOSED (not yet saved). These doses were due earlier today{scope} "
            f"and are not logged yet: {listing} — ask the user to confirm marking "
            "ALL of these as taken."
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


_UNDO_SCHEMA = {
    "name": "undo_dose",
    "description": (
        "Undo a dose that was marked taken TODAY by mistake ('actually I didn't "
        "take it', 'undo that', 'I ticked the wrong one'). Flips the most "
        "recently logged dose back to not-taken, immediately — undoing a fresh "
        "mistake needs no confirmation round-trip. Pass the BARE medication "
        "name when the user said one; omit it to undo the last dose logged "
        "today."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Bare name of the medication to un-tick (no dosage).",
            },
        },
        "required": [],
    },
}


async def undo_dose(ctx: ToolContext, medication_name: str | None = None) -> str:
    tz_name = get_settings().hermes_tz
    zone = ZoneInfo(tz_name)
    now = _now_utc()

    med: dict | None = None
    if medication_name:
        med, problem = await _resolve_one_med(ctx, medication_name, "undo_dose")
        if med is None:
            return problem

    filters = {
        "status": "eq.taken",
        # "Today" is the elder's wall-clock day: logged_at at/after local midnight.
        "logged_at": f"gte.{start_of_day_utc(now, tz_name)}",
    }
    if med is not None:
        filters["medication_id"] = f"eq.{med['id']}"
    rows = await ctx.db().select(
        "doses", columns="id,medication_id,scheduled_at,logged_at", filters=filters
    )
    rows = sorted(rows or [], key=lambda r: str(r.get("logged_at") or ""), reverse=True)
    if not rows:
        scope = f" of {med['name']}" if med is not None else ""
        return (
            f"No dose{scope} was logged as taken today, so there's nothing to "
            "undo. Tell the user honestly — nothing was changed."
        )

    dose = rows[0]
    if med is None:
        meds = await ctx.db().select(
            "medications",
            columns="id,name",
            filters={"id": f"eq.{dose['medication_id']}"},
            limit=1,
        )
        med = meds[0] if meds else {"id": dose["medication_id"], "name": "your medicine"}

    await ctx.db().update(
        "doses",
        {"status": "pending", "logged_at": None, "logged_by": None},
        filters={"id": f"eq.{dose['id']}"},
        returning=False,
    )
    slot = _fmt_slot(_local_hhmm(dose["scheduled_at"], zone))
    record_action(
        ctx,
        tool="undo_dose",
        summary=f"{med['name']} un-ticked",
        entity_type="dose",
        entity_id=med["id"],
        changed_fields={"status": {"before": "taken", "after": "pending"}},
        name=med["name"],
        dose_id=str(dose["id"]),
    )
    return (
        f"Undone — {med['name']}'s {slot} dose is no longer marked as taken. "
        "Read that back so the user knows exactly which dose was un-ticked."
    )


register(_UNDO_SCHEMA, undo_dose)


_LOG_MANY_SCHEMA = {
    "name": "log_doses",
    "description": (
        "Record that the elder took SEVERAL medications they NAMED in one "
        "message ('I took my metformin and my lisinopril'). Pass the bare names "
        "(no dosages). SAFETY: first call with confirmed=false to read the list "
        "back, and only call again with confirmed=true after the user's "
        "explicit yes. For 'all my missed doses' with no names use "
        "resolve_missed_doses; for a single medication use log_dose."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_names": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Bare names of the medications the user said they took."
                ),
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = list what would be logged (no write); "
                "true = mark them all taken after the user confirmed.",
            },
        },
        "required": ["medication_names"],
    },
}


async def _plan_named_dose(ctx: ToolContext, med: dict) -> tuple[str, object]:
    """``_dose_plan`` for the bulk flow: an "ask" (multi-slot) resolves to its
    EARLIEST option instead of a question — the read-back SHOWS the chosen slot,
    so the user's single yes covers it. Never forks the selection logic: the
    ambiguity is re-planned through ``_dose_plan`` with that slot as the want."""
    kind, payload = await _dose_plan(ctx, med, None)
    if kind == "ask":
        kind, payload = await _dose_plan(ctx, med, _parse_hhmm(min(payload)))
    return kind, payload


def _slot_label(kind: str, payload, zone: ZoneInfo) -> str:
    if kind == "pending":
        return _fmt_slot(_local_hhmm(payload["scheduled_at"], zone))
    if kind == "backdate":
        return _fmt_slot(payload)
    return "just now"


async def log_doses(
    ctx: ToolContext,
    medication_names: list[str],
    confirmed: bool = False,
) -> str:
    zone = ZoneInfo(get_settings().hermes_tz)

    if not confirmed:
        names = [str(n).strip() for n in (medication_names or []) if str(n).strip()]
        if not names:
            return (
                "No medication names were given. Ask the user which medicines "
                "they took — or use resolve_missed_doses for an 'all my missed "
                "doses' request."
            )
        items: list[dict] = []
        lines: list[str] = []
        missing: list[str] = []
        ambiguous: list[str] = []
        already: list[str] = []
        seen_ids: set = set()
        for raw in names:
            meds = await find_medications(
                ctx, raw, columns="id,name,schedule", limit=None
            )
            distinct: dict[str, dict] = {}
            for m in meds:
                distinct.setdefault((m.get("name") or "").strip().lower(), m)
            if not distinct:
                missing.append(raw)
                continue
            if len(distinct) > 1:
                opts = ", ".join(m.get("name") or "?" for m in distinct.values())
                ambiguous.append(f"'{raw}' (matches {opts})")
                continue
            med = next(iter(distinct.values()))
            if med["id"] in seen_ids:
                continue  # the user named the same med twice
            kind, payload = await _plan_named_dose(ctx, med)
            if kind == "already":
                already.append(f"{med['name']} ({_fmt_slot(payload)})")
                continue
            seen_ids.add(med["id"])
            items.append(
                {
                    "medication_id": med["id"],
                    "name": med["name"],
                    "kind": kind,
                    "payload": payload,
                }
            )
            lines.append(f"{med['name']} ({_slot_label(kind, payload, zone)})")
        notes = []
        if already:
            notes.append(f"Already logged today: {', '.join(already)}.")
        if missing:
            notes.append(f"Not on file: {', '.join(missing)}.")
        if ambiguous:
            notes.append(f"Ask which is meant: {'; '.join(ambiguous)}.")
        note_text = (" " + " ".join(notes)) if notes else ""
        if not items:
            return (
                "Nothing to log from that list." + note_text
                + " Tell the user honestly — nothing was written."
            )
        if ctx.session is not None:
            ctx.session.pending_bulk = {"tool": "log_doses", "items": items}
            ctx.session.awaiting_confirmation = True
        return (
            "PROPOSED (not yet saved). These doses would be marked as taken: "
            f"{', '.join(lines)}.{note_text} Read the list back and ask the "
            "user ONE yes/no to confirm marking them all as taken."
        )

    # confirmed=true: only honor a confirm when this list was proposed this session.
    items = match_pending_bulk(ctx, "log_doses")
    if items is None:
        return (
            "Refused to save: no pending dose list was proposed and confirmed. "
            "Propose first (confirmed=false), read the list back, and get the "
            "user's explicit yes."
        )
    if ctx.session is not None:
        ctx.session.pending_bulk = None
        ctx.session.awaiting_confirmation = False

    done: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []
    # _commit_dose appends ONE single log_dose action per dose. The frontend
    # must see ONE committed action for the whole bulk (one batch highlight,
    # not N loose captions), so snapshot the length here and splice the
    # per-item actions out afterwards, replacing them with one bulk action.
    pre = len(ctx.committed_actions)
    for item in items:
        meds = await ctx.db().select(
            "medications",
            columns="id,name,schedule",
            filters={"id": f"eq.{item.get('medication_id')}", "archived": "eq.false"},
            limit=1,
        )
        if not meds:
            failed.append(item.get("name") or "an unknown medication")
            continue
        med = meds[0]
        # Race-safe: RE-resolve the plan fresh rather than trusting the stashed
        # payload — a dose logged since the propose must not be double-written.
        kind, payload = await _plan_named_dose(ctx, med)
        if kind == "already":
            skipped.append(f"{med['name']} ({_fmt_slot(payload)})")
            continue
        try:
            await _commit_dose(ctx, med, kind, payload)
        except Exception:
            failed.append(med["name"])
            continue
        done.append(f"{med['name']} ({_slot_label(kind, payload, zone)})")

    singles = ctx.committed_actions[pre:]
    del ctx.committed_actions[pre:]
    if singles:
        entities = [
            {k: v for k, v in a.items() if k not in ("tool", "summary")}
            for a in singles
        ]
        n = len(entities)
        record_bulk_action(
            ctx,
            tool="log_doses",
            summary=f"{n} dose{'s' if n != 1 else ''} marked taken",
            entities=entities,
            dose_ids=[e.get("dose_id", "") for e in entities],
        )

    parts: list[str] = []
    if done:
        parts.append(
            f"Marked {len(done)} dose{'s' if len(done) != 1 else ''} as taken: "
            f"{', '.join(done)}."
        )
    if skipped:
        parts.append(f"Already logged since the propose: {', '.join(skipped)}.")
    if failed:
        parts.append(f"Could not save: {', '.join(failed)} — tell the user honestly.")
    if not parts:
        parts.append("Nothing left to mark — those doses are already logged.")
    return " ".join(parts)


register(_LOG_MANY_SCHEMA, log_doses)


_SNOOZE_SCHEMA = {
    "name": "snooze_dose",
    "description": (
        "Snooze TODAY's reminder for one medication ('remind me in 30 minutes', "
        "'snooze it until 8:30'). One-time only: today's reminder moves, the "
        "medication's schedule does NOT change — for a permanent time change "
        "use set_medication_reminder instead. Give minutes from now OR an "
        "until time; with neither, it snoozes 30 minutes."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "medication_name": {
                "type": "string",
                "description": "Bare name of the medication (no dosage).",
            },
            "minutes": {
                "type": "integer",
                "description": "Snooze this many minutes from now (default 30).",
            },
            "until": {
                "type": "string",
                "description": "Snooze until this time today, 24-hour 'HH:MM' "
                "in the elder's local time.",
            },
        },
        "required": ["medication_name"],
    },
}


async def snooze_dose(
    ctx: ToolContext,
    medication_name: str,
    minutes: int | None = None,
    until: str | None = None,
) -> str:
    tz_name = get_settings().hermes_tz
    zone = ZoneInfo(tz_name)
    now = _now_utc()
    local_now = now.astimezone(zone)

    med, problem = await _resolve_one_med(ctx, medication_name, "snooze_dose")
    if med is None:
        return problem

    # Target slot: the earliest due-but-unmet slot today (same earliest-first
    # attribution as _dose_plan/_missed_doses_today), else the next upcoming
    # slot today. A snooze moves TODAY's reminder only — no slot left today
    # means there is honestly nothing to snooze.
    schedule = med.get("schedule") or {}
    times = (
        sorted(t for t in (schedule.get("times") or []) if _parse_hhmm(t))
        if scheduled_today(schedule, local_now.date())
        else []
    )
    if not times:
        return (
            f"{med['name']} has no scheduled dose times today, so there's no "
            "reminder to snooze."
        )
    taken_n = (await _taken_counts_today(ctx, now, tz_name)).get(med["id"], 0)
    due = [t for t in times if _parse_hhmm(t) <= local_now.time()]
    unmet = due[taken_n:]
    upcoming = [t for t in times if _parse_hhmm(t) > local_now.time()]
    if unmet:
        slot = unmet[0]
    elif upcoming:
        slot = upcoming[0]
    else:
        return (
            f"All of {med['name']}'s doses today are already logged and no more "
            "are scheduled today — nothing to snooze."
        )

    if until is not None:
        t = _parse_hhmm(str(until).strip())
        if t is None:
            return (
                "That snooze time isn't clear. Ask the user for it as a 24-hour "
                "time like 20:30, and don't save yet."
            )
        until_hhmm = f"{t.hour:02d}:{t.minute:02d}"
    else:
        offset = 30 if minutes is None else int(minutes)
        if offset <= 0:
            return (
                "Ask the user how many minutes to snooze for (a positive "
                "number), and don't save yet."
            )
        until_hhmm = (local_now + timedelta(minutes=offset)).strftime("%H:%M")

    # Demo-grade persistence: profiles.accessibility.dose_snoozes (jsonb
    # catch-all, read-merge-write — never overwrite the whole object). One
    # entry per (medication_id, slot, date); a re-snooze replaces it.
    db = ctx.db()
    rows = await db.select(
        "profiles",
        columns="accessibility",
        filters={"id": f"eq.{ctx.elder_id}"},
        limit=1,
    )
    access = dict((rows[0].get("accessibility") if rows else None) or {})
    snoozes = [s for s in (access.get("dose_snoozes") or []) if isinstance(s, dict)]
    local_date = local_now.date().isoformat()

    def _same(s: dict) -> bool:
        return (
            s.get("medication_id") == med["id"]
            and s.get("slot") == slot
            and s.get("date") == local_date
        )

    before = next((s.get("until") for s in snoozes if _same(s)), None)
    snoozes = [s for s in snoozes if not _same(s)]
    snoozes.append(
        {
            "medication_id": med["id"],
            "name": med["name"],
            "slot": slot,
            "date": local_date,
            "until": until_hhmm,
        }
    )
    access["dose_snoozes"] = snoozes
    await db.update(
        "profiles",
        {"accessibility": access},
        filters={"id": f"eq.{ctx.elder_id}"},
        returning=False,
    )
    record_action(
        ctx,
        tool="snooze_dose",
        summary=f"{med['name']} snoozed to {_fmt_slot(until_hhmm)}",
        entity_type="dose",
        entity_id=med["id"],
        changed_fields={"snoozed_until": {"before": before, "after": until_hhmm}},
        name=med["name"],
        slot=slot,
    )
    return (
        f"Reminder for {med['name']}'s {_fmt_slot(slot)} dose snoozed to "
        f"{_fmt_slot(until_hhmm)} — today only. The regular schedule is "
        "unchanged."
    )


register(_SNOOZE_SCHEMA, snooze_dose)
