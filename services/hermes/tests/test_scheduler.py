"""Tests for the reminder scheduler tick (channels/scheduler.py).

The scheduler now reminds from ``medications.schedule.times`` directly (no dose
materialization), so these seed medications rather than pending doses.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fakes import FakeDB, FakeSupabase, FakeTelegram
from hermes.channels.scheduler import _tick
from hermes.channels.session import SessionRegistry

ELDER_A = "00000000-0000-0000-0000-00000000000a"
CAREGIVER_C = "00000000-0000-0000-0000-00000000000c"
WINDOW = timedelta(minutes=5)
MISSED = timedelta(minutes=60)


def _med(times, *, priority="standard", mid="m1"):
    return {"id": mid, "elder_id": ELDER_A, "name": "Metformin", "priority": priority,
            "schedule": {"times": times}, "archived": False}


async def _run(db, registry, tg, now, **kw):
    await _tick(
        supabase=FakeSupabase(db=db), registry=registry, telegram=tg, now=now,
        tz="UTC", window=WINDOW, missed_after=MISSED,
        reminded=kw.get("reminded", set()), missed_flagged=kw.get("missed_flagged", set()),
    )


async def test_tick_reminds_elder_from_schedule_once():
    now = datetime(2026, 7, 2, 20, 1, tzinfo=UTC)  # 1 min after a 20:00 slot
    db = FakeDB({"medications": [_med(["20:00"], priority="critical")],
                 "care_links": [], "doses": []})
    registry = SessionRegistry(ELDER_A)
    registry._profile_to_chat[ELDER_A] = 111
    tg = FakeTelegram()
    reminded: set[str] = set()

    await _run(db, registry, tg, now, reminded=reminded)
    assert reminded == {"m1|2026-07-02|20:00"}
    assert tg.sent and tg.sent[0][0] == 111 and "Metformin" in tg.sent[0][1]

    # Second tick: deduped by `reminded`.
    await _run(db, registry, tg, now, reminded=reminded)
    assert len(tg.sent) == 1


async def test_tick_no_stale_reminder_on_late_start():
    # Bot wakes at 23:00 with an 08:00 slot — far past the freshness window.
    now = datetime(2026, 7, 2, 23, 0, tzinfo=UTC)
    db = FakeDB({"medications": [_med(["08:00"])], "care_links": [], "doses": []})
    registry = SessionRegistry(ELDER_A)
    registry._profile_to_chat[ELDER_A] = 111
    tg = FakeTelegram()
    await _run(db, registry, tg, now)
    assert tg.sent == []


async def test_tick_alerts_caregiver_on_missed_critical():
    now = datetime(2026, 7, 2, 21, 0, tzinfo=UTC)  # 2h after a 19:00 critical slot
    db = FakeDB({
        "medications": [_med(["19:00"], priority="critical")],
        "care_links": [{"caregiver_id": CAREGIVER_C, "elder_id": ELDER_A,
                        "status": "active", "permissions": {}}],
        "doses": [],
    })
    registry = SessionRegistry(ELDER_A)
    registry._profile_to_chat[ELDER_A] = 111
    registry._profile_to_chat[CAREGIVER_C] = 222
    tg = FakeTelegram()
    await _run(db, registry, tg, now)
    recipients = {chat for chat, _ in tg.sent}
    assert recipients == {222}  # elder slot too stale to remind; caregiver alerted
    assert any("alert" in text.lower() for _, text in tg.sent)


async def test_tick_no_alert_when_dose_taken_today():
    now = datetime(2026, 7, 2, 21, 0, tzinfo=UTC)
    db = FakeDB({
        "medications": [_med(["19:00"], priority="critical")],
        "care_links": [{"caregiver_id": CAREGIVER_C, "elder_id": ELDER_A,
                        "status": "active", "permissions": {}}],
        "doses": [{"id": "d1", "medication_id": "m1", "elder_id": ELDER_A,
                   "status": "taken", "scheduled_at": "2026-07-02T19:30:00+00:00"}],
    })
    registry = SessionRegistry(ELDER_A)
    registry._profile_to_chat[ELDER_A] = 111
    registry._profile_to_chat[CAREGIVER_C] = 222
    tg = FakeTelegram()
    await _run(db, registry, tg, now)
    assert tg.sent == []  # logged taken -> no caregiver alert, slot too stale to remind


async def test_tick_quiet_hours_suppress_elder_not_caregiver():
    now = datetime(2026, 7, 2, 23, 1, tzinfo=UTC)  # inside 22:00-07:00 quiet window
    db = FakeDB({
        "medications": [
            _med(["23:00"], priority="standard", mid="m1"),   # fresh -> would remind
            _med(["21:00"], priority="critical", mid="m2"),   # overdue -> alert
        ],
        "care_links": [{"caregiver_id": CAREGIVER_C, "elder_id": ELDER_A,
                        "status": "active",
                        "permissions": {"quiet_hours": {"start": "22:00", "end": "07:00"}}}],
        "doses": [],
    })
    registry = SessionRegistry(ELDER_A)
    registry._profile_to_chat[ELDER_A] = 111
    registry._profile_to_chat[CAREGIVER_C] = 222
    tg = FakeTelegram()
    reminded: set[str] = set()
    await _run(db, registry, tg, now, reminded=reminded)
    recipients = {chat for chat, _ in tg.sent}
    assert 111 not in recipients      # elder reminder suppressed by quiet hours
    assert 222 in recipients          # caregiver alert pierces quiet hours
    assert reminded == set()          # suppressed slot not marked, can fire later
