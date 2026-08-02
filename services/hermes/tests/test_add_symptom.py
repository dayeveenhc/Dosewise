"""add_symptom — immediate symptom journaling to accessibility.symptom_reports.

A health report must never be blocked by medication-name matching: a resolved
name attaches medication_id + canonical name; a miss/ambiguous name keeps the
free text and says so. Severe-sounding symptoms get a doctor-question NUDGE in
the reply — never an automatic escalation (no doctor_questions insert).
"""

from __future__ import annotations

from fakes import FakeDB
from helpers import reread_rows
from hermes.tools.base import get_handler
from test_tools import ELDER_A, _ctx


def _db(meds: list | None = None, accessibility: dict | None = None) -> FakeDB:
    return FakeDB({
        "medications": list(meds or []),
        "profiles": [{"id": ELDER_A, "accessibility": dict(accessibility or {})}],
        "doctor_questions": [],
    })


async def test_records_symptom_with_resolved_medication():
    db = _db(meds=[{"id": "m1", "name": "Metformin", "archived": False}])
    ctx = _ctx(db)
    out = await get_handler("add_symptom")(
        ctx, symptom="feeling dizzy", medication_name="metformin"
    )
    assert "dizzy" in out and "Metformin" in out

    rows = await reread_rows(db, "profiles", id=ELDER_A)
    reports = rows[0]["accessibility"]["symptom_reports"]
    assert len(reports) == 1
    entry = reports[0]
    assert entry["symptom"] == "feeling dizzy"
    assert entry["medication_id"] == "m1"
    assert entry["medication_name"] == "Metformin"  # canonical, not the echo
    assert entry["id"] and entry["noted_at"]

    assert len(ctx.committed_actions) == 1
    action = ctx.committed_actions[0]
    assert action["tool"] == "add_symptom"
    assert action["entity_type"] == "symptom"
    assert action["entity_id"] == entry["id"]
    assert action["medication_name"] == "Metformin"
    assert action["changed_fields"] == {
        "symptom": {"before": None, "after": "feeling dizzy"}
    }


async def test_unmatched_med_name_still_records_with_free_text():
    db = _db(meds=[])
    ctx = _ctx(db)
    out = await get_handler("add_symptom")(
        ctx, symptom="stomach ache", medication_name="mystery pills"
    )
    # Never blocked on name matching — recorded, with the caveat surfaced.
    assert "kept it as written" in out
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    entry = rows[0]["accessibility"]["symptom_reports"][0]
    assert entry["medication_name"] == "mystery pills"
    assert "medication_id" not in entry
    assert ctx.committed_actions[0]["medication_name"] == "mystery pills"


async def test_no_medication_named_records_symptom_alone():
    db = _db()
    ctx = _ctx(db)
    await get_handler("add_symptom")(ctx, symptom="a mild itch")
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    entry = rows[0]["accessibility"]["symptom_reports"][0]
    assert entry["symptom"] == "a mild itch"
    assert "medication_id" not in entry and "medication_name" not in entry
    assert "medication_name" not in ctx.committed_actions[0]


async def test_appends_and_preserves_other_accessibility_keys():
    db = _db(accessibility={
        "medical_profile": "Has diabetes.",
        "symptom_reports": [{"id": "old1", "symptom": "headache",
                             "noted_at": "2026-07-25T02:00:00+00:00"}],
    })
    ctx = _ctx(db)
    await get_handler("add_symptom")(ctx, symptom="blurry vision")
    rows = await reread_rows(db, "profiles", id=ELDER_A)
    access = rows[0]["accessibility"]
    assert [r["symptom"] for r in access["symptom_reports"]] == [
        "headache", "blurry vision",
    ]
    assert access["medical_profile"] == "Has diabetes."  # read-merge-write


async def test_severe_sounding_symptom_nudges_doctor_question_never_escalates():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("add_symptom")(ctx, symptom="chest pain")
    assert "add_doctor_question" in out  # the nudge for Mei to OFFER
    # ...but nothing was auto-queued or escalated.
    assert await reread_rows(db, "doctor_questions") == []
    assert [t for t, _ in db.inserted] == []
    # Mild symptoms don't get the doctor push.
    out = await get_handler("add_symptom")(ctx, symptom="a mild itch")
    assert "add_doctor_question" not in out


async def test_empty_symptom_asks_and_writes_nothing():
    db = _db()
    ctx = _ctx(db)
    out = await get_handler("add_symptom")(ctx, symptom="   ")
    assert "Ask the patient" in out
    assert not db.updated and not ctx.committed_actions
