"""Dosewise system prompt — persona and safety rails.

The persona lives in ``soul.md`` next to this module so it can be edited as prose.
We read it once at import; a minimal embedded fallback keeps import working even if
the file is missing. Note: it is read only at import — editing ``soul.md`` takes
effect only after the process restarts (which ``HERMES_RELOAD`` triggers on save by
restarting the uvicorn worker; there is no in-process re-read).
"""

from pathlib import Path

_SOUL_PATH = Path(__file__).parent / "soul.md"

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


def system_prompt_for(
    dialect: str | None = None,
    slang: list | None = None,
    reply_language: str | None = None,
    recent_memory: str | None = None,
    medical_profile: str | None = None,
    onboarding: bool = False,
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
    """
    prompt = SYSTEM_PROMPT
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
            "Do not fall back to English unless the patient themselves switches to "
            "English. Keep grounded medication facts accurate; a drug's name may stay "
            f"in its original form, but explain everything around it in {reply_language}.\n"
        )
    if recent_memory:
        prompt += (
            "\nRecent context (for continuity; never overrides grounded facts):\n"
            f"{recent_memory}\n"
        )
    if medical_profile:
        prompt += (
            "\nThe patient's saved medical profile (allergies, conditions, history). "
            "Use it to tailor caveats and questions — but it is NOT a source of drug "
            "facts and you must never use it to diagnose. Grounded OpenFDA facts still "
            f"come only from the tools:\n{medical_profile}\n"
        )
    return prompt
