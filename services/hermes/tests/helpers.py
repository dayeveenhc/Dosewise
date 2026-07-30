"""Shared verification helpers for the offline tool tests.

Every new-tool test verifies through an INDEPENDENT re-read (a fresh select on
the same FakeDB) rather than trusting the tool's reply or the write log alone —
the offline mirror of the live e2e pattern (write, then re-query real state).
"""

from __future__ import annotations

from datetime import datetime


async def reread_rows(db, table: str, **eq_filters) -> list[dict]:
    """Independent re-read: rows of ``table`` matching simple equality filters.

    ``reread_rows(db, "doses", medication_id="m1")`` selects with
    ``{"medication_id": "eq.m1"}`` — a second query through the same client, so
    the assertion sees what a later reader would, not what the writer claimed.
    """
    filters = {col: f"eq.{val}" for col, val in eq_filters.items()}
    return await db.select(table, filters=filters)


def assert_row(rows: list[dict], **expected) -> dict:
    """Assert exactly ONE row carries every ``expected`` field/value; return it."""
    matching = [
        r for r in rows if all(r.get(k) == v for k, v in expected.items())
    ]
    assert len(matching) == 1, (
        f"expected exactly one row matching {expected!r}, "
        f"found {len(matching)} in {rows!r}"
    )
    return matching[0]


def pin_clock(monkeypatch, fixed_utc: datetime, tz: str = "Asia/Singapore") -> None:
    """Pin the dose tools' clock seam AND the elder timezone.

    Mirrors test_log_dose's ``_pin_clock``: patches
    ``hermes.tools.doses._now_utc`` and ``get_settings().hermes_tz`` so
    due/missed/undo computations are deterministic.
    """
    from hermes.config import get_settings
    from hermes.tools import doses

    monkeypatch.setattr(doses, "_now_utc", lambda: fixed_utc)
    monkeypatch.setattr(get_settings(), "hermes_tz", tz, raising=False)
