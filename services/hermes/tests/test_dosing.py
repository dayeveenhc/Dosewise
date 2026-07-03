"""Pure unit tests for the schedule→reminder helpers (dosing.py)."""

from __future__ import annotations

from datetime import UTC, datetime, time

from hermes.dosing import due_reminders, in_quiet_hours, start_of_day_utc

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
