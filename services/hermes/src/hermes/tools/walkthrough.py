"""Guided walkthrough handoff: start_walkthrough.

Queues a scripted UI walkthrough for the web client to run.

Two families, and the difference matters: a spotlight-and-narrate walkthrough
only points, and the patient performs every tap themselves; the ``*_auto``
walkthroughs (and the auto-advanced ``*_tour`` ones) have Mei drive the screen
herself, visibly animated. Even then nothing COMMITS on autopilot — every
``*_auto`` flow ends on a Save the patient taps, and consent-bearing steps
(placing a call, accepting a caregiver link) are always the patient's own action.

The step content itself (which element to highlight, what to say, what ends the
step) is data owned entirely by the web client
(``apps/web/src/app/lib/walkthrough/steps/``); this tool only names which script
to run, so new walkthroughs can be added without touching agent logic.
Only meaningful in the app channel — there are no spotlightable screens on Telegram.
"""

from __future__ import annotations

from .base import ToolContext, register
from .risk import assess_risk

# Keep in sync with the task names the web client's step library actually defines
# (apps/web/src/app/lib/walkthrough/steps/*.ts).
TASK_NAMES = [
    "onboarding",
    "travel_mode_setup",
    "request_refill",
    "link_caregiver",
    # Guided Auto-Navigation (autonomous): Mei fills in and submits the
    # prescription herself, then verifies it really saved before confirming.
    "add_prescription_auto",
    "add_condition_auto",
    "travel_mode_auto",
    "edit_profile_auto",
    "add_doctor_question_auto",
    "accept_caregiver_link",
    # Spotlight-and-narrate only: the patient performs every step themselves.
    # These cover settings and everyday actions rather than data entry, so
    # there is nothing to fill in and nothing to verify afterwards.
    "check_schedule",
    "log_dose",
    "undo_dose",
    "reminder_settings",
    "text_size",
    # Spotlight tours (2026-07-26): Mei auto-advances the spotlight herself at
    # the slow walkthrough pace; consent steps still need the patient's own tap.
    "language_voice_tour",
    "notifications_tour",
    "emergency_contact_tour",
    "caregiver_view_toggle_tour",
    "patient_schedule_tour",
    "weekly_summary_tour",
]

# Which app shell each walkthrough's screens live in. The elder and caregiver
# shells render completely different screens, so a walkthrough offered to the
# wrong one spotlights elements that can never exist there. Mirrors the
# client-side derivation in apps/web/src/app/lib/walkthrough/steps/index.ts
# (walkthroughShellFor), which is the real guard — this drives what the prompt
# even offers, so the bad suggestion is never made in the first place.
CAREGIVER_ONLY_TASKS = frozenset({
    "caregiver_view_toggle_tour",
    "patient_schedule_tour",
    "weekly_summary_tour",
})

# link_caregiver resolves to a different script per role, so it belongs to both.
ELDER_ONLY_TASKS = frozenset(
    set(TASK_NAMES) - CAREGIVER_ONLY_TASKS - {"link_caregiver"}
)

# The autonomous family: these are NOT one-time introductions, they are HOW the
# write gets performed (Mei fills the real form and the patient taps Save). So
# "already shown" must never apply to them — a patient adding their second
# medicine has to get the same guided save as their first. Treating them as a
# tutorial is what made "the walkthrough for adding medicine doesn't work any
# more" true the moment a patient had added one medicine.
AUTONOMOUS_TASKS = frozenset({
    "add_prescription_auto",
    "add_condition_auto",
    "travel_mode_auto",
    "edit_profile_auto",
    "add_doctor_question_auto",
    "accept_caregiver_link",
})

