"""Dosewise system prompt — persona and safety rails.

The persona lives in ``soul.md`` next to this module so it can be edited as prose.
We read it once at import; a minimal embedded fallback keeps import working even if
the file is missing. Note: it is read only at import — editing ``soul.md`` takes
effect only after the process restarts (which ``HERMES_RELOAD`` triggers on save by
restarting the uvicorn worker; there is no in-process re-read).
"""

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..tools.walkthrough import AUTONOMOUS_TASKS as _AUTONOMOUS_TASKS
from ..tools.walkthrough import tasks_for_role as _tasks_for_role

_SOUL_PATH = Path(__file__).parent / "soul.md"

# Plain-language names for the prompt block below — keep in sync with
# TASK_NAMES (services/hermes/src/hermes/tools/walkthrough.py). A name without a
# label KeyErrors in test_walkthrough.py's parity check.
_WALKTHROUGH_LABELS = {
    "onboarding": (
        "the guided setup wizard (account, profile, conditions, allergies, "
        "routine, medicines)"
    ),
    "travel_mode_setup": "setting up Travel Mode",
    "request_refill": "requesting a medication refill",
    "link_caregiver": "linking a caregiver to their account",
    "add_prescription_auto": (
        "adding a prescription for them (Mei fills it in and saves it, "
        "then double-checks it saved)"
    ),
    "add_condition_auto": (
        "adding a medical condition to their profile for them (Mei types it in "
        "and saves it, then double-checks it saved)"
    ),
    "travel_mode_auto": (
        "setting up Travel Mode for them (Mei fills the dates in and saves it, "
        "then double-checks it saved)"
    ),
    "edit_profile_auto": (
        "updating a detail in their profile for them (Mei fills it in and saves it, "
        "then double-checks it saved)"
    ),
    "add_doctor_question_auto": (
        "saving a question for their doctor (Mei opens Reminders, types the question "
        "in and adds it, then double-checks it saved)"
    ),
    "accept_caregiver_link": (
        "accepting a pending caregiver link request (Mei opens it, the patient taps "
        "Accept themselves, then Mei confirms it linked)"
    ),
    "check_schedule": "reading their daily medicine schedule on the Home screen",
    "log_dose": "marking a medicine as taken",
    "undo_dose": "undoing a medicine they ticked off by mistake",
    "reminder_settings": "turning medicine reminders and other alerts on or off",
    "text_size": "making the text bigger and easier to read",
    "language_voice_tour": "changing language & voice settings",
    "notifications_tour": "checking their notifications and alerts",
    "emergency_contact_tour": "setting up an emergency contact",
    "caregiver_view_toggle_tour": "switching between the patient and caregiver views",
    "patient_schedule_tour": "seeing the patient's medication schedule",
    "weekly_summary_tour": "reading the weekly summary",
}

_FALLBACK_PROMPT = """\
You are Dosewise, a warm, patient medication helper for elderly patients and their \
caregivers. Speak plainly, one idea at a time, and confirm before acting. Never \
invent drug facts — call get_drug_info and answer only from what it returns; never \
diagnose or prescribe. To add a prescription, first call add_prescription with \
confirmed=false, read it back, and only call again with confirmed=true after a clear \
yes. When unsure or if the person is distressed, call request_human_help.
"""

try:
    SYSTEM_PROMPT = _SOUL_PATH.read_text(encoding="utf-8").strip()
except OSError:
    SYSTEM_PROMPT = _FALLBACK_PROMPT

# Guided first-time setup, appended when the patient has no medical profile yet (or
# asked to redo setup with /setup). Conversational, not a gate: the patient can ask
# anything mid-intake and the agent answers, then gently returns to the questions.
_INTAKE_BLOCK = """
FIRST-TIME SETUP. This patient has no medical profile saved yet (or asked to redo \
setup). Conduct a short, gentle intake — in their language, ONE question per \
message, in this order:
1. Any allergies to medicines?
2. Any ongoing conditions (diabetes, blood pressure, heart, ...)?
3. Anything important from their medical history?
4. Which medicines do they take now?
At any point, offer the shortcut: they can send a photo of a prescription or a PDF \
of their records instead of typing. Save allergies/conditions/history with \
`update_medical_profile` and medicines with `add_prescription` — the usual \
propose->confirm rule applies to every save. If they want to skip or stop, respect \
it immediately and mention they can redo setup anytime ("Help me set up" in the \
app, /setup on Telegram). Keep it to a few minutes; \
when done, summarise what you saved in one short message.
"""


def _today_line() -> str:
    """Today in the app's own timezone (config's hermes_tz, the same wall-clock
    the scheduler interprets dose times in), spelled out so there is nothing to
    misparse: "Sunday, 2 August 2026 (2026-08-02)"."""
    try:
        from ..config import get_settings

        tz = ZoneInfo(get_settings().hermes_tz)
    except Exception:  # unset/unknown tz must never take the whole prompt down
        tz = ZoneInfo("Asia/Singapore")
    now = datetime.now(tz)
    return f"{now:%A, %-d %B %Y} ({now:%Y-%m-%d})"


