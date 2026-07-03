"""Reminder scheduler — the VPS cron that nudges elders about due medications.

Runs in-process as a background task (started from the FastAPI lifespan) so it
shares the live ``SessionRegistry`` chat mapping and the ``TelegramClient`` with
the poller. The full dose *calendar* is deferred with the frontend; instead every
tick reads each elder's active medications **as the service role** (cron is the one
place the architecture sanctions the service role), expands their
``schedule.times`` into today's due slots, and:

* DMs the **elder** a reminder for each slot that just became due (suppressed
  during the caregiver-configured quiet hours);
* DMs the **linked caregiver** when a *critical* medication is overdue past
  ``missed_dose_minutes`` **and no dose was logged taken today** (the dyad safety
  net) — mirroring ``message_caregiver``. Quiet hours never suppress this.

Delivery is best-effort: it can only reach a person who has chatted with the bot
(that's what populates the chat mapping). Dedupe is in-memory, keyed on
``med|localdate|HH:MM``, so a restart may re-send at most one reminder per slot.

With no mobile app there is no Expo Push; Telegram is the delivery channel.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..db.supabase import Supabase
from ..dosing import due_reminders, in_quiet_hours, start_of_day_utc
from .session import SessionRegistry

log = logging.getLogger("hermes.scheduler")


async def _elder_quiet_hours(svc, elder_id: str) -> dict | None:
    """The elder's quiet-hours window from their first active care-link, or None."""
    links = await svc.select(
        "care_links",
        columns="permissions",
        filters={"elder_id": f"eq.{elder_id}", "status": "eq.active"},
        limit=1,
    )
    if not links:
        return None
    return (links[0].get("permissions") or {}).get("quiet_hours")


async def _taken_today(svc, elder_id: str, medication_id: str, now: datetime, tz: str) -> bool:
    """True if a dose of this medication was logged taken since local midnight."""
    rows = await svc.select(
        "doses",
        columns="id",
        filters={
            "medication_id": f"eq.{medication_id}",
            "status": "eq.taken",
            "scheduled_at": f"gte.{start_of_day_utc(now, tz)}",
        },
        limit=1,
    )
    return bool(rows)


async def _tick(
    *,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram,
    now: datetime,
    tz: str,
    window: timedelta,
    missed_after: timedelta,
    reminded: set[str],
    missed_flagged: set[str],
) -> None:
    svc = supabase.service_client()
    meds = await svc.select(
        "medications",
        columns="id,elder_id,name,priority,schedule",
        filters={"archived": "eq.false"},
    )
    due = due_reminders(meds, now=now, tz=tz)
    local_time = now.astimezone(ZoneInfo(tz)).time()
    quiet_cache: dict[str, dict | None] = {}

    for slot in due:
        key = slot["key"]
        elder_id = slot["elder_id"]
        name = slot["name"]
        overdue = now - datetime.fromisoformat(slot["scheduled_utc"])

        # 1. Elder reminder — only for slots that *just* became due, once per slot,
        #    and not during quiet hours (which we don't mark reminded, so a slot
        #    silenced overnight simply lapses rather than firing at dawn).
        if key not in reminded and overdue <= window:
            if elder_id not in quiet_cache:
                quiet_cache[elder_id] = await _elder_quiet_hours(svc, elder_id)
            chat_id = registry.chat_for_profile(elder_id)
            if chat_id is not None and not in_quiet_hours(local_time, quiet_cache[elder_id]):
                await telegram.send_message(
                    chat_id,
                    f"⏰ Reminder: it's time for your {name} ({slot['time']}). "
                    "Tell me once you've taken it and I'll log it.",
                )
                reminded.add(key)
                log.info("reminded elder %s about %s (%s)", elder_id, name, slot["time"])

        # 2. Missed-critical caregiver alert — overdue past the window, critical, and
        #    no dose logged taken today. Never suppressed by quiet hours.
        if (
            slot["priority"] == "critical"
            and key not in missed_flagged
            and overdue >= missed_after
            and not await _taken_today(svc, elder_id, slot["medication_id"], now, tz)
        ):
            await _alert_caregivers(
                svc, registry, telegram, elder_id=elder_id, med_name=name
            )
            missed_flagged.add(key)


async def _alert_caregivers(
    svc, registry: SessionRegistry, telegram, *, elder_id: str, med_name: str
) -> None:
    links = await svc.select(
        "care_links",
        columns="caregiver_id",
        filters={"elder_id": f"eq.{elder_id}", "status": "eq.active"},
    )
    for link in links:
        chat_id = registry.chat_for_profile(link["caregiver_id"])
        if chat_id is not None:
            await telegram.send_message(
                chat_id,
                f"⚠️ Dosewise alert: a critical dose of {med_name} looks "
                "missed (overdue and not yet logged). You may want to check in.",
            )
            log.info("alerted caregiver %s for elder %s", link["caregiver_id"], elder_id)


async def reminder_loop(
    *,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram,
) -> None:
    settings = get_settings()
    poll = settings.reminder_poll_seconds
    tz = settings.hermes_tz
    # Freshness window for elder reminders: at least two poll intervals so a slot is
    # never missed between ticks, and never fires for times long past (e.g. on start).
    window = timedelta(seconds=max(2 * poll, 120))
    missed_after = timedelta(minutes=settings.missed_dose_minutes)
    reminded: set[str] = set()
    missed_flagged: set[str] = set()
    log.info("reminder scheduler started (every %ss, tz=%s)", poll, tz)

    while True:
        try:
            await _tick(
                supabase=supabase,
                registry=registry,
                telegram=telegram,
                now=datetime.now(UTC),
                tz=tz,
                window=window,
                missed_after=missed_after,
                reminded=reminded,
                missed_flagged=missed_flagged,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("reminder tick failed; will retry", exc_info=True)
        await asyncio.sleep(poll)
