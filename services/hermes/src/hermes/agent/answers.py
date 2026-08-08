"""Answer buttons for a question the agent asked conversationally.

The web chat paints tappable answers from exactly two signals
(``apps/web/src/app/lib/chatChoices.ts``): ``choices`` (the ``offer_choices``
tool) or ``awaiting_confirmation`` (set only by a tool's PROPOSE branch). A
question with no tool behind it — "Would you like me to note that down?" —
carries neither, so the person's only way to answer is the keyboard.

Asking the model to call ``offer_choices`` alongside its reply does not fix
this, and that is not a wording problem: once a model has committed to
answering in text it routinely skips a tool whose only effect is a side effect.
Measured on the real elder chat against this service after the prompt and
tool-description rails were strengthened in both places: **0 of 6**
conversational yes/no turns carried answers.

So this does not ask. It takes the finished reply and FORCES a single
``suggest_answers`` tool call — the same trick ``extract.py`` uses to guarantee
a structured result — whose whole job is to say what the answers are. The model
is a good judge of "is this a yes/no or a pick-one, and what are the options",
and it writes the labels in the person's own language, which is precisely what a
server-side heuristic could never do (Hermes holds no translation table — that
is *why* the web client owns the synthesized Yes/No pair for the confirm case).

Costs one extra completion, and only on a turn whose reply ends in a question
mark with no options already attached. Fails open in every direction: any
error, any unparsable result, an open-ended question — no options, exactly the
behaviour before this existed.

Provider-agnostic like ``loop.py`` and ``extract.py`` (OpenAI default, Gemini,
Anthropic fallback). Additive to the shared ``run_agent_turn`` core: Telegram
gets the same call, where ``ctx.choices`` is a documented no-op.
"""

from __future__ import annotations

import json
import logging

from ..config import get_settings
from . import llm

log = logging.getLogger("hermes.answers")

_MAX_TOKENS = 300
_TOOL_NAME = "suggest_answers"
_TOOL_DESCRIPTION = (
    "Report the ready-made answers for the question the assistant just asked, so the "
    "person can pick one instead of typing it. Return an EMPTY list unless the final "
    "question really is answerable by picking from a small set."
)

# Anthropic ``input_schema`` shape — the canonical form loop.py's OpenAI and
# Gemini converters also consume.
_SCHEMA = {
    "type": "object",
    "properties": {
        "options": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "2-4 short answers to the assistant's final question, in the SAME "
                "language the assistant wrote in. Each must be phrased as the answer "
                "itself ('Yes, please' / 'No, not now'), never as an instruction. "
                "EMPTY list if the question is open-ended (asks for a name, a time, a "
                "number, a description) or if there is no question at all."
            ),
        }
    },
    "required": ["options"],
}

_SYSTEM = (
    "You label questions for a medication assistant used by elderly patients.\n"
    "You are given the assistant's finished reply. Look ONLY at its final question.\n"
    "\n"
    "Return 2-4 short answers if that question is a yes/no or a pick-one-of-a-few.\n"
    "Return an EMPTY list if it is open-ended (it asks for a name, a dose, a time, a\n"
    "number, a symptom description, 'what' or 'which' or 'how'), if it is rhetorical,\n"
    "or if the reply asks nothing at all. An empty list is a perfectly good answer and\n"
    "is much better than options that do not fit — a wrong option is sent verbatim as\n"
    "the person's next message.\n"
    "\n"
    "Write the answers in the SAME language as the reply. Keep each under about five\n"
    "words. Never mention buttons, tapping, or any symbol."
)

# Same shape offer_choices enforces (tools/choices.py): trimmed, de-duplicated
# case-insensitively, capped at 4, and useless below 2.
_MAX_OPTIONS = 4
_MIN_OPTIONS = 2