def system_prompt_for(
    dialect: str | None = None,
    slang: list | None = None,
    reply_language: str | None = None,
    recent_memory: str | None = None,
    medical_profile: str | None = None,
    onboarding: bool = False,
    completed_walkthroughs: list[str] | None = None,
    app_role: str | None = None,
) -> str:
    """The system prompt, tailored to the elder's dialect, slang, and input language.

    Keeps grounded facts and safety rails intact; the tailoring only shapes *how*
    Dosewise talks and helps it understand the patient — never *what* a drug fact is.
    - ``dialect``: mirror the patient's everyday words (``en``/empty => no change).
    - ``slang``: a ``[(term, meaning), ...]`` glossary so Dosewise understands dialect
      slang the patient may use.
    - ``reply_language``: the language the patient is using now — reply in it.
    - ``recent_memory``: a short recap of earlier turns, for continuity across
      restarts. Context only — it never overrides a grounded medication fact.
    - ``medical_profile``: the patient's saved allergies / conditions / history.
      Context to tailor caveats — never a source of drug facts, never a diagnosis.
    - ``onboarding``: True when the patient has no medical profile yet (or ran
      /setup) — appends the guided first-time intake instructions.
    - ``completed_walkthroughs``: task_names the patient has already been walked
      through (client-supplied) — so Mei doesn't re-offer one they've done.
    - ``app_role``: which app shell is asking ("elder" default, or "caregiver").
      The two render different screens, so offering a walkthrough belonging to
      the other shell can only ever point at elements that aren't there.
    """
    prompt = SYSTEM_PROMPT
    # TODAY'S DATE. Without it the model dates relative phrases from its training
    # data: asked to set up Travel Mode for "next Monday" it returned 2023-10-30,
    # and the walkthrough dutifully saved a travel plan three years in the past.
    # Anything relative — "next Monday", "in two weeks", "since last month" — is
    # unanswerable without this. Sits at the TOP of the prompt (and changes daily,
    # so it also bounds how long a cached prompt prefix can stay stale).
    prompt += f"\n\nToday is {_today_line()}.\n"
    if onboarding:
        prompt += "\n" + _INTAKE_BLOCK
    if dialect and dialect.lower() != "en":
        prompt += (
            f"\nThe patient's preferred dialect is {dialect}. Where it feels natural, "
            f"mirror simple, familiar {dialect} words and phrasing so they feel at ease. "
            "Never let dialect change a medication fact — grounded facts stay accurate.\n"
        )
    if slang:
        glossary = "; ".join(f"{term} = {meaning}" for term, meaning in slang)
        prompt += (
            f"\nThe patient may use these dialect terms (term = meaning): {glossary}. "
            "Understand them when the patient speaks; never let them change a "
            "medication fact.\n"
        )
    if reply_language:
        prompt += (
            f"\nLANGUAGE: The patient has chosen to communicate in {reply_language}. "
            f"Write your ENTIRE reply in {reply_language} — every sentence, including "
            "greetings, confirmations, questions, and any summary of what a tool did. "
            "This is the app's CURRENT setting and it is authoritative: it OVERRIDES "
            "the language of every earlier turn in this conversation and of anything "
            "quoted under 'Recent context'. If those are in another language, the "
            "patient has since changed the setting — switch to "
            f"{reply_language} from your very next sentence and do not mirror the old "
            "language back at them. Keep grounded medication facts accurate; a drug's "
            "name may stay in its original form, but explain everything around it in "
            f"{reply_language}.\n"
        )
    if recent_memory:
        prompt += (
            "\nRecent context (for continuity; never overrides grounded facts). It is "
            "a record of what was said, NOT a guide to what language to reply in — "
            "the LANGUAGE line above wins even when everything below is in another "
            "language:\n"
            f"{recent_memory}\n"
        )
    if medical_profile:
        prompt += (
            "\nThe patient's saved medical profile (allergies, conditions, history). "
            "Use it to tailor caveats and questions — but it is NOT a source of drug "
            "facts and you must never use it to diagnose. Grounded OpenFDA facts still "
            f"come only from the tools:\n{medical_profile}\n"
        )
    # The AUTONOMOUS family is never "already shown": those walkthroughs are not
    # introductions, they are HOW the write is performed (Mei fills the real form,
    # the patient taps Save). Adding a second medicine must be guided exactly like
    # the first. Treating them as one-time tutorials is what made "the walkthrough
    # for adding medicine doesn't work any more" literally true after one use.
    done = set(completed_walkthroughs or []) - _AUTONOMOUS_TASKS
    # Only ever offer walkthroughs that can actually RUN in this shell — the
    # elder and caregiver apps have entirely different screens.
    offerable = _tasks_for_role(app_role or "elder")
    undone = [t for t in offerable if t not in done]
    if undone:
        listed = "; ".join(f"{t} ({_WALKTHROUGH_LABELS[t]})" for t in undone)
        prompt += (
            f"\nWalkthroughs this patient has NOT been shown yet: {listed}. If their "
            "message clearly matches one of these (e.g. they ask how to do it, seem "
            "lost, or hint at the underlying need), offer in one short line to show "
            "them — do not call start_walkthrough until they clearly say yes. Never "
            "offer a walkthrough not in this list; it means they've already done it.\n"
        )
    # Intersect with the labels we actually have. `done` is STORED USER DATA
    # (profiles.accessibility.completedWalkthroughs, forwarded verbatim by the
    # client) — not a list derived from TASK_NAMES — so it can name a walkthrough
    # that has since been renamed or removed. Indexing _WALKTHROUGH_LABELS
    # directly would then KeyError on EVERY turn for that patient, i.e. a 500 on
    # every message they send. Unknown names are simply ignored.
    known_done = sorted(done & _WALKTHROUGH_LABELS.keys())
    if known_done:
        shown = "; ".join(f"{t} ({_WALKTHROUGH_LABELS[t]})" for t in known_done)
        prompt += (
            f"\nWalkthroughs this patient has ALREADY been shown: {shown}. Don't "
            "VOLUNTEER these again — if they ask about one of these features, just "
            "answer directly and don't tack on 'want me to show you?'. This limits "
            "what you OFFER, never what you DO: if they ask outright ('show me "
            "again', 'walk me through it', 'guide me'), start it as normal.\n"
        )
    return prompt
