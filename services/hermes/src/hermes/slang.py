"""Dialect slang dictionary backed by MongoDB (optional).

The elder's dialect often carries slang the agent must *understand* (not just
mirror). Those term→meaning pairs live in a MongoDB collection the deployment
provides; Hermes folds a capped glossary into the system prompt so it can parse
what the elder says. Everything degrades gracefully: with no ``MONGODB_URI`` (or on
any lookup error) ``get_slang`` returns ``[]`` and the agent simply runs without a
glossary.

Expected document shape (field names are best-effort — ``normalized_en`` is also
accepted for compatibility with the Supabase ``dialect_lexicon`` seed):
``{"dialect": "hokkien", "term": "pang sai", "meaning": "bowel movement"}``

Motor is imported lazily so the driver need not be present when Mongo is unused.
"""

from __future__ import annotations

import logging
import time

from .config import get_settings

log = logging.getLogger("hermes.slang")

_TTL_SECONDS = 600.0
# dialect -> (fetched_at_monotonic, rows). Only successful lookups are cached.
_CACHE: dict[str, tuple[float, list[tuple[str, str]]]] = {}
_client = None  # lazily-built motor client singleton


def _get_client():
    """The shared motor client, or None when Mongo isn't configured."""
    global _client
    settings = get_settings()
    if not settings.mongodb_uri:
        return None
    if _client is None:
        from motor.motor_asyncio import AsyncIOMotorClient

        _client = AsyncIOMotorClient(settings.mongodb_uri)
    return _client


async def get_slang(dialect: str | None) -> list[tuple[str, str]]:
    """Return ``[(term, meaning), ...]`` for a dialect (capped, cached), or ``[]``."""
    if not dialect or dialect.lower() == "en":
        return []
    key = dialect.lower()
    now = time.monotonic()
    cached = _CACHE.get(key)
    if cached and now - cached[0] < _TTL_SECONDS:
        return cached[1]

    client = _get_client()
    if client is None:
        _CACHE[key] = (now, [])
        return []

    settings = get_settings()
    try:
        coll = client[settings.mongodb_db][settings.mongodb_slang_collection]
        cursor = coll.find(
            {"dialect": key}, {"term": 1, "meaning": 1, "normalized_en": 1, "_id": 0}
        ).limit(settings.slang_cap)
        rows: list[tuple[str, str]] = []
        async for doc in cursor:
            term = (doc.get("term") or "").strip()
            meaning = (doc.get("meaning") or doc.get("normalized_en") or "").strip()
            if term and meaning:
                rows.append((term, meaning))
    except Exception:
        log.warning("mongo slang lookup failed for dialect=%s", key, exc_info=True)
        return []  # don't cache failures — allow a retry next turn

    _CACHE[key] = (now, rows)
    return rows


async def aclose() -> None:
    """Close the motor client on shutdown (idempotent)."""
    global _client
    if _client is not None:
        _client.close()
        _client = None
    _CACHE.clear()
