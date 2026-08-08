"""The tool-calling loop — the heart of Hermes.

``run_agent_turn`` runs one user turn end to end: it calls the configured brain
(OpenAI, Gemini, **or** Claude) with the tool belt, dispatches any tool calls
(acting as the elder, RLS-scoped), feeds the results back, and returns the final
plain-language reply. The ``messages`` list (provider-native history) is threaded
in and out so a channel can keep multi-turn context.

The three providers share everything except the model call and the wire format
for tool calls: dialect-tailored system prompt, tool dispatch, and persistence are
common; ``_run_anthropic`` / ``_run_gemini`` / ``_run_openai`` handle the
provider-specific parts.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections.abc import Awaitable, Callable

from ..config import get_settings
from ..tools import ToolContext, get_handler, tool_schemas
from . import llm
from .answers import suggest_answers
from .prompts import system_prompt_for

log = logging.getLogger("hermes.agent")

_MAX_ITERATIONS = 8
_MAX_TOKENS = 4096

# Shown when the tool-calling loop ends without the model producing a final
# answer (iteration cap reached, or an empty reply). Deliberately NOT a
# human-handoff line: this is usually a stuck tool loop, not a safety event, so
# invite a simpler retry instead of dead-ending the person to "ask a person."
_RETRY_REPLY = (
    "Sorry, I didn't quite catch that. "
    "Could you say it once more, a little more simply?"
)
_CACHE = {"type": "ephemeral"}

# Optional per-tool-call progress callback, threaded through the loop below.
# Every call site guards with `if on_event` so passing None (every caller today
# except the web SSE endpoint) costs nothing extra on the hot path.
OnEvent = Callable[[dict], Awaitable[None]]


def _cached_system(system: str) -> list[dict]:
    """Send the system prompt as a cached block so Anthropic reuses it across the
    up-to-8 loop iterations of a turn (and across turns within the 5-min TTL),
    instead of re-billing the full prompt every ``messages.create``."""
    return [{"type": "text", "text": system, "cache_control": _CACHE}]


def _cached_tools(schemas: list[dict]) -> list[dict]:
    """Copy the shared tool schemas and mark the last one cacheable — the cache
    breakpoint covers the whole (large) tool block. Copy so the registry's dicts
    are never mutated."""
    if not schemas:
        return schemas
    tools = [dict(s) for s in schemas]
    tools[-1] = {**tools[-1], "cache_control": _CACHE}
    return tools


async def run_agent_turn(
    client,
    ctx: ToolContext,
    user_text: str,
    *,
    image_bytes: bytes | None = None,
    image_media_type: str = "image/jpeg",
    history: list | None = None,
    reply_language: str | None = None,
    completed_walkthroughs: list[str] | None = None,
    app_role: str | None = None,
    on_event: OnEvent | None = None,
) -> tuple[str, list[str], list]:
    """Run one turn. Returns (reply_text, tools_used, updated_messages)."""
    dialect = await _elder_dialect(ctx)
    slang = await _elder_slang(ctx, dialect)
    await _elder_voice_pref(ctx)
    recent_memory = await _recent_memory(ctx, history)
    medical_profile = await _medical_profile(ctx)
    # First-time setup: no saved profile (or an explicit /setup re-run) puts the
    # turn in guided-intake mode. Ends naturally — the first profile commit
    # refreshes the session cache and clears intake_active.
    onboarding = medical_profile is None or bool(
        getattr(ctx.session, "intake_active", False)
    )
    system = system_prompt_for(
        dialect,
        slang=slang,
        reply_language=reply_language,
        recent_memory=recent_memory,
        medical_profile=medical_profile,
        onboarding=onboarding,
        completed_walkthroughs=completed_walkthroughs,
        app_role=app_role,
    )

    eff = llm.effective_provider()
    if eff == "openai":
        reply, tools_used, messages = await _run_openai(
            client, ctx, system, user_text, image_bytes, image_media_type, history,
            on_event=on_event,
        )
    elif eff == "gemini":
        reply, tools_used, messages = await _run_gemini(
            client, ctx, system, user_text, image_bytes, image_media_type, history,
            on_event=on_event,
        )
    else:
        reply, tools_used, messages = await _run_anthropic(
            client, ctx, system, user_text, image_bytes, image_media_type, history,
            on_event=on_event,
        )

    # Answer buttons for a question the model asked WITHOUT calling
    # offer_choices. Not a nudge — a forced structured call (agent/answers.py),
    # because a model that has committed to a text reply routinely skips a tool
    # whose only effect is a side effect: measured 0/6 on real conversational
    # yes/no turns with the prompt and tool-description rails already in place.
    # No-op when the model DID attach options, when the reply asks nothing, or
    # when anything at all goes wrong.
    if not getattr(ctx, "choices", None):
        options = await suggest_answers(client, reply)
        if options:
            # label == value: choices.py echoes the value back verbatim as the
            # person's next message, so it has to read as their own words.
            ctx.choices = [{"label": o, "value": o} for o in options]
    await _persist(ctx, user_text, reply, tools_used)
    return reply, tools_used, messages


# ---------------------------------------------------------------------------
# Yes/no answer-button backstop — HEURISTIC, off by default
# ---------------------------------------------------------------------------
def record_exchange(history: list | None, user_text: str, reply: str) -> list:
    """Append a plain user/assistant exchange to a provider-native history.

    Used when a channel resolves a turn without the model (e.g. a deterministic
    button-tap confirmation), so the threaded history still shows the elder's
    answer and what happened — otherwise the model would re-ask on the next turn.
    """
    messages = list(history or [])
    if llm.effective_provider() == "gemini":
        try:
            from google.genai import types

            messages.append(
                types.Content(role="user", parts=[types.Part.from_text(text=user_text)])
            )
            messages.append(
                types.Content(role="model", parts=[types.Part.from_text(text=reply)])
            )
        except Exception:
            # No SDK available: skip the in-process append; cross-restart memory
            # still lands via persist_exchange -> conversation_turns.
            log.warning("could not record exchange in gemini history", exc_info=True)
    else:  # anthropic + openai both accept plain string-content dicts
        messages.append({"role": "user", "content": user_text})
        messages.append({"role": "assistant", "content": reply})
    return messages


async def persist_exchange(
    ctx: ToolContext, user_text: str, reply: str, tools_used: list[str]
) -> None:
    """Best-effort conversation_turns write for a turn resolved outside the loop."""
    await _persist(ctx, user_text, reply, tools_used)


# ---------------------------------------------------------------------------
# Shared tool dispatch
# ---------------------------------------------------------------------------
async def _dispatch_tool(
    ctx: ToolContext, name: str, tool_input: dict, *, on_event: OnEvent | None = None
) -> tuple[str, bool]:
    """Run a tool handler; returns (output_text, is_error)."""
    if on_event:
        await on_event({"type": "tool_start", "tool": name})
    handler = get_handler(name)
    # A tool RUNNING is not a tool WRITING: log_dose/undo_dose/etc. return
    # normally (is_error=False) on their "asked a question / nothing to do"
    # paths without committing anything. The web client uses tool_end to
    # navigate the screen, so it must know whether THIS dispatch actually
    # committed — else a mere propose/clarify turn wrongly yanks the UI to the
    # result screen. Snapshot the committed-actions length across the handler.
    pre_committed = len(ctx.committed_actions)
    if handler is None:
        output, is_error = f"Unknown tool '{name}'.", True
    else:
        try:
            output, is_error = await handler(ctx, **(tool_input or {})), False
        except Exception as exc:  # surface tool failures to the model, don't crash
            log.exception("tool %s failed", name)
            output, is_error = f"Tool error: {exc}", True
    committed = len(ctx.committed_actions) > pre_committed
    if on_event:
        await on_event(
            {"type": "tool_end", "tool": name, "is_error": is_error, "committed": committed}
        )
    return output, is_error


def _stabilize_actions(ctx: ToolContext, pre: int, ordered_names: list[str]) -> None:
    """Pin this iteration's committed actions to the model's tool-call order.

    A tool batch runs under ``asyncio.gather``: the OUTPUTS come back in call
    order, but each handler appends to ``ctx.committed_actions`` whenever it
    happens to commit — completion order, which is nondeterministic when ≥2
    write tools run in one iteration. The web app treats ``actions`` as ordered
    (``actions[0]`` drives the primary highlight), so stable-sort the slice this
    batch appended (``ctx.committed_actions[pre:]``) by each action's tool
    position in the call order. Stable: several actions from one tool keep
    their relative order; a tool name not in the batch (none today) sinks last.
    Shared by all three provider loops.
    """
    tail = ctx.committed_actions[pre:]
    if len(tail) < 2:
        return
    order: dict[str, int] = {}
    for i, name in enumerate(ordered_names):
        order.setdefault(name, i)
    tail.sort(key=lambda a: order.get(a.get("tool"), len(ordered_names)))
    ctx.committed_actions[pre:] = tail


# ---------------------------------------------------------------------------
# OpenAI — chat.completions API with tool_calls / tool-role messages
# ---------------------------------------------------------------------------
def _to_openai_tools() -> list[dict]:
    """The shared tool schemas already use the same JSON-schema shape OpenAI
    expects for ``function.parameters`` — no per-field conversion needed
    (unlike Gemini's typed ``Schema`` builder)."""
    return [
        {
            "type": "function",
            "function": {
                "name": schema["name"],
                "description": schema.get("description", ""),
                "parameters": schema["input_schema"],
            },
        }
        for schema in tool_schemas()
    ]


def _parse_tool_args(raw: str | None) -> dict:
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        log.warning("openai tool call had unparsable arguments: %r", raw)
        return {}


async def _run_openai(
    client, ctx, system, user_text, image_bytes, image_media_type, history,
    *, on_event: OnEvent | None = None,
) -> tuple[str, list[str], list]:
    settings = get_settings()
    messages: list[dict] = list(history or [])

    user_content: list[dict] = []
    if image_bytes is not None:
        data = base64.standard_b64encode(image_bytes).decode()
        user_content.append(
            {"type": "image_url", "image_url": {"url": f"data:{image_media_type};base64,{data}"}}
        )
    user_content.append({"type": "text", "text": user_text})
    messages.append({"role": "user", "content": user_content})

    tools = _to_openai_tools()
    tools_used: list[str] = []
    msg = None

    for _ in range(_MAX_ITERATIONS):
        response = await client.chat.completions.create(
            model=settings.openai_model,
            max_tokens=_MAX_TOKENS,
            messages=[{"role": "system", "content": system}, *messages],
            tools=tools,
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            break

        tool_calls = list(msg.tool_calls)
        messages.append(
            {
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ],
            }
        )

        for tc in tool_calls:
            tools_used.append(tc.function.name)
        pre = len(ctx.committed_actions)
        outs = await asyncio.gather(
            *(
                _dispatch_tool(
                    ctx, tc.function.name, _parse_tool_args(tc.function.arguments),
                    on_event=on_event,
                )
                for tc in tool_calls
            )
        )
        _stabilize_actions(ctx, pre, [tc.function.name for tc in tool_calls])
        for tc, (out, _is_error) in zip(tool_calls, outs, strict=True):
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})

    reply = (msg.content or "").strip() if msg is not None else ""
    if msg is not None and msg.tool_calls:
        # Hit the iteration cap mid-loop; recover with a gentle retry, not a handoff.
        log.warning("agent loop hit iteration cap (openai); tools_used=%s", tools_used)
        reply = reply or _RETRY_REPLY
    elif not reply:
        log.warning("agent loop produced an empty reply (openai); tools_used=%s", tools_used)
        reply = _RETRY_REPLY

    messages.append({"role": "assistant", "content": reply})
    _strip_images(messages)
    return reply, tools_used, messages


