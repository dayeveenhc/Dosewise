"""Runtime configuration for Hermes.

Loads from the repo-root ``.env`` (three levels up from this file:
``services/hermes/src/hermes/config.py`` -> repo root). All secrets live in that
git-ignored file; nothing is hardcoded here.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# services/hermes/src/hermes/config.py -> repo root is 4 parents up.
_REPO_ROOT = Path(__file__).resolve().parents[3]


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

    # --- Anthropic (agent brain) ---
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"

    # --- OpenFDA (optional; works keyless at a lower rate limit) ---
    openfda_api_key: str = ""

    # --- Telegram (test channel) ---
    telegram_bot_token: str = ""
    telegram_webhook_secret: str = ""

    # --- Hermes VPS / deployment ---
    vps_url: str = ""
    hermes_host: str = "0.0.0.0"
    hermes_port: int = 8000
    hermes_channel_mode: str = "polling"  # polling | webhook

    # --- Telegram test identity mapping ---
    # Elder A from supabase/seed/seed.sql
    dev_default_elder_id: str = "00000000-0000-0000-0000-00000000000a"

    @property
    def repo_root(self) -> Path:
        return _REPO_ROOT


@lru_cache
def get_settings() -> Settings:
    return Settings()
