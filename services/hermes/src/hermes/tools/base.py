"""Shared plumbing for tool handlers: the execution context and registry.

Each tool is ``(schema, handler)``. A handler is an async callable
``handler(ctx, **input) -> str`` that returns a plain-text result for Claude. The
string is what lands back in the model's context, so keep it concise and factual.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

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
    # Writes committed during THIS turn. A write tool appends an entry only on its
    # actual commit (never on a propose), so a channel can reliably tell that
    # something was saved (vs merely proposed) and act on it — e.g. the web app
    # confirms and redirects to the page that shows the change. Fresh per turn:
    # ToolContext is rebuilt per request (HTTP) / per message (Telegram).
    committed_actions: list[dict] = field(default_factory=list)
    # Set by start_walkthrough when queued this turn — {"task_name": str}. NOT a
    # write, so deliberately separate from committed_actions: nothing was saved,
    # only a client-side UI script was requested. A single value (not a list):
    # only one walkthrough can be queued per turn.
    walkthrough: dict | None = None

    def db(self):
        """RLS-scoped PostgREST client acting as this elder."""
        return self.supabase.user_client(self.elder_id)


ToolHandler = Callable[..., Awaitable[str]]

# name -> (anthropic tool schema, handler)
_REGISTRY: dict[str, tuple[dict, ToolHandler]] = {}


def record_action(
    ctx: ToolContext,
    *,
    tool: str,
    summary: str,
    entity_type: str,
    entity_id: Any,
    changed_fields: dict[str, dict] | None = None,
    **extra: Any,
) -> None:
    """Append a committed write to ``ctx.committed_actions`` in the standard shape.

    Called ONLY from a write tool's commit branch (never a propose). Carries WHAT
    changed, not just THAT something changed, so the web app can navigate to the
    exact record and highlight it:

    * ``entity_type`` — e.g. "medication", "schedule_entry", "refill_request",
      "profile_field", "caregiver_invite".
    * ``entity_id`` — the real DB id (or a stable field key for a jsonb field),
      stringified. This is what the UI targets as ``data-testid="{type}-{id}"``.
    * ``changed_fields`` — ``{fieldName: {"before": any, "after": any}}``; ``before``
      is ``None`` for a newly-created record. The UI builds its caption from this.

    ``extra`` keeps back-compat keys (e.g. ``name`` for the legacy med highlight).
    """
    ctx.committed_actions.append(
        {
            "tool": tool,
            "summary": summary,
            "entity_type": entity_type,
            "entity_id": str(entity_id),
            "changed_fields": changed_fields or {},
            **extra,
        }
    )


def register(schema: dict, handler: ToolHandler) -> None:
    _REGISTRY[schema["name"]] = (schema, handler)


def tool_schemas() -> list[dict]:
    return [schema for schema, _ in _REGISTRY.values()]


def get_handler(name: str) -> ToolHandler | None:
    entry = _REGISTRY.get(name)
    return entry[1] if entry else None
