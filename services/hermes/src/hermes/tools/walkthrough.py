"""Guided walkthrough handoff: start_walkthrough.

Queues a scripted, spotlight-and-narrate UI walkthrough for the web client to run.
Mei only ever points and narrates — every step's actual tap/type/submit is the
patient's own action, never the tool's. The step content itself (which element to
highlight, what to say, what user action ends the step) is data owned entirely by
the web client (``apps/web/src/app/lib/walkthrough/steps/``); this tool only names
which script to run, so new walkthroughs can be added without touching agent logic.
Only meaningful in the app channel — there are no spotlightable screens on Telegram.
"""

from __future__ import annotations

from .base import ToolContext, register

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
    "language_voice",
    "reminder_settings",
    "emergency_contact",
    "text_size",
    # Spotlight tours (2026-07-26): highlight-and-narrate only — the user taps
    # every step themselves, nothing autonomous.
    "language_voice_tour",
    "notifications_tour",
    "emergency_contact_tour",
    "caregiver_view_toggle_tour",
    "patient_schedule_tour",
    "weekly_summary_tour",
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
                    "add_prescription_auto: {name, dose, purpose, frequency?}. "
                    "add_condition_auto: {condition}. travel_mode_auto: "
                    "{start_date, end_date, timezone}. Omit for a spotlight-only "
                    "walkthrough."
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
    # Not a write — deliberately not appended to ctx.committed_actions (see base.py).
    # `params` carries only VALUES (never selectors/step content, which stay
    # client-side): the app injects them into the walkthrough's fill steps.
    ctx.walkthrough = {"task_name": task_name, "params": params or {}}
    return (
        f"Queued the '{task_name}' walkthrough. Tell the patient in one short, warm "
        "line that you'll do it now and show them, then stop — the app takes over "
        "from here, filling it in, saving, and confirming it really saved."
    )


register(_SCHEMA, start_walkthrough)
