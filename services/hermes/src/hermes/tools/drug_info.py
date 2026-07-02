"""Grounded drug facts: get_drug_info (OpenFDA, cached in drug_cache)."""

from __future__ import annotations

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


async def get_drug_info(ctx: ToolContext, drug_name: str) -> str:
    key = drug_name.strip().lower()

    # 1. Cache hit? (RLS allows any authenticated user to read drug_cache.)
    cached = await ctx.db().select(
        "drug_cache",
        columns="openfda_payload",
        filters={"drug_key": f"eq.{key}"},
        limit=1,
    )
    if cached:
        summary = _summarize(cached[0]["openfda_payload"])
        if summary:
            return f"{summary}\n\n(Source: OpenFDA, cached.)"

    # 2. Cache miss -> fetch OpenFDA.
    settings = get_settings()
    params = {
        "search": f"openfda.brand_name:{key}+openfda.generic_name:{key}",
        "limit": "1",
    }
    if settings.openfda_api_key:
        params["api_key"] = settings.openfda_api_key
    async with httpx.AsyncClient(timeout=20.0) as http:
        resp = await http.get(_OPENFDA_URL, params=params)
    if resp.status_code == 404:
        return f"No authoritative OpenFDA label found for '{drug_name}'."
    if resp.status_code >= 300:
        return f"Could not reach the drug database right now (HTTP {resp.status_code})."

    payload = resp.json()
    summary = _summarize(payload)
    if not summary:
        return f"No usable OpenFDA label data found for '{drug_name}'."

    # 3. Write-through cache via the service role (reference table has no INSERT
    #    policy for authenticated users, so RLS would block a user write).
    try:
        await ctx.supabase.service_client().insert(
            "drug_cache",
            {"drug_key": key, "openfda_payload": payload},
            returning=False,
        )
    except Exception:
        # Caching is best-effort; a duplicate key or transient error must not
        # break the answer we already have.
        pass

    return f"{summary}\n\n(Source: OpenFDA.)"


register(_SCHEMA, get_drug_info)
