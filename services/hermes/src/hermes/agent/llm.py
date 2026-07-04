"""LLM provider selection — build the right brain client from settings.

Hermes runs on OpenAI by default, or Google (Gemini) / Anthropic (Claude), chosen
by ``LLM_PROVIDER``. The rest of the app treats the returned object opaquely; the
agent loop (``agent/loop.py``) knows how to drive each provider. SDKs are imported
lazily so an unused provider's package never has to be present.

**Safety fallback:** if ``LLM_PROVIDER`` is ``openai`` or ``gemini`` but that
provider's API key isn't set yet (and an Anthropic key is), the *effective*
provider falls back to Anthropic — with a loud warning — so a missing key can't
crash a live server (each SDK raises on an empty key). Add the missing key +
restart and it flips over on its own.
"""

from __future__ import annotations

import logging

from .. import config

log = logging.getLogger("hermes.llm")

_KEY_FIELD = {"openai": "openai_api_key", "gemini": "gemini_api_key"}
_KEY_ENV_NAME = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}


def provider(settings: config.Settings | None = None) -> str:
    """The provider as configured (raw ``LLM_PROVIDER``)."""
    settings = settings or config.get_settings()
    return settings.llm_provider.strip().lower()


def effective_provider(settings: config.Settings | None = None) -> str:
    """The provider actually used, after the missing-key fallback."""
    settings = settings or config.get_settings()
    configured = provider(settings)
    key_field = _KEY_FIELD.get(configured)
    if key_field and not getattr(settings, key_field) and settings.anthropic_api_key:
        return "anthropic"
    return configured


def make_client(settings: config.Settings | None = None):
    """Construct the brain client for the effective provider."""
    settings = settings or config.get_settings()
    configured = provider(settings)
    eff = effective_provider(settings)
    if configured in _KEY_FIELD and eff != configured:
        env_name = _KEY_ENV_NAME[configured]
        log.warning(
            "LLM_PROVIDER=%s but %s is empty — using Anthropic for now. Add "
            "%s to .env and restart to switch.", configured, env_name, env_name,
        )
    if eff == "openai":
        from openai import AsyncOpenAI

        return AsyncOpenAI(api_key=settings.openai_api_key)
    if eff == "gemini":
        from google import genai

        return genai.Client(api_key=settings.gemini_api_key)
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(api_key=settings.anthropic_api_key)


def api_key_present(settings: config.Settings | None = None) -> bool:
    """True if the effective provider has an API key configured."""
    settings = settings or config.get_settings()
    eff = effective_provider(settings)
    key_field = _KEY_FIELD.get(eff)
    if key_field:
        return bool(getattr(settings, key_field))
    return bool(settings.anthropic_api_key)


def api_key_env_name(settings: config.Settings | None = None) -> str:
    eff = effective_provider(settings)
    return _KEY_ENV_NAME.get(eff, "ANTHROPIC_API_KEY")


async def aclose(client) -> None:
    """Best-effort close (Anthropic's async client has .close(); Gemini has
    none)."""
    close = getattr(client, "close", None)
    if close is None:
        return
    result = close()
    if hasattr(result, "__await__"):
        await result
