"""Schedule timeline rendering (Item 5)."""

from __future__ import annotations

from datetime import UTC, datetime

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


def test_render_week_lists_days():
    meds = [_med("m1", "Metformin", ["08:00"]),
            _med("m2", "Methotrexate", ["09:00"], days=["thu"], frequency="weekly")]
    out = render_week(meds)
    assert "Monday:" in out and "Thursday:" in out
    # Daily med shows every day; weekly med only under Thursday.
    assert out.count("Metformin") == 7
    assert out.count("Methotrexate") == 1
