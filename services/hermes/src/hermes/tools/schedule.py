"""Daily medication timeline: show_schedule.

Renders today's medicines as a chronological timeline with a taken/due/upcoming
status per slot, so the elder can see their day at a glance (and, on Telegram, tap
to log a dose). Doses aren't materialised per-slot (the full calendar is deferred),
so status is approximated: the earliest N slots of a medication are marked taken
when N doses have been logged taken today.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..dosing import WEEKDAYS, _parse_hhmm, scheduled_today, start_of_day_utc
from .base import ToolContext, register

_SCHEMA = {
    "name": "show_schedule",
    "description": (
        "Show the patient's medication timeline for today (or this week) — each "
        "medicine at its scheduled time with whether it's been taken, is due, or is "
        "coming up. Use when they ask 'what do I take today?', 'what's my schedule', "
        "or want to see their plan."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "view": {
                "type": "string",
                "enum": ["today", "week"],
                "description": "today (default) for a timeline, week for a 7-day view.",
            }
        },
        "required": [],
    },
}

_DAY_TITLE = {
    "mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday",
    "fri": "Friday", "sat": "Saturday", "sun": "Sunday",
}


def render_today(meds: list[dict], taken_by_med: dict[str, int], now: datetime, tz: str) -> str:
    """Build the plain-text timeline for today. Pure — no DB, for easy testing."""
    zone = ZoneInfo(tz)
    local_now = now.astimezone(zone)
    local_today = local_now.date()
    day_name = _DAY_TITLE[WEEKDAYS[local_today.weekday()]]
    title = f"Today — {day_name}, {local_today.strftime('%d %b')}"

    rows: list[tuple[str, str]] = []  # (HH:MM, line) for sorting
    for med in meds:
        schedule = med.get("schedule") or {}
        if not scheduled_today(schedule, local_today):
            continue
        times = sorted(t for t in (schedule.get("times") or []) if _parse_hhmm(t))
        taken_left = taken_by_med.get(med.get("id"), 0)
        label = med.get("name") or "your medicine"
        if med.get("dosage"):
            label += f" {med['dosage']}"
        for hhmm in times:
            slot_t = _parse_hhmm(hhmm)
            if taken_left > 0:
                status = "✅ taken"
                taken_left -= 1
            elif slot_t <= local_now.time():
                status = "⏳ due now"
            else:
                status = "🕗 upcoming"
            rows.append((hhmm, f"🕗 {hhmm}  💊 {label}  — {status}"))

    if not rows:
        return f"{title}\n\nNo medicines are scheduled for today. ✅"
    rows.sort(key=lambda r: r[0])
    return title + "\n\n" + "\n".join(line for _, line in rows)


def render_week(meds: list[dict]) -> str:
    """A simple 7-day view: which medicines fall on each weekday (no live status)."""
    lines = ["This week:"]
    for token in WEEKDAYS:
        names: list[str] = []
        for med in meds:
            schedule = med.get("schedule") or {}
            days = schedule.get("days") or []
            if not days or token in {str(d).strip().lower()[:3] for d in days}:
                times = ", ".join(sorted(schedule.get("times") or [])) or "as directed"
                names.append(f"{med.get('name')} ({times})")
        day = _DAY_TITLE[token]
        lines.append(f"\n{day}:")
        lines.extend(f"  💊 {n}" for n in names) if names else lines.append("  —")
    return "\n".join(lines)


async def _taken_counts_today(ctx: ToolContext, now: datetime, tz: str) -> dict[str, int]:
    """How many doses were logged taken today, per medication_id (RLS-scoped)."""
    rows = await ctx.db().select(
        "doses",
        columns="medication_id",
        filters={"status": "eq.taken", "scheduled_at": f"gte.{start_of_day_utc(now, tz)}"},
    )
    counts: dict[str, int] = {}
    for r in rows:
        mid = r.get("medication_id")
        if mid:
            counts[mid] = counts.get(mid, 0) + 1
    return counts


async def show_schedule(ctx: ToolContext, view: str = "today") -> str:
    tz = get_settings().hermes_tz
    now = datetime.now(UTC)
    meds = await ctx.db().select(
        "medications",
        columns="id,name,dosage,schedule,priority",
        filters={"archived": "eq.false"},
    )
    if not meds:
        return "No medications are on file yet."
    if view == "week":
        return render_week(meds)
    taken = await _taken_counts_today(ctx, now, tz)
    return render_today(meds, taken, now, tz)


register(_SCHEMA, show_schedule)
