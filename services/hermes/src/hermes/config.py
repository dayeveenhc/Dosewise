"""Runtime configuration for Hermes.

Loads from the repo-root ``.env`` (three levels up from this file:
``services/hermes/src/hermes/config.py`` -> repo root). All secrets live in that
git-ignored file; nothing is hardcoded here.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# src/hermes/config.py -> repo root:
#   parents[0]=hermes  [1]=src  [2]=services/hermes  [3]=services  [4]=repo root
_REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Supabase ---
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""

    # --- LLM provider selection ---
    # Which brain Hermes uses: "openai" (default), "gemini", or "anthropic" (Claude).
    # OpenAI is the configured brain; Anthropic is the automatic fallback when the
    # configured provider's key is unset (see agent/llm.py effective_provider).
    llm_provider: str = "openai"

    # --- OpenAI (agent brain; the default) ---
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    # --- Google Gemini (agent brain; alternative) ---
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    # --- Anthropic (agent brain; automatic fallback when the configured provider's
    # key is unset) ---
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"

    # --- OpenFDA (optional; works keyless at a lower rate limit) ---
    openfda_api_key: str = ""

    # --- HuggingFace (voice: STT + TTS + language ID on Telegram) ---
    huggingface_api_key: str = ""
    # High-resource multilingual STT (zh/ta/ms/en/yue...), via the HF Inference API.
    hf_stt_model: str = "openai/whisper-large-v3"
    # Low-resource / dialect STT (Hokkien/Teochew -> 'nan'); tried best-effort, then
    # Hermes falls back to Whisper autodetect if the MMS route fails.
    hf_stt_lowresource_model: str = "facebook/mms-1b-all"
    # TTS default/fallback model. Per-language MMS models (facebook/mms-tts-<iso3>)
    # are chosen at reply time; this is the fallback when the language is unknown.
    # Empty disables spoken replies (text still always sent).
    hf_tts_model: str = "facebook/mms-tts-eng"
    # fastText language-identification model (downloaded locally via huggingface_hub;
    # NOT served by the HF Inference API). Empty disables input-language detection.
    hf_lid_model: str = "facebook/fasttext-language-identification"

    # --- MongoDB (dialect slang dictionary; optional) ---
    # When set, Hermes loads dialect slang -> meaning here and folds it into the
    # system prompt so it understands the elder's slang. Empty disables it.
    mongodb_uri: str = ""
    mongodb_db: str = "dosewise"
    mongodb_slang_collection: str = "dialect_slang"
    # Cap the number of slang terms injected into the prompt.
    slang_cap: int = 40

    # --- Telegram (test channel) ---
    telegram_bot_token: str = ""
    telegram_webhook_secret: str = ""

    # --- Hermes VPS / deployment ---
    vps_url: str = ""
    hermes_host: str = "0.0.0.0"
    hermes_port: int = 8000
    hermes_channel_mode: str = "polling"  # polling | webhook
    # Dev: hot-reload the server when the mounted source changes (uvicorn --reload).
    hermes_reload: bool = False

    # --- Telegram test identity mapping ---
    # Elder A from supabase/seed/seed.sql
    dev_default_elder_id: str = "00000000-0000-0000-0000-00000000000a"

    # --- Strict auth (production posture) ---
    # When true, an agent turn must carry a verified Supabase JWT: the /agent/turn
    # `elder_id` fallback is rejected and Telegram's /switch impersonation is
    # disabled. Default false keeps the local/Telegram/CLI demo ergonomic.
    hermes_strict_auth: bool = False

    # --- Rate limiting (in-process; see ratelimit.py) ---
    rate_limit_enabled: bool = True
    # Per-user caps on expensive agent turns (keyed by elder_id / Telegram chat_id).
    rate_limit_turns_per_minute: int = 12
    rate_limit_turns_per_hour: int = 120
    # Coarse per-IP ceiling on the POST endpoints (/agent/turn, /telegram/webhook).
    rate_limit_http_per_minute: int = 60

    # --- Reminder scheduler (Telegram delivery; replaces Expo Push for the demo) ---
    reminders_enabled: bool = True
    reminder_poll_seconds: int = 60
    # A critical dose this many minutes overdue (and not logged taken) alerts the
    # linked caregiver.
    missed_dose_minutes: int = 60
    # medications.schedule.times are wall-clock; interpret them in this timezone
    # when computing daily reminders (elders are in Singapore for the demo).
    hermes_tz: str = "Asia/Singapore"

    @property
    def repo_root(self) -> Path:
        return _REPO_ROOT


@lru_cache
def get_settings() -> Settings:
    return Settings()
