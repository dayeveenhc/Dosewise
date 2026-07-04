"""Grounded drug facts: get_drug_info (OpenFDA, cached in drug_cache)."""

from __future__ import annotations

from urllib.parse import quote

import httpx

from ..config import get_settings
from .base import ToolContext, register

_OPENFDA_URL = "https://api.fda.gov/drug/label.json"

_SCHEMA = {
    "name": "get_drug_info",
    "description": (
        "Fetch authoritative, grounded facts about a drug (purpose, usage, warnings) "
        "from OpenFDA, cached in Postgres. Use this to answer any medication question "
        "— never invent drug facts. Explain in plain language; never diagnose."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "drug_name": {"type": "string", "description": "Drug name to look up."}
        },
        "required": ["drug_name"],
    },
}

# OpenFDA label fields we surface, in priority order.
_FIELDS = [
    ("purpose", "Purpose"),
    ("indications_and_usage", "Uses"),
    ("dosage_and_administration", "Dosage"),
    ("warnings", "Warnings"),
    ("when_using", "When using"),
]


def _summarize(payload: dict) -> str:
    results = payload.get("results") or []
    if not results:
        return ""
    label = results[0]
    parts: list[str] = []
    for key, heading in _FIELDS:
        value = label.get(key)
        if value:
            text = value[0] if isinstance(value, list) else str(value)
            parts.append(f"{heading}: {text.strip()[:400]}")
    return "\n".join(parts)


async def _fetch_label(ctx: ToolContext, drug_name: str) -> tuple[dict | None, str]:
    """Return an OpenFDA label payload for ``drug_name`` and where it came from.

    Cache-first: reads ``drug_cache`` (RLS lets any authenticated user read it),
    falling back to a live OpenFDA fetch that is written through via the service
    role. Returns ``(payload, source)`` where ``source`` is ``"cache"``,
    ``"openfda"``, or ``""`` when nothing usable was found / reachable.
    """
    key = drug_name.strip().lower()

    cached = await ctx.db().select(
        "drug_cache",
        columns="openfda_payload",
        filters={"drug_key": f"eq.{key}"},
        limit=1,
    )
    if cached:
        return cached[0]["openfda_payload"], "cache"

    settings = get_settings()
    # OpenFDA uses '+' as the term separator inside a field query. Passing the query
    # via httpx's params= dict percent-encodes that '+' to %2B, which OpenFDA rejects
    # with a 500 — breaking every uncached lookup. So build the query into the URL and
    # keep '+' literal; the user-derived key is URL-encoded (safe="") to avoid query
    # injection.
    q = quote(key, safe="")
    url = f"{_OPENFDA_URL}?search=openfda.brand_name:{q}+openfda.generic_name:{q}&limit=1"
    if settings.openfda_api_key:
        url += f"&api_key={quote(settings.openfda_api_key, safe='')}"
    async with httpx.AsyncClient(timeout=20.0) as http:
        resp = await http.get(url)
    if resp.status_code >= 300:
        return None, ""

    payload = resp.json()
    if not (payload.get("results") or []):
        return payload, "openfda"

    # Write-through cache via the service role (reference table has no INSERT
    # policy for authenticated users, so RLS would block a user write). Best-effort:
    # a duplicate key or transient error must not break the answer we already have.
    try:
        await ctx.supabase.service_client().insert(
            "drug_cache",
            {"drug_key": key, "openfda_payload": payload},
            returning=False,
        )
    except Exception:
        pass
    return payload, "openfda"


async def interaction_text(ctx: ToolContext, drug_name: str) -> str:
    """Grounded, free-text drug-interaction section from the OpenFDA label (or "")."""
    payload, _ = await _fetch_label(ctx, drug_name)
    results = (payload or {}).get("results") or []
    if not results:
        return ""
    label = results[0]
    parts: list[str] = []
    for field in ("drug_interactions", "drug_and_or_laboratory_test_interactions"):
        value = label.get(field)
        if value:
            parts.append(value[0] if isinstance(value, list) else str(value))
    return "\n".join(parts)


async def get_drug_info(ctx: ToolContext, drug_name: str) -> str:
    payload, source = await _fetch_label(ctx, drug_name)
    if not source:
        return f"Could not find or reach authoritative drug data for '{drug_name}'."
    summary = _summarize(payload or {})
    if not summary:
        return f"No usable OpenFDA label data found for '{drug_name}'."
    suffix = "(Source: OpenFDA, cached.)" if source == "cache" else "(Source: OpenFDA.)"
    return f"{summary}\n\n{suffix}"


register(_SCHEMA, get_drug_info)
