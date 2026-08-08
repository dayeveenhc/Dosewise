"""Pure unit tests for the schedule→reminder helpers (dosing.py)."""

from __future__ import annotations

from datetime import UTC, date, datetime, time

from hermes.dosing import due_reminders, in_quiet_hours, scheduled_today, start_of_day_utc

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _med(times, *, priority="standard", mid="m1"):
    return {"id": mid, "elder_id": ELDER_A, "name": "Metformin",
            "priority": priority, "schedule": {"times": times}}


def test_due_reminders_returns_past_slots_today():
    now = datetime(2026, 7, 2, 20, 5, tzinfo=UTC)
    due = due_reminders([_med(["08:00", "20:00"])], now=now, tz="UTC")
    times = {d["time"] for d in due}
    assert times == {"08:00", "20:00"}
    assert {d["key"] for d in due} == {"m1|2026-07-02|08:00", "m1|2026-07-02|20:00"}


def test_due_reminders_excludes_future_slots():
    now = datetime(2026, 7, 2, 20, 5, tzinfo=UTC)
    due = due_reminders([_med(["20:00", "22:00"])], now=now, tz="UTC")
    assert {d["time"] for d in due} == {"20:00"}


def test_due_reminders_respects_timezone():
    # 08:00 Singapore == 00:00 UTC; at 00:30 UTC the 08:00 SGT slot is due.
    now = datetime(2026, 7, 2, 0, 30, tzinfo=UTC)
    due = due_reminders([_med(["08:00"])], now=now, tz="Asia/Singapore")
    assert len(due) == 1
    assert due[0]["scheduled_utc"] == "2026-07-02T00:00:00+00:00"


def test_due_reminders_skips_malformed_times():
    now = datetime(2026, 7, 2, 20, 5, tzinfo=UTC)
    due = due_reminders([_med(["8am", "20:00", None])], now=now, tz="UTC")
    assert {d["time"] for d in due} == {"20:00"}


def test_due_reminders_weekly_only_on_matching_weekday():
    # 2026-07-02 is a Thursday.
    now = datetime(2026, 7, 2, 20, 5, tzinfo=UTC)
    thu_med = {"id": "m1", "elder_id": ELDER_A, "name": "Metho", "priority": "standard",
               "schedule": {"times": ["08:00"], "days": ["thu"], "frequency": "weekly"}}
    mon_med = {"id": "m2", "elder_id": ELDER_A, "name": "Other", "priority": "standard",
               "schedule": {"times": ["08:00"], "days": ["mon"], "frequency": "weekly"}}
    due = due_reminders([thu_med, mon_med], now=now, tz="UTC")
    assert {d["medication_id"] for d in due} == {"m1"}


def test_due_reminders_daily_unchanged_without_days():
    now = datetime(2026, 7, 2, 20, 5, tzinfo=UTC)
    due = due_reminders([_med(["08:00"])], now=now, tz="UTC")
    assert len(due) == 1


def test_in_quiet_hours_wraparound():
    quiet = {"start": "22:00", "end": "07:00"}
    assert in_quiet_hours(time(23, 0), quiet) is True
    assert in_quiet_hours(time(6, 0), quiet) is True
    assert in_quiet_hours(time(12, 0), quiet) is False


def test_in_quiet_hours_same_day_window_and_missing():
    assert in_quiet_hours(time(12, 0), {"start": "09:00", "end": "17:00"}) is True
    assert in_quiet_hours(time(8, 0), {"start": "09:00", "end": "17:00"}) is False
    assert in_quiet_hours(time(12, 0), None) is False
    assert in_quiet_hours(time(12, 0), {"start": "bad"}) is False


def test_start_of_day_utc():
    now = datetime(2026, 7, 2, 21, 0, tzinfo=UTC)
    assert start_of_day_utc(now, "UTC") == "2026-07-02T00:00:00+00:00"
    # Local midnight in Singapore for 07-03 05:00 SGT is 07-02 16:00 UTC.
    assert start_of_day_utc(now, "Asia/Singapore") == "2026-07-02T16:00:00+00:00"


# --- scheduled_today: fixed courses (schedule.end_date) --------------------
# These mirror apps/web/src/app/lib/medications.ts::isDueOn one-for-one. The two
# engines have to agree, or the app shows one cadence and the reminder scheduler
# sends another — the divergence interval_days used to have.

def test_scheduled_today_before_course_end_is_due():
    assert scheduled_today({"end_date": "2026-07-10"}, date(2026, 7, 5)) is True


def test_scheduled_today_on_course_end_is_due_end_date_is_inclusive():
    assert scheduled_today({"end_date": "2026-07-10"}, date(2026, 7, 10)) is True


def test_scheduled_today_after_course_end_is_not_due():
    assert scheduled_today({"end_date": "2026-07-10"}, date(2026, 7, 11)) is False


def test_scheduled_today_course_end_beats_the_weekday_cadence():
    # A Friday medicine, one day past its course: the course wins.
    sched = {"days": ["fri"], "end_date": "2026-07-10"}
    assert scheduled_today(sched, date(2026, 7, 17)) is False


def test_scheduled_today_garbage_end_date_fails_open():
    # A medication that silently stops reminding is worse than one that reminds
    # a day too long.
    assert scheduled_today({"end_date": "not-a-date"}, date(2026, 7, 11)) is True
    assert scheduled_today({"end_date": None}, date(2026, 7, 11)) is True


# --- scheduled_today: interval cadence (schedule.interval_days) ------------

def test_scheduled_today_interval_on_an_anchor_day():
    sched = {"interval_days": 2, "start_date": "2026-07-01"}
    assert scheduled_today(sched, date(2026, 7, 3)) is True


def test_scheduled_today_interval_on_an_off_day():
    sched = {"interval_days": 2, "start_date": "2026-07-01"}
    assert scheduled_today(sched, date(2026, 7, 4)) is False


def test_scheduled_today_interval_without_an_anchor_fails_open():
    # buildSchedule only writes start_date on the interval branch and
    # set_medication_reminder never writes it, so anchorless rows are real.
    assert scheduled_today({"interval_days": 3}, date(2026, 7, 4)) is True


def test_scheduled_today_interval_of_one_is_daily():
    sched = {"interval_days": 1, "start_date": "2026-07-01"}
    assert scheduled_today(sched, date(2026, 7, 4)) is True


def test_scheduled_today_plain_schedule_is_unchanged():
    # The backward-compatibility guarantee: no days, no interval, no end_date.
    assert scheduled_today({"times": ["08:00"]}, date(2026, 7, 4)) is True
