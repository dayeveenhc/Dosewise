"""Grounded drug facts: get_drug_info (OpenFDA, cached in drug_cache)."""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import quote

import httpx

from ..config import get_settings
from .base import ToolContext, register

log = logging.getLogger("hermes.tools.drug_info")

_OPENFDA_URL = "https://api.fda.gov/drug/label.json"

# Common non-US brand names OpenFDA (US FDA labels) doesn't index under the brand
# the elder knows. Map to the US generic so a lookup still grounds. Lowercase keys.
_BRAND_ALIASES = {
    "panadol": "acetaminophen",
    "paracetamol": "acetaminophen",
    "ventolin": "albuterol",
    "nurofen": "ibuprofen",
    "brufen": "ibuprofen",
    "augmentin": "amoxicillin and clavulanate",
    "zantac": "ranitidine",
    "lasix": "furosemide",
    "glucophage": "metformin",
}

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


def _search_url(query: str) -> str:
    """Build an OpenFDA label URL for a raw Lucene ``search`` clause.

    OpenFDA uses '+' as the token separator inside a query. Passing the query via
    httpx's params= dict percent-encodes that '+' to %2B, which OpenFDA rejects with
    a 500 — so we build the query into the URL and keep '+' literal. The caller has
    already URL-encoded any user-derived term (safe="") to avoid query injection.
    """
    url = f"{_OPENFDA_URL}?search={query}&limit=1"
    api_key = get_settings().openfda_api_key
    if api_key:
        url += f"&api_key={quote(api_key, safe='')}"
    return url


async def _openfda_get(query: str) -> dict | None:
    """GET one OpenFDA search with a single retry on transient errors.

    Returns the parsed payload (which may have zero results — a 404 NOT_FOUND is a
    valid "no match", not a transient failure), or ``None`` when OpenFDA was
    unreachable / rate-limited even after the retry.
    """
    url = _search_url(query)
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=20.0) as http:
                resp = await http.get(url)
        except httpx.HTTPError:
            resp = None
        # 404 = OpenFDA's "No matches found" — a definitive empty result, return it.
        if resp is not None and resp.status_code == 404:
            return resp.json()
        if resp is not None and resp.status_code < 300:
            return resp.json()
        # 429 / 5xx / network error: back off briefly and retry once.
        if attempt == 0:
            status = getattr(resp, "status_code", "network")
            log.info("openfda transient failure (%s), retrying", status)
            await asyncio.sleep(0.5)
    return None


def _has_results(payload: dict | None) -> bool:
    return bool((payload or {}).get("results"))


async def _fetch_label(ctx: ToolContext, drug_name: str) -> tuple[dict | None, str]:
    """Return an OpenFDA label payload for ``drug_name`` and where it came from.

    Cache-first: reads ``drug_cache`` (RLS lets any authenticated user read it),
    falling back to a live OpenFDA fetch that is written through via the service
    role. Robust to brand names: if the brand/generic search misses, it retries with
    a known-brand alias and then a plain full-text search before giving up. Returns
    ``(payload, source)`` where ``source`` is ``"cache"``, ``"openfda"``, or ``""``
    when nothing usable was found (empty result) or OpenFDA was unreachable.
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

    q = quote(key, safe="")
    # 1. Precise: brand OR generic (explicit OR so either field matching is a hit).
    payload = await _openfda_get(f"openfda.brand_name:{q}+OR+openfda.generic_name:{q}")
    # 2. Known-brand alias (e.g. panadol -> acetaminophen) when the brand isn't in
    #    OpenFDA's US labels under that name.
    if not _has_results(payload) and key in _BRAND_ALIASES:
        alias = quote(_BRAND_ALIASES[key], safe="")
        payload = await _openfda_get(f"openfda.generic_name:{alias}")
    # 3. Last resort: a plain full-text search across the whole label.
    if not _has_results(payload):
        full = await _openfda_get(q)
        if _has_results(full):
            payload = full

    if not _has_results(payload):
        # payload is not None -> OpenFDA answered with an empty result (source
        # "openfda" so the caller reports "no data" rather than "unreachable").
        return payload, "openfda" if payload is not None else ""

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
        # OpenFDA was unreachable/rate-limited (not a genuine "no such drug").
        return (
            f"Couldn't reach the OpenFDA drug database just now for '{drug_name}'. "
            "Tell the patient you'll try again in a moment, and don't guess drug "
            "facts in the meantime."
        )
    summary = _summarize(payload or {})
    if not summary:
        # OpenFDA answered but had no label for this spelling/name.
        return (
            f"No OpenFDA record matched '{drug_name}'. Ask the patient to check the "
            "spelling or read the exact name on the box, or offer to queue a question "
            "for the doctor (add_doctor_question). Do not invent drug facts."
        )
    suffix = "(Source: OpenFDA, cached.)" if source == "cache" else "(Source: OpenFDA.)"
    return f"{summary}\n\n{suffix}"


register(_SCHEMA, get_drug_info)