# ---------------------------------------------------------------------------
# Anthropic (Claude) — messages API with tool_use / tool_result blocks
# ---------------------------------------------------------------------------
async def _run_anthropic(
    anthropic, ctx, system, user_text, image_bytes, image_media_type, history,
    *, on_event: OnEvent | None = None,
) -> tuple[str, list[str], list]:
    settings = get_settings()
    messages: list[dict] = list(history or [])

    user_content: list[dict] = []
    if image_bytes is not None:
        user_content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_media_type,
                    "data": base64.standard_b64encode(image_bytes).decode(),
                },
            }
        )
    user_content.append({"type": "text", "text": user_text})
    messages.append({"role": "user", "content": user_content})

    tools = _cached_tools(tool_schemas())
    cached_system = _cached_system(system)
    tools_used: list[str] = []
    response = None

    for _ in range(_MAX_ITERATIONS):
        response = await anthropic.messages.create(
            model=settings.anthropic_model,
            max_tokens=_MAX_TOKENS,
            system=cached_system,
            thinking={"type": "adaptive"},
            tools=tools,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            break

        # Echo the assistant turn back verbatim (preserves thinking + tool_use blocks).
        messages.append({"role": "assistant", "content": response.content})

        # Dispatch every requested tool concurrently — a turn that asks for, say,
        # list_medications + check_refills runs them in parallel, not in series.
        tool_blocks = [b for b in response.content if b.type == "tool_use"]
        for block in tool_blocks:
            tools_used.append(block.name)
        pre = len(ctx.committed_actions)
        outs = await asyncio.gather(
            *(_dispatch_tool(ctx, b.name, b.input, on_event=on_event) for b in tool_blocks)
        )
        _stabilize_actions(ctx, pre, [b.name for b in tool_blocks])

        results: list[dict] = []
        for block, (out, is_error) in zip(tool_blocks, outs, strict=True):
            result: dict = {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": out,
            }
            if is_error:
                result["is_error"] = True
            results.append(result)

        messages.append({"role": "user", "content": results})

    reply = _anthropic_text(response) if response is not None else ""
    if response is not None and response.stop_reason == "tool_use":
        # Hit the iteration cap mid-loop; recover with a gentle retry, not a handoff.
        log.warning("agent loop hit iteration cap (anthropic); tools_used=%s", tools_used)
        reply = reply or _RETRY_REPLY
    elif not reply:
        log.warning("agent loop produced an empty reply (anthropic); tools_used=%s", tools_used)
        reply = _RETRY_REPLY

    messages.append({"role": "assistant", "content": reply})
    # The photo was needed only for this turn's iterations; drop it from the history
    # we thread forward so the (large) base64 image isn't re-sent on every later turn.
    _strip_images(messages)
    return reply, tools_used, messages


def _strip_images(messages: list) -> None:
    """In place: remove image blocks from user turns in the threaded-forward history.

    The elder's prescription photo is analysed on the turn it arrives; keeping it in
    ``messages`` would re-transmit the base64 image to the model on every subsequent
    turn. We never empty a content list (the API rejects that) — a photo always
    arrives alongside a text block, so at least the text remains. Handles both
    Anthropic's ``"image"`` blocks and OpenAI's ``"image_url"`` blocks.
    """
    for msg in messages:
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        kept = [
            b for b in content
            if not (isinstance(b, dict) and b.get("type") in ("image", "image_url"))
        ]
        if kept and len(kept) != len(content):
            msg["content"] = kept


def _anthropic_text(response) -> str:
    return "".join(
        block.text for block in response.content if block.type == "text"
    ).strip()


# ---------------------------------------------------------------------------
# Gemini (Google) — generate_content with functionCall / functionResponse parts
# ---------------------------------------------------------------------------
async def _run_gemini(
    client, ctx, system, user_text, image_bytes, image_media_type, history,
    *, on_event: OnEvent | None = None,
) -> tuple[str, list[str], list]:
    from google.genai import types

    settings = get_settings()
    contents: list = list(history or [])

    parts = []
    if image_bytes is not None:
        parts.append(types.Part.from_bytes(data=image_bytes, mime_type=image_media_type))
    parts.append(types.Part.from_text(text=user_text))
    contents.append(types.Content(role="user", parts=parts))

    config = types.GenerateContentConfig(
        system_instruction=system,
        max_output_tokens=_MAX_TOKENS,
        tools=[types.Tool(function_declarations=_gemini_declarations())],
        # We dispatch tools ourselves (they need the RLS-scoped ToolContext).
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )

    tools_used: list[str] = []
    response = None
    calls: list = []

    for _ in range(_MAX_ITERATIONS):
        response = await client.aio.models.generate_content(
            model=settings.gemini_model, contents=contents, config=config
        )
        content = _gemini_content(response)
        calls = (
            [p.function_call for p in (content.parts or []) if p.function_call]
            if content
            else []
        )
        if not calls:
            break

        contents.append(content)  # model turn carrying the functionCall parts
        for fc in calls:
            tools_used.append(fc.name)
        pre = len(ctx.committed_actions)
        outs = await asyncio.gather(
            *(_dispatch_tool(ctx, fc.name, dict(fc.args or {}), on_event=on_event) for fc in calls)
        )
        _stabilize_actions(ctx, pre, [fc.name for fc in calls])
        response_parts = [
            types.Part.from_function_response(name=fc.name, response={"result": out})
            for fc, (out, _is_error) in zip(calls, outs, strict=True)
        ]
        # Function responses go back as a user-role turn (Gemini convention).
        contents.append(types.Content(role="user", parts=response_parts))

    reply = _gemini_text(response)
    if not reply and calls:
        # Hit the iteration cap mid-loop; recover with a gentle retry, not a handoff.
        log.warning("agent loop hit iteration cap (gemini); tools_used=%s", tools_used)
        reply = _RETRY_REPLY
    elif not reply:
        log.warning("agent loop produced an empty reply (gemini); tools_used=%s", tools_used)
        reply = _RETRY_REPLY
    contents.append(types.Content(role="model", parts=[types.Part.from_text(text=reply)]))
    return reply, tools_used, contents


def _gemini_content(response):
    candidates = getattr(response, "candidates", None) or []
    return candidates[0].content if candidates else None


def _gemini_text(response) -> str:
    content = _gemini_content(response)
    if content is None:
        return ""
    return "".join(
        p.text for p in (content.parts or []) if getattr(p, "text", None)
    ).strip()


def _gemini_declarations():
    """Convert the Anthropic-style tool schemas into Gemini FunctionDeclarations."""
    from google.genai import types

    decls = []
    for schema in tool_schemas():
        params = schema["input_schema"]
        decls.append(
            types.FunctionDeclaration(
                name=schema["name"],
                description=schema.get("description", ""),
                # Gemini rejects an empty parameter object — omit when no properties.
                parameters=_to_gemini_schema(params) if params.get("properties") else None,
            )
        )
    return decls


def _to_gemini_schema(node: dict):
    from google.genai import types

    t = types.Type
    kinds = {
        "object": t.OBJECT,
        "string": t.STRING,
        "integer": t.INTEGER,
        "number": t.NUMBER,
        "boolean": t.BOOLEAN,
        "array": t.ARRAY,
    }
    schema = types.Schema(type=kinds.get(node.get("type"), t.STRING))
    if node.get("description"):
        schema.description = node["description"]
    if node.get("enum"):
        schema.enum = [str(e) for e in node["enum"]]
    if node.get("type") == "object":
        props = node.get("properties") or {}
        schema.properties = {k: _to_gemini_schema(v) for k, v in props.items()}
        if node.get("required"):
            schema.required = list(node["required"])
    if node.get("type") == "array" and node.get("items"):
        schema.items = _to_gemini_schema(node["items"])
    return schema


# ---------------------------------------------------------------------------
# Shared: dialect + persistence
# ---------------------------------------------------------------------------
async def _elder_dialect(ctx: ToolContext) -> str | None:
    """Best-effort: the elder's preferred dialect, fetched once and cached on the
    session so we tailor language without a per-turn DB read."""
    session = ctx.session
    if session is None:
        return None
    if getattr(session, "dialect_loaded", False):
        return session.dialect
    try:
        rows = await ctx.db().select(
            "profiles",
            columns="dialect",
            filters={"id": f"eq.{ctx.elder_id}"},
            limit=1,
        )
        session.dialect = rows[0].get("dialect") if rows else None
    except Exception:
        log.warning("failed to load elder dialect", exc_info=True)
        session.dialect = None
    session.dialect_loaded = True
    return session.dialect


async def _elder_voice_pref(ctx: ToolContext) -> bool:
    """Best-effort: whether the elder wants spoken replies for typed messages too
    (profiles.accessibility.tts), fetched once and cached on the session. Defaults
    to False — voice mirrors the user (a voice note is always spoken back); only an
    explicit opt-in (``tts: true``, via the profile or /voice on) speaks every reply."""
    session = ctx.session
    if session is None:
        return False
    if getattr(session, "voice_loaded", False):
        return session.voice_default
    pref = False
    try:
        rows = await ctx.db().select(
            "profiles",
            columns="accessibility",
            filters={"id": f"eq.{ctx.elder_id}"},
            limit=1,
        )
        access = (rows[0].get("accessibility") if rows else None) or {}
        pref = bool(access.get("tts", False))
    except Exception:
        log.warning("failed to load elder voice preference", exc_info=True)
        pref = False
    session.voice_default = pref
    session.voice_loaded = True
    return pref


async def _recent_memory(ctx: ToolContext, history: list | None) -> str | None:
    """A compact recap of the elder's recent conversation_turns, folded into the
    system prompt so the agent remembers past chats across process restarts.

    Loaded once per session and only when there's no live in-process history yet
    (a fresh process / new session) — otherwise the threaded ``messages`` already
    carry the current conversation and we'd double-count it.
    """
    session = ctx.session
    if session is None or history:
        return None
    if getattr(session, "memory_loaded", False):
        return session.memory_text
    text: str | None = None
    try:
        rows = await ctx.db().select(
            "conversation_turns",
            columns="speaker,transcript",
            filters={"elder_id": f"eq.{ctx.elder_id}"},
            order="created_at.desc",
            limit=8,
        )
        lines: list[str] = []
        for row in reversed(rows):  # DB gave newest-first; recap oldest-first.
            transcript = (row.get("transcript") or "").strip()
            if not transcript:
                continue
            who = "The patient said" if row.get("speaker") == "user" else "You replied"
            lines.append(f"- {who}: {transcript}")
        text = "\n".join(lines) or None
    except Exception:
        log.warning("failed to load recent memory", exc_info=True)
        text = None
    session.memory_text = text
    session.memory_loaded = True
    return text


async def _medical_profile(ctx: ToolContext) -> str | None:
    """The elder's saved medical profile (``profiles.accessibility.medical_profile``),
    fetched once and cached on the session so drug answers can be tailored to their
    allergies/conditions. Context only — never a source of grounded drug facts."""
    session = ctx.session
    if session is not None and getattr(session, "medical_profile_loaded", False):
        return session.medical_profile
    text: str | None = None
    try:
        rows = await ctx.db().select(
            "profiles",
            columns="accessibility",
            filters={"id": f"eq.{ctx.elder_id}"},
            limit=1,
        )
        access = (rows[0].get("accessibility") if rows else None) or {}
        profile = access.get("medical_profile")
        text = profile.strip() if isinstance(profile, str) and profile.strip() else None
    except Exception:
        log.warning("failed to load medical profile", exc_info=True)
        text = None
    if session is not None:
        session.medical_profile = text
        session.medical_profile_loaded = True
    return text


# Public alias: channels use this to check for an empty profile (e.g. /start
# deciding whether to open the guided intake) without a second query path.
hydrate_medical_profile = _medical_profile


async def _elder_slang(ctx: ToolContext, dialect: str | None) -> list:
    """Best-effort dialect slang glossary (from MongoDB), cached on the session so
    we tailor understanding without a per-turn lookup. ``[]`` when unavailable."""
    if not dialect or dialect.lower() == "en":
        return []
    session = ctx.session
    if session is not None and getattr(session, "slang_loaded", False):
        return session.slang or []
    try:
        from ..slang import get_slang

        rows = await get_slang(dialect)
    except Exception:
        log.warning("failed to load elder slang", exc_info=True)
        rows = []
    if session is not None:
        session.slang = rows
        session.slang_loaded = True
    return rows


async def _persist(
    ctx: ToolContext, user_text: str, reply: str, tools_used: list[str]
) -> None:
    """Best-effort write of the turn to conversation_turns (agent memory)."""
    try:
        db = ctx.db()
        await db.insert(
            "conversation_turns",
            {"elder_id": ctx.elder_id, "speaker": "user", "transcript": user_text},
            returning=False,
        )
        await db.insert(
            "conversation_turns",
            {
                "elder_id": ctx.elder_id,
                "speaker": "assistant",
                "transcript": reply,
                "tool": tools_used[-1] if tools_used else None,
            },
            returning=False,
        )
    except Exception:
        log.warning("failed to persist conversation turn", exc_info=True)
