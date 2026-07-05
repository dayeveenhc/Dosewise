"""Schedule → reminder helpers (pure, timezone-aware).

The full dose *calendar* (materializing `doses` rows for a UI) is deferred until the
frontend lands. For now Hermes reminds the elder of each medication at each of its
scheduled wall-clock times, computed directly from ``medications.schedule.times``.

``schedule.times`` are wall-clock ``HH:MM`` strings interpreted in ``HERMES_TZ``
(elders are in Singapore for the demo); everything else in the system stores UTC.
These functions are pure so they can be unit-tested without a clock or a DB.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

# Weekday tokens (Monday=0, matching date.weekday()) used by weekly schedules.
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _parse_hhmm(value: str | None) -> time | None:
    try:
        hh, mm = str(value).split(":")
        return time(int(hh), int(mm))
    except (ValueError, AttributeError):
        return None


def scheduled_today(schedule: dict, local_today: date) -> bool:
    """Whether a medication's schedule fires on ``local_today``.

    Backward compatible: a schedule with no ``days`` (or ``frequency`` != weekly)
    fires every day, exactly as before. A weekly schedule fires only when today's
    weekday token is listed in ``schedule.days`` (e.g. ``["mon", "thu"]``).
    """
    days = schedule.get("days")
    if not days:
        return True
    tokens = {str(d).strip().lower()[:3] for d in days}
    return WEEKDAYS[local_today.weekday()] in tokens


def due_reminders(meds: list[dict], *, now: datetime, tz: str) -> list[dict]:
    """Today's medication slots whose scheduled time is at/before ``now``.

    ``meds`` rows carry ``id, elder_id, name, priority, schedule``. Returns one dict
    per (med, time) slot due today: ``{medication_id, elder_id, name, priority,
    time, scheduled_utc, key}``. ``key`` (``med|localdate|HH:MM``) is the stable
    dedupe handle. The caller decides which slots are *fresh* enough to remind on and
    which are *overdue* enough to escalate — this only enumerates due slots.
    """
    zone = ZoneInfo(tz)
    local_today = now.astimezone(zone).date()
    out: list[dict] = []
    for med in meds:
        schedule = med.get("schedule") or {}
        if not scheduled_today(schedule, local_today):
            continue
        for hhmm in schedule.get("times") or []:
            t = _parse_hhmm(hhmm)
            if t is None:
                continue
            scheduled_utc = datetime.combine(local_today, t, tzinfo=zone).astimezone(UTC)
            if scheduled_utc <= now:
                out.append(
                    {
                        "medication_id": med.get("id"),
                        "elder_id": med.get("elder_id"),
                        "name": med.get("name") or "your medication",
                        "priority": med.get("priority"),
                        "time": hhmm,
                        "scheduled_utc": scheduled_utc.isoformat(),
                        "key": f"{med.get('id')}|{local_today.isoformat()}|{hhmm}",
                    }
                )
    return out


def in_quiet_hours(local_time: time, quiet: dict | None) -> bool:
    """True if ``local_time`` falls inside a ``{start, end}`` quiet window.

    Handles wrap-around windows (e.g. ``22:00`` → ``07:00``). Missing/malformed
    bounds mean "no quiet hours" (never suppress).
    """
    if not quiet:
        return False
    start = _parse_hhmm(quiet.get("start"))
    end = _parse_hhmm(quiet.get("end"))
    if start is None or end is None:
        return False
    if start <= end:
        return start <= local_time < end
    return local_time >= start or local_time < end


def start_of_day_utc(now: datetime, tz: str) -> str:
    """ISO UTC timestamp for local midnight of ``now``'s day — for 'taken today?'."""
    zone = ZoneInfo(tz)
    local_midnight = datetime.combine(now.astimezone(zone).date(), time(0, 0), tzinfo=zone)
    return local_midnight.astimezone(UTC).isoformat()
