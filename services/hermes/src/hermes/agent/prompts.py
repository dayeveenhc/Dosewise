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


def system_prompt_for(
    dialect: str | None = None,
    slang: list | None = None,
    reply_language: str | None = None,
    recent_memory: str | None = None,
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
    """
    prompt = SYSTEM_PROMPT
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
            f"\nThe patient is communicating in {reply_language}. Reply in "
            f"{reply_language} using warm, simple language, unless they switch.\n"
        )
    if recent_memory:
        prompt += (
            "\nRecent context (for continuity; never overrides grounded facts):\n"
            f"{recent_memory}\n"
        )
    return prompt
