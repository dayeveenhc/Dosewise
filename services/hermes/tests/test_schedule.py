"""Schedule timeline rendering (Item 5)."""

from __future__ import annotations

from datetime import UTC, date, datetime

from hermes.dosing import start_of_week_utc
from hermes.tools.schedule import render_today, render_week

ELDER_A = "00000000-0000-0000-0000-00000000000a"


def _med(mid, name, times, **schedule):
    return {"id": mid, "name": name, "dosage": None,
            "schedule": {"times": times, **schedule}}


def test_render_today_marks_taken_due_and_upcoming():
    # 2026-07-02 is a Thursday; noon local (UTC here).
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    meds = [_med("m1", "Metformin", ["08:00", "20:00"])]
    out = render_today(meds, {"m1": 1}, now, "UTC")
    # 08:00 slot taken (1 logged), 20:00 upcoming (after noon).
    assert "08:00" in out and "✅ taken" in out
    assert "20:00" in out and "🕗 upcoming" in out
    assert "Thursday" in out


def test_render_today_due_when_past_and_not_taken():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    out = render_today([_med("m1", "Metformin", ["08:00"])], {}, now, "UTC")
    assert "⏳ due now" in out


def test_render_today_skips_weekly_med_off_day():
    # Thursday: a Monday-only med should not appear.
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)
    meds = [_med("m1", "Weekly", ["08:00"], days=["mon"], frequency="weekly")]
    out = render_today(meds, {}, now, "UTC")
    assert "No medicines" in out


# 2026-07-02 is a Thursday; the week runs Mon 29 Jun .. Sun 05 Jul.
_NOW = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)


def test_render_week_lists_days():
    meds = [_med("m1", "Metformin", ["08:00"]),
            _med("m2", "Methotrexate", ["09:00"], days=["thu"], frequency="weekly")]
    out = render_week(meds, {}, _NOW, "UTC")
    assert "Monday 29 Jun:" in out and "Thursday 02 Jul (today):" in out
    # Daily med shows every day; weekly med only under Thursday.
    assert out.count("Metformin") == 7
    assert out.count("Methotrexate") == 1


def test_render_week_statuses_past_today_and_future():
    meds = [_med("m1", "Metformin", ["08:00"])]
    taken = {("m1", date(2026, 6, 29)): 1}  # Monday's dose was logged
    out = render_week(meds, taken, _NOW, "UTC")
    # Map each day heading to its med line by walking the output.
    by_day = {}
    current = None
    for line in out.splitlines():
        if line.endswith(":") and not line.startswith("  "):
            current = line
        elif "💊" in line and current:
            by_day[current] = line
    assert "✅ taken" in by_day["Monday 29 Jun:"]           # logged -> taken
    assert "❌ missed" in by_day["Tuesday 30 Jun:"]          # past, unlogged
    assert "⏳ due now" in by_day["Thursday 02 Jul (today):"]  # today, past 08:00
    assert "🕗 upcoming" in by_day["Friday 03 Jul:"]         # future


def test_render_week_med_without_times_shows_as_directed():
    out = render_week([_med("m1", "Insulin", [])], {}, _NOW, "UTC")
    assert "Insulin (as directed)" in out
    assert "missed" not in out


def test_start_of_week_utc_monday_boundary_non_utc_tz():
    # Thu 2026-07-02 04:00 SGT is Wed 20:00 UTC — the local week still starts
    # Mon 2026-06-29 00:00 SGT = Sun 2026-06-28 16:00 UTC.
    now = datetime(2026, 7, 1, 20, 0, tzinfo=UTC)
    assert start_of_week_utc(now, "Asia/Singapore") == "2026-06-28T16:00:00+00:00"
    assert start_of_week_utc(now, "UTC") == "2026-06-29T00:00:00+00:00"
