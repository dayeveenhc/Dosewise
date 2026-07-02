"""The Claude tool-calling loop — the heart of Hermes.

``run_agent_turn`` runs one user turn end to end: it calls Claude Sonnet 5 with the
tool belt, dispatches any tool calls (acting as the elder, RLS-scoped), feeds the
results back, and returns the final plain-language reply. The ``messages`` list is
threaded in and out so a channel can keep multi-turn context.
"""

from __future__ import annotations

import base64
import logging

from anthropic import AsyncAnthropic

from ..config import get_settings
from ..tools import ToolContext, get_handler, tool_schemas
from .prompts import SYSTEM_PROMPT

log = logging.getLogger("hermes.agent")

_MAX_ITERATIONS = 8
_MAX_TOKENS = 4096


async def run_agent_turn(
    anthropic: AsyncAnthropic,
    ctx: ToolContext,
    user_text: str,
    *,
    image_bytes: bytes | None = None,
    image_media_type: str = "image/jpeg",
    history: list[dict] | None = None,
) -> tuple[str, list[str], list[dict]]:
    """Run one turn. Returns (reply_text, tools_used, updated_messages)."""
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

    tools = tool_schemas()
    tools_used: list[str] = []
    response = None

    for _ in range(_MAX_ITERATIONS):
        response = await anthropic.messages.create(
            model=settings.anthropic_model,
            max_tokens=_MAX_TOKENS,
            system=SYSTEM_PROMPT,
            thinking={"type": "adaptive"},
            tools=tools,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            break

        # Echo the assistant turn back verbatim (preserves thinking + tool_use blocks).
        messages.append({"role": "assistant", "content": response.content})

        results: list[dict] = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            tools_used.append(block.name)
            handler = get_handler(block.name)
            try:
                if handler is None:
                    out = f"Unknown tool '{block.name}'."
                    is_error = True
                else:
                    out = await handler(ctx, **(block.input or {}))
                    is_error = False
            except Exception as exc:  # surface tool failures to the model, don't crash
                log.exception("tool %s failed", block.name)
                out = f"Tool error: {exc}"
                is_error = True
            result: dict = {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": out,
            }
            if is_error:
                result["is_error"] = True
            results.append(result)

        messages.append({"role": "user", "content": results})

    reply = _extract_text(response) if response is not None else ""
    if response is not None and response.stop_reason == "tool_use":
        # Hit the iteration cap mid-loop; give a safe fallback.
        reply = reply or "Let me get a person to help you with that."

    messages.append({"role": "assistant", "content": reply})
    await _persist(ctx, user_text, reply, tools_used)
    return reply, tools_used, messages


def _extract_text(response) -> str:
    return "".join(
        block.text for block in response.content if block.type == "text"
    ).strip()


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
