"""The tool-calling loop — the heart of Hermes.

``run_agent_turn`` runs one user turn end to end: it calls the configured brain
(Claude **or** Gemini) with the tool belt, dispatches any tool calls (acting as the
elder, RLS-scoped), feeds the results back, and returns the final plain-language
reply. The ``messages`` list (provider-native history) is threaded in and out so a
channel can keep multi-turn context.

The two providers share everything except the model call and the wire format for
tool calls: dialect-tailored system prompt, tool dispatch, and persistence are
common; ``_run_anthropic`` / ``_run_gemini`` handle the provider-specific parts.
"""

from __future__ import annotations

import asyncio
import base64
import logging

from ..config import get_settings
from ..tools import ToolContext, get_handler, tool_schemas
from . import llm
from .prompts import system_prompt_for

log = logging.getLogger("hermes.agent")

_MAX_ITERATIONS = 8
_MAX_TOKENS = 4096
_CACHE = {"type": "ephemeral"}


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
) -> tuple[str, list[str], list]:
    """Run one turn. Returns (reply_text, tools_used, updated_messages)."""
    dialect = await _elder_dialect(ctx)
    slang = await _elder_slang(ctx, dialect)
    system = system_prompt_for(dialect, slang=slang, reply_language=reply_language)

    if llm.effective_provider() == "gemini":
        reply, tools_used, messages = await _run_gemini(
            client, ctx, system, user_text, image_bytes, image_media_type, history
        )
    else:
        reply, tools_used, messages = await _run_anthropic(
            client, ctx, system, user_text, image_bytes, image_media_type, history
        )

    await _persist(ctx, user_text, reply, tools_used)
    return reply, tools_used, messages


# ---------------------------------------------------------------------------
# Shared tool dispatch
# ---------------------------------------------------------------------------
async def _dispatch_tool(ctx: ToolContext, name: str, tool_input: dict) -> tuple[str, bool]:
    """Run a tool handler; returns (output_text, is_error)."""
    handler = get_handler(name)
    if handler is None:
        return f"Unknown tool '{name}'.", True
    try:
        return await handler(ctx, **(tool_input or {})), False
    except Exception as exc:  # surface tool failures to the model, don't crash
        log.exception("tool %s failed", name)
        return f"Tool error: {exc}", True


# ---------------------------------------------------------------------------
# Anthropic (Claude) — messages API with tool_use / tool_result blocks
# ---------------------------------------------------------------------------
async def _run_anthropic(
    anthropic, ctx, system, user_text, image_bytes, image_media_type, history
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
        outs = await asyncio.gather(
            *(_dispatch_tool(ctx, b.name, b.input) for b in tool_blocks)
        )

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
        # Hit the iteration cap mid-loop; give a safe fallback.
        reply = reply or "Let me get a person to help you with that."

    messages.append({"role": "assistant", "content": reply})
    return reply, tools_used, messages


def _anthropic_text(response) -> str:
    return "".join(
        block.text for block in response.content if block.type == "text"
    ).strip()


# ---------------------------------------------------------------------------
# Gemini (Google) — generate_content with functionCall / functionResponse parts
# ---------------------------------------------------------------------------
async def _run_gemini(
    client, ctx, system, user_text, image_bytes, image_media_type, history
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
        outs = await asyncio.gather(
            *(_dispatch_tool(ctx, fc.name, dict(fc.args or {})) for fc in calls)
        )
        response_parts = [
            types.Part.from_function_response(name=fc.name, response={"result": out})
            for fc, (out, _is_error) in zip(calls, outs, strict=True)
        ]
        # Function responses go back as a user-role turn (Gemini convention).
        contents.append(types.Content(role="user", parts=response_parts))

    reply = _gemini_text(response)
    if not reply and calls:
        reply = "Let me get a person to help you with that."
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