def ends_with_question(reply: str) -> bool:
    """True when the reply's last non-empty line ends in a question mark.

    Deliberately covers the full-width '？' as well: Mandarin, Cantonese and
    Hokkien replies use it, and those are exactly the readers for whom typing an
    answer is hardest. This is only a CHEAP GATE deciding whether to spend a
    completion — the model, not this function, decides if there are answers.
    """
    for line in reversed(reply.strip().splitlines()):
        stripped = line.strip()
        if stripped:
            return stripped.endswith("?") or stripped.endswith("？")
    return False


def _clean(options: object) -> list[str]:
    if not isinstance(options, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in options:
        if not isinstance(raw, str):
            continue
        text = raw.strip()
        if not text or text.lower() in seen:
            continue
        seen.add(text.lower())
        out.append(text)
        if len(out) == _MAX_OPTIONS:
            break
    return out if len(out) >= _MIN_OPTIONS else []


async def suggest_answers(client, reply: str) -> list[str]:
    """Answer labels for `reply`'s final question, or [] — never raises."""
    if not get_settings().answer_buttons:
        return []
    if not reply or not ends_with_question(reply):
        return []
    provider = llm.effective_provider()
    try:
        if provider == "openai":
            raw = await _suggest_openai(client, reply)
        elif provider == "gemini":
            raw = await _suggest_gemini(client, reply)
        else:
            raw = await _suggest_anthropic(client, reply)
    except Exception:
        # A reply the person can still type an answer to is a far better
        # outcome than a failed turn.
        log.exception("answer suggestion failed (provider=%s)", provider)
        return []
    return _clean(raw.get("options"))


def _user_text(reply: str) -> str:
    return f"The assistant's reply was:\n\n{reply}"


async def _suggest_anthropic(client, reply: str) -> dict:
    settings = get_settings()
    tool = {"name": _TOOL_NAME, "description": _TOOL_DESCRIPTION, "input_schema": _SCHEMA}
    response = await client.messages.create(
        model=settings.anthropic_model,
        max_tokens=_MAX_TOKENS,
        system=_SYSTEM,
        tools=[tool],
        tool_choice={"type": "tool", "name": _TOOL_NAME},
        messages=[{"role": "user", "content": _user_text(reply)}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == _TOOL_NAME:
            return dict(block.input or {})
    return {}


async def _suggest_openai(client, reply: str) -> dict:
    settings = get_settings()
    tools = [
        {
            "type": "function",
            "function": {
                "name": _TOOL_NAME,
                "description": _TOOL_DESCRIPTION,
                "parameters": _SCHEMA,
            },
        }
    ]
    response = await client.chat.completions.create(
        model=settings.openai_model,
        max_tokens=_MAX_TOKENS,
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": _user_text(reply)},
        ],
        tools=tools,
        tool_choice={"type": "function", "function": {"name": _TOOL_NAME}},
    )
    msg = response.choices[0].message
    if msg.tool_calls:
        try:
            return json.loads(msg.tool_calls[0].function.arguments or "{}")
        except json.JSONDecodeError:
            log.warning("openai answer suggestion returned unparsable arguments")
    return {}


async def _suggest_gemini(client, reply: str) -> dict:
    from google.genai import types

    from .loop import _to_gemini_schema

    settings = get_settings()
    decl = types.FunctionDeclaration(
        name=_TOOL_NAME,
        description=_TOOL_DESCRIPTION,
        parameters=_to_gemini_schema(_SCHEMA),
    )
    config = types.GenerateContentConfig(
        system_instruction=_SYSTEM,
        max_output_tokens=_MAX_TOKENS,
        tools=[types.Tool(function_declarations=[decl])],
        tool_config=types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(
                mode="ANY", allowed_function_names=[_TOOL_NAME]
            )
        ),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    response = await client.aio.models.generate_content(
        model=settings.gemini_model,
        contents=[types.Content(role="user", parts=[types.Part.from_text(text=_user_text(reply))])],
        config=config,
    )
    for cand in getattr(response, "candidates", None) or []:
        content = getattr(cand, "content", None)
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if fc and fc.name == _TOOL_NAME:
                return dict(fc.args or {})
    return {}
