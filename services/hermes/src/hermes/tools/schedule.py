"""Daily medication timeline: show_schedule.

Renders today's medicines as a chronological timeline with a taken/due/upcoming
status per slot, so the elder can see their day at a glance (and, on Telegram, tap
to log a dose). Doses aren't materialised per-slot (the full calendar is deferred),
so status is approximated: the earliest N slots of a medication are marked taken
when N doses have been logged taken today.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..dosing import (
    WEEKDAY_NAMES,
    WEEKDAYS,
    _parse_hhmm,
    scheduled_today,
    start_of_day_utc,
    start_of_week_utc,
)
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



def render_today(meds: list[dict], taken_by_med: dict[str, int], now: datetime, tz: str) -> str:
    """Build the plain-text timeline for today. Pure — no DB, for easy testing."""
    zone = ZoneInfo(tz)
    local_now = now.astimezone(zone)
    local_today = local_now.date()
    day_name = WEEKDAY_NAMES[WEEKDAYS[local_today.weekday()]]
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


def render_week(
    meds: list[dict],
    taken: dict[tuple[str, date], int],
    now: datetime,
    tz: str,
) -> str:
    """The current week (Mon–Sun, real dates) with a live status per dose slot.

    ``taken`` maps (medication_id, local date) -> doses logged taken that day. The
    same earliest-N approximation as ``render_today`` marks which slots were taken;
    past slots without a logged dose show ❌ missed. Pure — no DB, for easy testing.
    """
    zone = ZoneInfo(tz)
    local_now = now.astimezone(zone)
    local_today = local_now.date()
    monday = local_today - timedelta(days=local_today.weekday())

    lines = ["This week:"]
    for offset in range(7):
        day = monday + timedelta(days=offset)
        heading = f"{WEEKDAY_NAMES[WEEKDAYS[day.weekday()]]} {day.strftime('%d %b')}"
        if day == local_today:
            heading += " (today)"
        lines.append(f"\n{heading}:")
        rows: list[str] = []
        for med in meds:
            schedule = med.get("schedule") or {}
            if not scheduled_today(schedule, day):
                continue
            label = med.get("name") or "your medicine"
            if med.get("dosage"):
                label += f" {med['dosage']}"
            times = sorted(t for t in (schedule.get("times") or []) if _parse_hhmm(t))
            if not times:
                rows.append(f"  💊 {label} (as directed)")
                continue
            taken_left = taken.get((med.get("id"), day), 0)
            slots: list[str] = []
            for hhmm in times:
                if taken_left > 0:
                    status = "✅ taken"
                    taken_left -= 1
                elif day < local_today:
                    status = "❌ missed"
                elif day == local_today and _parse_hhmm(hhmm) <= local_now.time():
                    status = "⏳ due now"
                else:
                    status = "🕗 upcoming"
                slots.append(f"{hhmm} {status}")
            rows.append(f"  💊 {label} — {', '.join(slots)}")
        lines.extend(rows) if rows else lines.append("  —")
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


async def _taken_counts_week(
    ctx: ToolContext, now: datetime, tz: str
) -> dict[tuple[str, date], int]:
    """Doses logged taken this week, per (medication_id, local date) (RLS-scoped)."""
    zone = ZoneInfo(tz)
    rows = await ctx.db().select(
        "doses",
        columns="medication_id,scheduled_at",
        filters={"status": "eq.taken", "scheduled_at": f"gte.{start_of_week_utc(now, tz)}"},
    )
    counts: dict[tuple[str, date], int] = {}
    for r in rows:
        mid = r.get("medication_id")
        try:
            when = datetime.fromisoformat(str(r.get("scheduled_at")))
        except ValueError:
            continue
        if when.tzinfo is None:  # naive timestamps are stored UTC
            when = when.replace(tzinfo=UTC)
        if mid:
            key = (mid, when.astimezone(zone).date())
            counts[key] = counts.get(key, 0) + 1
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
        taken_week = await _taken_counts_week(ctx, now, tz)
        return render_week(meds, taken_week, now, tz)
    taken = await _taken_counts_today(ctx, now, tz)
    return render_today(meds, taken, now, tz)


register(_SCHEMA, show_schedule)
