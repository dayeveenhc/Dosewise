"""Shared plumbing for tool handlers: the execution context and registry.

Each tool is ``(schema, handler)``. A handler is an async callable
``handler(ctx, **input) -> str`` that returns a plain-text result for Claude. The
string is what lands back in the model's context, so keep it concise and factual.
"""

from __future__ import annotations

import re
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
    #
    # Two entry shapes exist:
    # * single (``record_action``) — ``{tool, summary, entity_type, entity_id,
    #   changed_fields, **extra}`` — one write to one entity.
    # * bulk (``record_bulk_action``) — ``{tool, summary, entities: [...], **extra}``
    #   — ONE committed action covering multiple entities (e.g. resolving every
    #   missed dose at once). Each item in ``entities`` mirrors the single shape's
    #   per-entity fields: ``{entity_type, entity_id, changed_fields, ...}``.
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

    For a single commit that touches MANY entities at once, use
    ``record_bulk_action`` instead — one action with an ``entities`` list.
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


def record_bulk_action(
    ctx: ToolContext,
    *,
    tool: str,
    summary: str,
    entities: list[dict],
    **extra: Any,
) -> None:
    """Append ONE committed action covering MULTIPLE entities.

    Shape: ``{tool, summary, entities: [{entity_type, entity_id, changed_fields,
    ...}, ...], **extra}``. Each entity dict mirrors ``record_action``'s per-entity
    fields (``entity_type`` / ``entity_id`` / ``changed_fields``, plus any
    per-entity extras like ``dose_id`` or ``slot``); ``entity_id`` is coerced to
    ``str`` exactly like ``record_action`` does. Called ONLY from a commit branch —
    never a propose — so a bulk write (e.g. resolve_missed_doses marking every
    missed dose taken) surfaces as one action the UI can walk, not N loose ones.
    """
    ctx.committed_actions.append(
        {
            "tool": tool,
            "summary": summary,
            "entities": [
                {**e, "entity_id": str(e.get("entity_id", ""))} for e in entities
            ],
            **extra,
        }
    )


_DOSAGE_SUFFIX = re.compile(
    r"\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|units?)\b.*$", re.IGNORECASE
)


async def find_medications(
    ctx: ToolContext, name: str, *, columns: str, limit: int | None = 1
) -> list[dict]:
    """Non-archived medications matching ``name`` (case-insensitive ``ilike``).

    Centralizes the ``{"name": ilike, "archived": eq.false}`` lookup that every
    med-scoped tool runs. Callers keep their own ``columns``, their own
    "no medication named…" guard wording, and any post-processing — this only
    shares the filter + table. ``limit=None`` returns all matches (e.g. the
    verify tool, which counts/exact-matches every row); the default ``limit=1``
    suits the "act on one med" tools.

    A wildcard-less PostgREST ``ilike`` is an EXACT case-insensitive match, so a
    model echoing a display label ("Metformin 500mg") used to yield a false
    "not on file". On an exact miss this now retries with the dosage suffix
    stripped, then as a substring (``*name*``) — so honest near-matches resolve
    while the exact form stays the fast path.
    """

    async def q(pattern: str) -> list[dict]:
        return await ctx.db().select(
            "medications",
            columns=columns,
            filters={"name": f"ilike.{pattern}", "archived": "eq.false"},
            limit=limit,
        )

    meds = await q(name)
    if meds:
        return meds
    stripped = _DOSAGE_SUFFIX.sub("", name).strip()
    if stripped and stripped.lower() != name.strip().lower():
        meds = await q(stripped)
        if meds:
            return meds
    return await q(f"*{stripped or name.strip()}*")


def match_pending(ctx: ToolContext, slot: str, key: str, value: Any) -> dict | None:
    """The pending proposal on the session under ``slot``, if it matches ``value``.

    Every propose→confirm write tool guards its commit the same way: a confirm is
    only honored when a matching proposal was stashed this session (so a
    ``confirmed=true`` call can never save something that was never read back and
    agreed to). Returns the pending dict when ``getattr(session, slot).get(key) ==
    value``, else ``None`` — the caller refuses to save on ``None`` with its own
    tool-specific wording. The slot name is passed in verbatim (``pending_proposal``
    / ``pending_reminder`` / ``pending_profile``), so the session-attribute contract
    the Telegram deterministic-confirm path relies on is unchanged.
    """
    pending = getattr(ctx.session, slot, None) if ctx.session else None
    if pending is None or pending.get(key) != value:
        return None
    return pending


def first_id(inserted: list[dict]) -> str:
    """The new row's id from a ``return=representation`` insert, or ``""``.

    PostgREST returns the inserted rows; a write tool records the new id in its
    ``committed_action``. Empty string when the insert returned nothing (mirrors
    the fallback every insert site used inline before).
    """
    return str(inserted[0]["id"]) if inserted else ""


def register(schema: dict, handler: ToolHandler) -> None:
    _REGISTRY[schema["name"]] = (schema, handler)


def tool_schemas() -> list[dict]:
    return [schema for schema, _ in _REGISTRY.values()]


def get_handler(name: str) -> ToolHandler | None:
    entry = _REGISTRY.get(name)
    return entry[1] if entry else None
