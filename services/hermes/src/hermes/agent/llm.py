"""LLM provider selection — build the right brain client from settings.

Hermes can run on Anthropic (Claude) or Google (Gemini), chosen by
``LLM_PROVIDER``. The rest of the app treats the returned object opaquely; the
agent loop (``agent/loop.py``) knows how to drive each provider. SDKs are imported
lazily so the unused provider's package never has to be present.

**Safety fallback:** if ``LLM_PROVIDER=gemini`` but no ``GEMINI_API_KEY`` is set
yet (and an Anthropic key is), the *effective* provider stays Anthropic — with a
loud warning — so a half-finished switch can't crash a live server (the Gemini SDK
raises on an empty key). Add the key + restart and it flips to Gemini on its own.
"""

from __future__ import annotations

import logging

from .. import config

log = logging.getLogger("hermes.llm")


def provider(settings: config.Settings | None = None) -> str:
    """The provider as configured (raw ``LLM_PROVIDER``)."""
    settings = settings or config.get_settings()
    return settings.llm_provider.strip().lower()


def effective_provider(settings: config.Settings | None = None) -> str:
    """The provider actually used, after the missing-Gemini-key fallback."""
    settings = settings or config.get_settings()
    if provider(settings) == "gemini" and not settings.gemini_api_key:
        if settings.anthropic_api_key:
            return "anthropic"
    return provider(settings)


def make_client(settings: config.Settings | None = None):
    """Construct the brain client for the effective provider."""
    settings = settings or config.get_settings()
    eff = effective_provider(settings)
    if provider(settings) == "gemini" and eff != "gemini":
        log.warning(
            "LLM_PROVIDER=gemini but GEMINI_API_KEY is empty — using Anthropic for "
            "now. Add GEMINI_API_KEY to .env and restart to switch to Gemini."
        )
    if eff == "gemini":
        from google import genai

        return genai.Client(api_key=settings.gemini_api_key)
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(api_key=settings.anthropic_api_key)


def api_key_present(settings: config.Settings | None = None) -> bool:
    """True if the effective provider has an API key configured."""
    settings = settings or config.get_settings()
    if effective_provider(settings) == "gemini":
        return bool(settings.gemini_api_key)
    return bool(settings.anthropic_api_key)


def api_key_env_name(settings: config.Settings | None = None) -> str:
    name = "GEMINI_API_KEY" if effective_provider(settings) == "gemini" else "ANTHROPIC_API_KEY"
    return name


async def aclose(client) -> None:
    """Best-effort close (Anthropic's async client has .close(); Gemini has none)."""
    close = getattr(client, "close", None)
    if close is None:
        return
    result = close()
    if hasattr(result, "__await__"):
        await result
