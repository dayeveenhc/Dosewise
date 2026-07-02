"""FastAPI app factory + lifespan, and the ``hermes-serve`` entry point.

Lifespan wires up the Anthropic client, the Supabase client, the session registry,
and (if a token is configured) Telegram. In ``polling`` mode it spawns the long-poll
loop as a background task; in ``webhook`` mode it registers the webhook against
``VPS_URL``.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn
from anthropic import AsyncAnthropic
from fastapi import FastAPI

from .api.routes import router
from .channels.session import SessionRegistry
from .channels.telegram import TelegramClient, poll_loop
from .config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("hermes")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    from .db.supabase import Supabase  # local import to keep import graph flat

    app.state.anthropic = AsyncAnthropic(api_key=settings.anthropic_api_key)
    app.state.supabase = Supabase()
    app.state.registry = SessionRegistry(settings.dev_default_elder_id)
    app.state.telegram = (
        TelegramClient(settings.telegram_bot_token)
        if settings.telegram_bot_token
        else None
    )
    poller_task: asyncio.Task | None = None

    if app.state.telegram is not None:
        mode = settings.hermes_channel_mode.lower()
        if mode == "polling":
            poller_task = asyncio.create_task(
                poll_loop(
                    anthropic=app.state.anthropic,
                    supabase=app.state.supabase,
                    registry=app.state.registry,
                    telegram=app.state.telegram,
                )
            )
            log.info("telegram: long-polling mode")
        elif mode == "webhook":
            if not settings.vps_url:
                log.warning("webhook mode but VPS_URL is empty; skipping setWebhook")
            else:
                url = settings.vps_url.rstrip("/") + "/telegram/webhook"
                await app.state.telegram.set_webhook(
                    url, secret_token=settings.telegram_webhook_secret or None
                )
                log.info("telegram: webhook registered at %s", url)
    else:
        log.info("telegram: disabled (no TELEGRAM_BOT_TOKEN)")

    try:
        yield
    finally:
        if poller_task is not None:
            poller_task.cancel()
        if app.state.telegram is not None:
            await app.state.telegram.aclose()
        await app.state.supabase.aclose()
        await app.state.anthropic.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Hermes", version="0.1.0", lifespan=lifespan)
    app.include_router(router)
    return app


app = create_app()


def serve() -> None:
    settings = get_settings()
    uvicorn.run(
        "hermes.main:app",
        host=settings.hermes_host,
        port=settings.hermes_port,
        log_level="info",
    )


if __name__ == "__main__":
    serve()
