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
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .agent import llm
from .api.routes import router
from .channels.scheduler import reminder_loop
from .channels.session import SessionRegistry
from .channels.telegram import TelegramClient, poll_loop
from .config import get_settings
from .ratelimit import SlidingWindowLimiter, http_tiers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("hermes")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    from .db.supabase import Supabase  # local import to keep import graph flat

    app.state.llm_client = llm.make_client(settings)
    configured = llm.provider(settings)
    effective = llm.effective_provider(settings)
    log.info("agent brain: %s (configured: %s)", effective, configured)
    if effective != configured:
        # A silent provider fallback (e.g. OPENAI_API_KEY empty -> Anthropic) can
        # masquerade as "OpenFDA is down" in replies. Make it impossible to miss.
        log.warning(
            "LLM BRAIN FALLBACK: configured=%s but running on %s because %s is not "
            "set. Add the key and restart to use the intended brain.",
            configured, effective, llm._KEY_ENV_NAME.get(configured, "the API key"),
        )
    if not llm.api_key_present(settings):
        log.warning("%s is not set — agent turns will fail", llm.api_key_env_name(settings))
    app.state.supabase = Supabase()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.registry = SessionRegistry(settings.dev_default_elder_id)
    # Persistent per-elder sessions for the HTTP /agent/turn contract, so a
    # multi-step flow (propose -> confirm a prescription) and conversation history
    # survive across requests just as they do on the Telegram/CLI channels.
    app.state.http_sessions = {}
    app.state.telegram = (
        TelegramClient(settings.telegram_bot_token)
        if settings.telegram_bot_token
        else None
    )
    poller_task: asyncio.Task | None = None
    reminder_task: asyncio.Task | None = None
    lid_task: asyncio.Task | None = None

    # Warm the local fastText language model in the background (best-effort) so the
    # first voice/text turn isn't blocked on the one-time model download + load.
    if settings.hf_lid_model:
        async def _warm_lid() -> None:
            try:
                from .channels.lang import _load_lid

                await asyncio.to_thread(_load_lid)
                log.info("fastText language model warmed")
            except Exception:
                log.warning("fastText warmup failed; language detection disabled", exc_info=True)

        lid_task = asyncio.create_task(_warm_lid())

    if app.state.telegram is not None:
        # Register the command menu (the ☰ button) so /schedule etc. are
        # discoverable without memorising commands. Best-effort: a Telegram
        # hiccup here must never stop the service.
        try:
            await app.state.telegram.set_my_commands(
                [
                    {"command": "schedule", "description": "Today's medicine plan"},
                    {"command": "today", "description": "Same as /schedule"},
                    {"command": "week", "description": "This week's medicines"},
                    {"command": "voice", "description": "Voice replies on or off"},
                    {"command": "setup", "description": "Set up or redo your profile"},
                    {"command": "help", "description": "What I can do"},
                ]
            )
        except Exception:
            log.warning("setMyCommands failed; command menu not registered", exc_info=True)
        mode = settings.hermes_channel_mode.lower()
        if mode == "polling":
            poller_task = asyncio.create_task(
                poll_loop(
                    anthropic=app.state.llm_client,
                    supabase=app.state.supabase,
                    registry=app.state.registry,
                    telegram=app.state.telegram,
                    rate_limiter=app.state.rate_limiter,
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

        # Reminder scheduler shares the live registry + Telegram client, so it
        # runs in-process (only meaningful when Telegram delivery is available).
        if settings.reminders_enabled:
            reminder_task = asyncio.create_task(
                reminder_loop(
                    supabase=app.state.supabase,
                    registry=app.state.registry,
                    telegram=app.state.telegram,
                )
            )
    else:
        log.info("telegram: disabled (no TELEGRAM_BOT_TOKEN)")

    try:
        yield
    finally:
        for task in (poller_task, reminder_task, lid_task):
            if task is not None:
                task.cancel()
        if app.state.telegram is not None:
            await app.state.telegram.aclose()
        await app.state.supabase.aclose()
        await llm.aclose(app.state.llm_client)
        from .slang import aclose as slang_aclose

        await slang_aclose()


# POST endpoints that get the coarse per-IP ceiling (the per-user turn caps live
# deeper, at the elder_id / chat_id boundary in routes.py / telegram.py).
_RATE_LIMITED_PATHS = {"/agent/turn", "/telegram/webhook"}


def create_app() -> FastAPI:
    app = FastAPI(title="Hermes", version="0.1.0", lifespan=lifespan)

    # The web app (apps/web) calls /agent/turn straight from the browser, so its
    # origin must pass CORS preflight. Telegram/CLI channels are unaffected.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Hermes-Api-Key"],
    )

    @app.middleware("http")
    async def _rate_limit_by_ip(request, call_next):
        settings = get_settings()
        limiter = getattr(request.app.state, "rate_limiter", None)
        if (
            settings.rate_limit_enabled
            and limiter is not None
            and request.method == "POST"
            and request.url.path in _RATE_LIMITED_PATHS
        ):
            ip = request.client.host if request.client else "unknown"
            allowed, retry_after = limiter.check(f"http:{ip}", http_tiers(settings))
            if not allowed:
                return JSONResponse(
                    {"detail": "rate limit exceeded"},
                    status_code=429,
                    headers={"Retry-After": str(int(retry_after) + 1)},
                )
        return await call_next(request)

    app.include_router(router)
    return app


app = create_app()


def serve() -> None:
    settings = get_settings()
    kwargs: dict = {
        "host": settings.hermes_host,
        "port": settings.hermes_port,
        "log_level": "info",
    }
    if settings.hermes_reload:
        # Watch the src/ tree; on any file change uvicorn restarts the worker,
        # which re-runs lifespan (and the Telegram poller). Pairs with a
        # laptop->host file sync for a no-commit, no-restart dev loop.
        src_dir = Path(__file__).resolve().parent.parent  # .../src/hermes -> .../src
        kwargs["reload"] = True
        kwargs["reload_dirs"] = [str(src_dir)]
    uvicorn.run("hermes.main:app", **kwargs)


if __name__ == "__main__":
    serve()
