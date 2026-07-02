"""Shared plumbing for tool handlers: the execution context and registry.

Each tool is ``(schema, handler)``. A handler is an async callable
``handler(ctx, **input) -> str`` that returns a plain-text result for Claude. The
string is what lands back in the model's context, so keep it concise and factual.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ..db.supabase import Supabase


@dataclass
class ToolContext:
    """Everything a tool needs to act on the current elder's behalf."""

    supabase: Supabase
    elder_id: str
    # Per-conversation scratch state (e.g. a pending add_prescription proposal).
    session: Any = None
    # Optional Telegram client, so message_caregiver can DM a linked caregiver
    # when that caregiver is also chatting with the bot.
    telegram: Any = None

    def db(self):
        """RLS-scoped PostgREST client acting as this elder."""
        return self.supabase.user_client(self.elder_id)


ToolHandler = Callable[..., Awaitable[str]]

# name -> (anthropic tool schema, handler)
_REGISTRY: dict[str, tuple[dict, ToolHandler]] = {}


def register(schema: dict, handler: ToolHandler) -> None:
    _REGISTRY[schema["name"]] = (schema, handler)


def tool_schemas() -> list[dict]:
    return [schema for schema, _ in _REGISTRY.values()]


def get_handler(name: str) -> ToolHandler | None:
    entry = _REGISTRY.get(name)
    return entry[1] if entry else None