# The RiskClassifier (cross-cutting decision A) only ever matters for a task
# that could otherwise commit with zero human tap at high trust — that's the
# *_auto family MINUS accept_caregiver_link, which is a consent flow that's
# already always-human-tap end to end (soul.md) regardless of trust level, so
# there is nothing here for a risk flag to gate. Deliberately NOT keyed off
# AUTONOMOUS_TASKS membership alone (that set is a "Mei drives the screen"
# mechanism axis, not a risk axis) — this is its own, independently-scoped
# subset, even though today it happens to equal AUTONOMOUS_TASKS minus one.
RISK_ASSESSED_TASKS = AUTONOMOUS_TASKS - {"accept_caregiver_link"}

# Tasks whose underlying write DISCONTINUES/DELETES/REVOKES something already
# on file. A genuinely different axis from AUTONOMOUS_TASKS (mechanism, not
# risk) and CAREGIVER_ONLY_TASKS (which shell renders it) — risk.py's
# classifier always flags a task in this set, regardless of its other
# signals. Empty today ON PURPOSE: none of the five *_auto tasks above write
# destructively (they add/edit — reversible via a later, separate edit or an
# explicit discontinue_medication call); this table exists so a FUTURE *_auto
# task whose write discontinues/deletes/revokes something (e.g. an eventual
# "discontinue_medication_auto") is flagged the moment it's added, without
# anyone having to remember to touch risk.py by hand. Mirror this table
# TS-side once such a task exists — see test_irreversible_auto_tasks_parity
# in test_walkthrough.py for the raw-text-extraction half already in place.
IRREVERSIBLE_AUTO_TASKS: frozenset[str] = frozenset()


def tasks_for_role(role: str) -> list[str]:
    """The walkthroughs that can actually run in this person's app shell."""
    excluded = CAREGIVER_ONLY_TASKS if role != "caregiver" else ELDER_ONLY_TASKS
    return [t for t in TASK_NAMES if t not in excluded]

# The exact destination strings travel_mode_auto's <select> offers. Its options
# carry no value attribute, so an option's value IS its label — anything else
# doesn't "miss", it BLANKS the field, and the blank then persists as the saved
# travel plan. Kept in sync with apps/web/src/app/lib/constants.ts::TIMEZONES.
# The client resolves near-misses ("Asia/Tokyo", "Tokyo", "UTC+9") too; naming
# the real options here is what stops the near-miss happening at all.
TRAVEL_TIMEZONES = [
    "Singapore (UTC+8)", "Malaysia (UTC+8)", "Thailand (UTC+7)",
    "Indonesia — Jakarta (UTC+7)", "Japan (UTC+9)", "South Korea (UTC+9)",
    "China (UTC+8)", "Hong Kong (UTC+8)", "Taiwan (UTC+8)", "Vietnam (UTC+7)",
    "Philippines (UTC+8)", "Australia — Sydney (UTC+11)", "India (UTC+5:30)",
    "United Kingdom (UTC+0)", "USA — New York (UTC-5)",
    "USA — Los Angeles (UTC-8)", "UAE — Dubai (UTC+4)",
]

