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
    # Which app shell is asking ("elder" | "caregiver"). The two render entirely
    # different screens, so start_walkthrough uses it to refuse a walkthrough
    # that could only ever spotlight elements the caller doesn't have. Client-
    # supplied and therefore untrusted — deliberately used ONLY for that UI
    # affordance, never for authorization (RLS is what decides who may read or
    # write what). Defaults to the elder app, which is every non-web channel.
    app_role: str = "elder"
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
    # Set by start_walkthrough when queued this turn — {"task_name": str,
    # "params": dict[str, str], "risk"?: {"flagged": bool, "signals": [str],
    # "reasons": [str]}}. "signals" is a stable machine-legible code per fired
    # axis (e.g. "dosage_jump"), same order/length as "reasons"' matching
    # human-readable prose — a consumer that needs to test for a SPECIFIC
    # signal (e.g. suppressing a client-side confirm dialog already covering
    # the same dosage jump) must check "signals", never substring-match
    # "reasons" (risk.py's module docstring explains why). "risk"
    # (risk.py::assess_risk) is present ONLY for the *_auto family this
    # dispatch actually risk-assesses (walkthrough.py::RISK_ASSESSED_TASKS) —
    # every other task_name carries no "risk" key at all, not a default-false
    # one, so the client can tell "not assessed" from "assessed and clean".
    # NOT a write, so deliberately separate from committed_actions: nothing
    # was saved, only a client-side UI script was requested. A single value
    # (not a list): only one walkthrough can be queued per turn.
    walkthrough: dict | None = None
    # Set by offer_choices when the agent wants the web client to render tappable
    # option buttons under its reply (a yes/no confirm, or a guided clarifying
    # question). Each entry is {"label": str, "value": str}: label is the button
    # text, value is the message sent when tapped. Not a write — like walkthrough,
    # a client-side UI hint. Last call this turn wins.
    choices: list[dict] | None = None
    # Set by raise_alert when something needs acting on TODAY and the person
    # would otherwise miss it — {"severity": "critical"|"urgent", "title": str,
    # "body": str, "medication_name": str | None}. The web client surfaces it as
    # a full-screen popup that reaches them even after they leave the chat.
    #
    # Not a write, like walkthrough/choices above, and a single value: at most
    # one thing may interrupt per turn. A documented no-op on Telegram — the
    # tool's own return text is what the model speaks there, so a Telegram user
    # still hears the warning, just as prose.
    alert: dict | None = None

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

# Same unit vocabulary as _DOSAGE_SUFFIX, but with capture groups — that
# pattern only ever `.sub()`s a name string, this one extracts a comparable
# (value, unit) pair from a free-text dosage like "500mg" or "2.5 ml".
_DOSAGE_VALUE = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu|units?)\b", re.IGNORECASE)


def parse_dosage(text: str | None) -> tuple[float, str] | None:
    """The first ``(value, unit)`` a free-text dosage string names, or ``None``.

    ``unit`` is lowercased. Returns ``None`` for anything without a recognized
    number+unit (``"2 tablets"``, ``"as needed"``, empty, ``None``) so callers
    can fail open — no dosage-magnitude check in this codebase should ever
    crash or misfire on an unparseable value, only skip silently.
    """
    if not text:
        return None
    m = _DOSAGE_VALUE.search(text)
    if not m:
        return None
    return float(m.group(1)), m.group(2).lower()


# Mass units this codebase can compare across (mg is the common unit); ml/iu/
# units aren't a fixed mass so are left out — better to skip the check than
# guess a wrong conversion. Shared by medications.py's advisory dose-jump
# caveat (``_dosage_warning``) and risk.py's classifier.
_MG_PER_UNIT = {"mg": 1.0, "mcg": 0.001, "g": 1000.0}

# Fires at a DOUBLED dose or more. Shared threshold: medications.py's
# _dosage_warning is a non-blocking FYI where erring toward flagging more real
# jumps outweighs the low cost of occasionally flagging a routine titration;
# risk.py's classifier uses the exact same number for its own (harder) gate.
DOSAGE_INCREASE_MULTIPLIER = 2.0


def _as_mg(value: float, unit: str) -> float | None:
    factor = _MG_PER_UNIT.get(unit)
    return value * factor if factor is not None else None


def dosage_ratio(old_dosage: str | None, new_dosage: str | None) -> float | None:
    """``new_dosage / old_dosage`` as a comparable mg ratio, or ``None`` when
    either side is unparseable, uses a non-mass unit (ml/iu/units), or the old
    dose is zero — i.e. exactly the cases neither side can honestly compare.

    Pure arithmetic (parse both via ``parse_dosage``, normalize via
    ``_MG_PER_UNIT``, divide), shared by two callers with DELIBERATELY
    OPPOSITE fail biases on that ``None``: ``medications.py``'s
    ``_dosage_warning`` is a non-blocking advisory caveat, so it fails OPEN
    (``None`` -> no caveat, never blocks a save). ``risk.py``'s classifier
    fails CLOSED on that same ``None`` — an unparseable/incomparable dosage is
    exactly the kind of thing a human should see, not the kind that should
    silently pass. This function stays neutral; each caller applies its own
    bias to the ``None``.
    """
    old = parse_dosage(old_dosage)
    new = parse_dosage(new_dosage)
    if old is None or new is None:
        return None
    old_mg = _as_mg(*old)
    new_mg = _as_mg(*new)
    if old_mg is None or new_mg is None or old_mg <= 0:
        return None
    return new_mg / old_mg


async def find_medications_tiered(
    ctx: ToolContext, name: str, *, columns: str, limit: int | None = 1
) -> tuple[list[dict], str | None]:
    """Same three-tier lookup as ``find_medications``, but also reports which
    tier matched — ``"exact"`` / ``"suffix"`` / ``"wildcard"`` / ``None`` (no
    match at any tier). ``find_medications``'s existing callers don't care
    which tier resolved the name; risk.py's low-confidence-disambiguation
    signal needs exactly that (an exact hit is confident, a suffix/wildcard
    hit is not), so this is a separate function rather than changing
    ``find_medications``'s return shape for everyone.
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
        return meds, "exact"
    stripped = _DOSAGE_SUFFIX.sub("", name).strip()
    if stripped and stripped.lower() != name.strip().lower():
        meds = await q(stripped)
        if meds:
            return meds, "suffix"
    meds = await q(f"*{stripped or name.strip()}*")
    return meds, ("wildcard" if meds else None)


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
    while the exact form stays the fast path. (Thin wrapper over
    ``find_medications_tiered``, which also reports which tier matched.)
    """
    meds, _tier = await find_medications_tiered(ctx, name, columns=columns, limit=limit)
    return meds


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


def match_pending_bulk(ctx: ToolContext, tool: str) -> list | None:
    """The pending bulk proposal's ``items`` for ``tool``, if one is stashed.

    The bulk counterpart of ``match_pending``: multi-item propose→confirm tools
    share ONE session slot, ``pending_bulk`` = ``{"tool": str, "items": list}``.
    A commit is honored only when the stashed proposal belongs to the SAME tool,
    so a ``confirmed=true`` call can never save a list that was never read back
    and agreed to (or one proposed by a different tool). Returns the ``items``
    list, else ``None`` — the caller refuses to save on ``None`` with its own
    tool-specific wording.
    """
    pending = getattr(ctx.session, "pending_bulk", None) if ctx.session else None
    if not isinstance(pending, dict) or pending.get("tool") != tool:
        return None
    return pending.get("items") or []


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
