"""Telegram Bot API client + update dispatch.

Supports both delivery modes on one code path:
* long-polling (``poll_loop``) for local dev — no public URL needed, works against
  a local Supabase;
* webhook (``handle_update`` called from the FastAPI route) for the VPS.

Both funnel every message through the same ``run_agent_turn`` core.
"""

from __future__ import annotations

import logging

import httpx

from anthropic import AsyncAnthropic

from ..agent.loop import run_agent_turn
from ..db.supabase import Supabase
from ..tools import ToolContext
from .session import SEED_ELDERS, SessionRegistry

log = logging.getLogger("hermes.telegram")

_HELP = (
    "I'm Hermes, your medication helper. Just talk to me — ask about your "
    "medicines, tell me when you've taken one, or send a photo of a prescription.\n"
    "Commands: /whoami, /switch a|b (test identities)."
)


class TelegramClient:
    def __init__(self, token: str) -> None:
        self._base = f"https://api.telegram.org/bot{token}"
        self._file_base = f"https://api.telegram.org/file/bot{token}"
        self._http = httpx.AsyncClient(timeout=65.0)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, **params) -> dict:
        resp = await self._http.post(f"{self._base}/{method}", json=params)
        resp.raise_for_status()
        return resp.json()

    async def send_message(self, chat_id: int, text: str) -> None:
        await self._call("sendMessage", chat_id=chat_id, text=text)

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None:
        try:
            await self._call("sendChatAction", chat_id=chat_id, action=action)
        except Exception:
            pass

    async def get_updates(self, offset: int | None, timeout: int = 50) -> list[dict]:
        result = await self._call("getUpdates", offset=offset, timeout=timeout)
        return result.get("result", [])

    async def set_webhook(self, url: str, secret_token: str | None = None) -> dict:
        params: dict = {"url": url}
        if secret_token:
            params["secret_token"] = secret_token
        return await self._call("setWebhook", **params)

    async def download_file(self, file_id: str) -> bytes:
        info = await self._call("getFile", file_id=file_id)
        file_path = info["result"]["file_path"]
        resp = await self._http.get(f"{self._file_base}/{file_path}")
        resp.raise_for_status()
        return resp.content


async def handle_update(
    update: dict,
    *,
    anthropic: AsyncAnthropic,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram: TelegramClient,
) -> None:
    message = update.get("message") or update.get("edited_message")
    if not message:
        return
    chat_id = message["chat"]["id"]
    text = (message.get("text") or message.get("caption") or "").strip()

    # Commands.
    if text.startswith("/start") or text.startswith("/help"):
        await telegram.send_message(chat_id, _HELP)
        return
    if text.startswith("/whoami"):
        state = registry.get(chat_id)
        await telegram.send_message(chat_id, f"Acting as elder: {state.elder_id}")
        return
    if text.startswith("/switch"):
        code = text.split(maxsplit=1)[1].strip().lower() if " " in text else ""
        if code in SEED_ELDERS:
            registry.switch(chat_id, SEED_ELDERS[code])
            await telegram.send_message(chat_id, f"Now acting as elder {code.upper()}.")
        else:
            await telegram.send_message(chat_id, "Usage: /switch a  (or b)")
        return

    # Photo (prescription scan)?
    image_bytes = None
    if message.get("photo"):
        largest = message["photo"][-1]
        try:
            image_bytes = await telegram.download_file(largest["file_id"])
        except Exception:
            log.warning("failed to download telegram photo", exc_info=True)
        if not text:
            text = "Here is a photo of my prescription."

    if not text and image_bytes is None:
        return

    await telegram.send_chat_action(chat_id)
    state = registry.get(chat_id)
    ctx = ToolContext(
        supabase=supabase,
        elder_id=state.elder_id,
        session=state,
        telegram=telegram,
    )
    try:
        reply, _tools, state.messages = await run_agent_turn(
            anthropic, ctx, text, image_bytes=image_bytes, history=state.messages
        )
    except Exception:
        log.exception("agent turn failed")
        await telegram.send_message(
            chat_id, "Sorry, something went wrong. Let me get a person to help."
        )
        return
    await telegram.send_message(chat_id, reply or "…")


async def poll_loop(
    *,
    anthropic: AsyncAnthropic,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram: TelegramClient,
) -> None:
    log.info("telegram long-poll loop started")
    offset: int | None = None
    while True:
        try:
            updates = await telegram.get_updates(offset)
        except Exception:
            log.warning("getUpdates failed; retrying", exc_info=True)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            try:
                await handle_update(
                    update,
                    anthropic=anthropic,
                    supabase=supabase,
                    registry=registry,
                    telegram=telegram,
                )
            except Exception:
                log.exception("failed to handle update %s", update.get("update_id"))