_SCHEMA = {
    "name": "start_walkthrough",
    "description": (
        "Start a guided walkthrough of a task in the Dosewise app. The '*_auto' "
        "walkthroughs are AUTONOMOUS: the app fills the form in with the values you "
        "pass in `params` and saves it for the patient, animated step-by-step, then "
        "re-checks the real saved state before confirming — use these to actually "
        "carry out a request (e.g. add a prescription, add a medical condition) so "
        "the patient sees exactly what's happening and where it lands. The other "
        "walkthroughs only spotlight-and-narrate while the patient taps themselves. "
        "Pass `params` with the patient's REAL values (never placeholders). For "
        "add_prescription_auto only, propose with add_prescription(confirmed=false) "
        "FIRST so the interaction check runs, then call this on their yes and do NOT "
        "call add_prescription(confirmed=true). Only meaningful in the app — there "
        "are no screens to drive on Telegram."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "task_name": {
                "type": "string",
                "enum": TASK_NAMES,
                "description": "Which walkthrough to start.",
            },
            "params": {
                "type": "object",
                "description": (
                    "The real values to fill in for an autonomous walkthrough. "
                    "add_prescription_auto: {name, dose, purpose, times, "
                    "duration_days?} — `times` is the SAME set of clock times "
                    "you gave add_prescription, as ONE comma-separated 24h "
                    "string ('12:00' or '08:00,20:00'); every value here is "
                    "coerced with str(), so a real list would arrive at the app "
                    "as the literal \"['12:00']\". Omitting it files the "
                    "medicine at the person's breakfast time, which is wrong "
                    "whenever they told you when to take it. Include "
                    "duration_days ONLY for a fixed course ('for 2 "
                    "weeks', 'a 5-day course'), counted inclusively from today, "
                    "and pass the SAME value you gave add_prescription. "
                    "add_condition_auto: {condition}. "
                    "edit_profile_auto: {value} (the new weight in kg). "
                    "add_doctor_question_auto: {question}. "
                    "travel_mode_auto: {start_date, end_date, timezone} — dates "
                    "as YYYY-MM-DD, and timezone MUST be one of: "
                    f"{'; '.join(TRAVEL_TIMEZONES)}. "
                    "Omit params entirely for a spotlight-only walkthrough."
                ),
                "additionalProperties": {"type": "string"},
            },
        },
        "required": ["task_name"],
    },
}


async def start_walkthrough(
    ctx: ToolContext, task_name: str, params: dict | None = None
) -> str:
    if task_name not in TASK_NAMES:
        return f"No walkthrough script named '{task_name}'. Known: {', '.join(TASK_NAMES)}."
    # Wrong-shell guard, at DISPATCH rather than in the schema enum. The enum is
    # a module-level dict handed straight out of the registry (base.py::
    # tool_schemas, shallow-copied in agent/loop.py), so making it per-turn would
    # mean threading app_role through all three provider paths. Refusing here is
    # one branch and, unlike a silent client-side decline, gives the model a
    # RECOVERABLE result: it can answer the question directly in the same turn
    # instead of promising a walkthrough that will never appear.
    allowed = tasks_for_role(ctx.app_role)
    if task_name not in allowed:
        other = "caregiver" if ctx.app_role != "caregiver" else "patient"
        return (
            f"'{task_name}' only exists in the {other} app, and this person is not "
            "using it — the walkthrough was NOT started. Do not tell them you're "
            "about to show them anything. Answer their question directly instead, "
            "using your other tools where they help."
        )
    # Not a write — deliberately not appended to ctx.committed_actions (see base.py).
    # `params` carries only VALUES (never selectors/step content, which stay
    # client-side): the app injects them into the walkthrough's fill steps.
    #
    # Coerce every value to a string. The schema says string, but models send
    # `{"value": 64}` for a weight anyway — and the client's step builders are
    # typed Record<string, string> and call `.trim()` on what arrives, so a bare
    # number reaches the browser as a TypeError mid-walkthrough. Normalize here,
    # at the one place params cross the boundary, rather than defensively in
    # every builder. Booleans/None are stringified too; nothing is dropped.
    clean = {k: ("" if v is None else str(v)) for k, v in (params or {}).items()}
    ctx.walkthrough = {"task_name": task_name, "params": clean}
    # RiskClassifier (cross-cutting decision A): only RISK_ASSESSED_TASKS can
    # ever commit with zero human tap at high trust, so only those get a
    # "risk" key at all — every other task_name's ctx.walkthrough is
    # unchanged from before this pass.
    if task_name in RISK_ASSESSED_TASKS:
        ctx.walkthrough["risk"] = await assess_risk(
            ctx, task_name, clean, irreversible_tasks=IRREVERSIBLE_AUTO_TASKS
        )
    return (
        f"Queued the '{task_name}' walkthrough. Tell the patient in one short, warm "
        "line that you'll do it now and show them, then stop — the app takes over "
        "from here, filling it in, saving, and confirming it really saved."
    )


register(_SCHEMA, start_walkthrough)
