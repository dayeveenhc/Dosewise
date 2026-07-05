"""Telegram Bot API client + update dispatch.

Supports both delivery modes on one code path:
* long-polling (``poll_loop``) for local dev — no public URL needed, works against
  a local Supabase;
* webhook (``handle_update`` called from the FastAPI route) for the VPS.

Both funnel every message through the same ``run_agent_turn`` core.
"""

from __future__ import annotations

import logging
from zoneinfo import ZoneInfo

import httpx
from anthropic import AsyncAnthropic

from ..agent.loop import run_agent_turn
from ..config import get_settings
from ..db.supabase import Supabase
from ..tools import ToolContext, get_handler
from .format import strip_markdown
from .lang import DIALECT_ISO, detect_language, language_name, stt_plan, tts_model_for
from .pdf import extract_pdf_text
from .session import SEED_ELDERS, SessionRegistry
from .voice import synthesize, transcribe

log = logging.getLogger("hermes.telegram")

_HELP = (
    "Hi, I'm Dosewise — your medication helper. Just talk to me: ask about your "
    "medicines, tell me when you've taken one, or send a photo of a prescription.\n"
    "Commands: /schedule (today's plan), /whoami, /switch a|b (test identities)."
)

# Yes/No tap-keyboard attached when the agent is awaiting a confirmation, so an
# elder can tap instead of typing. The callback comes back as ``confirm:yes|no``.
_CONFIRM_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "✅ Yes", "callback_data": "confirm:yes"},
            {"text": "✖️ No", "callback_data": "confirm:no"},
        ]
    ]
}


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

    async def send_message(
        self, chat_id: int, text: str, reply_markup: dict | None = None
    ) -> None:
        params: dict = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:  # Telegram rejects a null reply_markup.
            params["reply_markup"] = reply_markup
        await self._call("sendMessage", **params)

    async def answer_callback_query(
        self, callback_query_id: str, text: str | None = None
    ) -> None:
        """Acknowledge a tapped inline button so Telegram stops the client spinner.
        Best-effort — a failure here must never block the actual reply."""
        try:
            params: dict = {"callback_query_id": callback_query_id}
            if text:
                params["text"] = text
            await self._call("answerCallbackQuery", **params)
        except Exception:
            pass

    async def send_audio(
        self, chat_id: int, audio: bytes, *, filename: str = "reply.wav", mime: str = "audio/wav"
    ) -> None:
        # sendAudio (multipart) tolerates WAV/MP3 from MMS-TTS, unlike sendVoice
        # which demands OGG/Opus. Text is always sent too, so this is additive.
        resp = await self._http.post(
            f"{self._base}/sendAudio",
            data={"chat_id": str(chat_id)},
            files={"audio": (filename, audio, mime)},
        )
        resp.raise_for_status()

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


async def _deliver_reply(
    telegram: TelegramClient,
    chat_id: int,
    state,
    reply: str,
    *,
    spoke: bool,
    lang_iso: str | None,
) -> None:
    """Send the agent's reply out: text (with a Yes/No tap-keyboard when the agent
    is awaiting a confirmation), then the same reply as audio in the elder's
    language when they spoke or have voice-by-default on. Shared by the
    typed-message and button-tap paths."""
    reply = strip_markdown(reply)
    markup = _CONFIRM_KEYBOARD if getattr(state, "awaiting_confirmation", False) else None
    await telegram.send_message(chat_id, reply or "…", reply_markup=markup)
    # Speak the reply when the elder spoke OR when voice is their default (low
    # digital literacy). Text always lands first, so a TTS failure is silent.
    if reply and (spoke or getattr(state, "voice_default", False)):
        try:
            model = tts_model_for(lang_iso, get_settings().hf_tts_model)
            audio = await synthesize(reply, model=model)
            if audio:
                await telegram.send_audio(chat_id, audio)
        except Exception:
            log.warning("failed to send voice reply", exc_info=True)


async def _send_schedule(
    chat_id: int, state, supabase: Supabase, telegram: TelegramClient, view: str
) -> None:
    """Render the medication timeline and, for the day view, attach ✅ Taken buttons
    for each medicine due today (reusing the existing dose:taken callback)."""
    from datetime import UTC, datetime

    from ..dosing import scheduled_today
    from ..tools import ToolContext, get_handler

    ctx = ToolContext(supabase=supabase, elder_id=state.elder_id, session=state, telegram=telegram)
    text = await get_handler("show_schedule")(ctx, view=view)

    reply_markup = None
    if view != "week":
        settings = get_settings()
        local_today = datetime.now(UTC).astimezone(ZoneInfo(settings.hermes_tz)).date()
        meds = await ctx.db().select(
            "medications", columns="id,name,schedule", filters={"archived": "eq.false"}
        )
        buttons = [
            [{"text": f"✅ Took {m['name']}", "callback_data": f"dose:taken:{m['id']}"}]
            for m in meds
            if scheduled_today(m.get("schedule") or {}, local_today)
        ][:8]  # keep the keyboard manageable
        if buttons:
            reply_markup = {"inline_keyboard": buttons}
            text += "\n\nTap ✅ when you've taken one. To change a time, just tell me."
    await telegram.send_message(chat_id, strip_markdown(text), reply_markup=reply_markup)


async def _handle_callback(
    callback: dict,
    *,
    anthropic: AsyncAnthropic,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram: TelegramClient,
) -> None:
    """Handle a tapped inline button (Telegram ``callback_query``).

    Two families of buttons:
    * ``confirm:yes|no`` — a generic confirmation. We translate the tap into the
      plain text the agent already understands ("yes"/"no") and re-enter the
      normal turn, so the existing propose→confirm tool guards handle it unchanged.
    * ``dose:taken|later:<med_id>`` — a daily-reminder response. "Taken" logs the
      dose deterministically (no LLM turn); "Later" just acknowledges.
    """
    cq_id = callback.get("id")
    message = callback.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    data = callback.get("data") or ""
    if cq_id is not None:
        await telegram.answer_callback_query(cq_id)
    if chat_id is None:
        return
    state = registry.get(chat_id)

    if data in ("confirm:yes", "confirm:no"):
        answer = "yes" if data == "confirm:yes" else "no"
        lang_iso = DIALECT_ISO.get((state.dialect or "").lower())
        await telegram.send_chat_action(chat_id)
        ctx = ToolContext(
            supabase=supabase, elder_id=state.elder_id, session=state, telegram=telegram
        )
        try:
            reply, _tools, state.messages = await run_agent_turn(
                anthropic, ctx, answer, history=state.messages,
                reply_language=language_name(lang_iso),
            )
        except Exception:
            log.exception("agent turn failed (callback)")
            await telegram.send_message(
                chat_id, "Sorry, something went wrong. Let me get a person to help."
            )
            return
        await _deliver_reply(telegram, chat_id, state, reply, spoke=False, lang_iso=lang_iso)
        return

    if data.startswith("dose:"):
        _, _, rest = data.partition(":")
        action, _, med_id = rest.partition(":")
        if action == "later":
            await telegram.send_message(
                chat_id, "Okay, no rush. Tap ✅ Taken once you've taken it. 🕗"
            )
            return
        if action == "taken" and med_id:
            ctx = ToolContext(
                supabase=supabase, elder_id=state.elder_id, session=state, telegram=telegram
            )
            try:
                meds = await ctx.db().select(
                    "medications", columns="name",
                    filters={"id": f"eq.{med_id}"}, limit=1,
                )
                name = meds[0]["name"] if meds else None
                if name:
                    await get_handler("log_dose")(ctx, medication_name=name)
                    await telegram.send_message(
                        chat_id, f"✅ I've logged your {name} as taken. Well done."
                    )
                else:
                    await telegram.send_message(chat_id, "✅ Logged as taken.")
            except Exception:
                log.exception("dose callback failed")
                await telegram.send_message(
                    chat_id, "I couldn't log that just now. Please tell me in a message."
                )
            return
    # Unknown callback data — the spinner is already stopped; nothing else to do.


async def handle_update(
    update: dict,
    *,
    anthropic: AsyncAnthropic,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram: TelegramClient,
) -> None:
    # A tapped inline button arrives as ``callback_query`` (no top-level message).
    callback = update.get("callback_query")
    if callback:
        await _handle_callback(
            callback, anthropic=anthropic, supabase=supabase,
            registry=registry, telegram=telegram,
        )
        return
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
    if text.startswith("/schedule") or text.startswith("/today"):
        state = registry.get(chat_id)
        view = "week" if "week" in text.lower() else "today"
        try:
            await _send_schedule(chat_id, state, supabase, telegram, view)
        except Exception:
            log.exception("failed to render schedule")
            await telegram.send_message(chat_id, "I couldn't load your schedule just now.")
        return
    if text.startswith("/switch"):
        code = text.split(maxsplit=1)[1].strip().lower() if " " in text else ""
        if code in SEED_ELDERS:
            registry.switch(chat_id, SEED_ELDERS[code])
            await telegram.send_message(chat_id, f"Now acting as elder {code.upper()}.")
        else:
            await telegram.send_message(chat_id, "Usage: /switch a  (or b)")
        return

    state = registry.get(chat_id)

    # Photo — or an image sent "as a file" (Telegram delivers it as a document with
    # an image/* mime, common when preserving full resolution). Hold the bytes on the
    # session so add_prescription can persist them once the elder confirms the scan.
    image_bytes = None
    file_id = None
    if message.get("photo"):
        file_id = message["photo"][-1]["file_id"]
    else:
        doc = message.get("document")
        if doc and str(doc.get("mime_type") or "").startswith("image/"):
            file_id = doc["file_id"]
    if file_id is not None:
        try:
            image_bytes = await telegram.download_file(file_id)
            state.pending_image = image_bytes
        except Exception:
            log.warning("failed to download telegram image", exc_info=True)
            state.pending_image = None  # never let a stale image linger
        if not text:
            text = "Here is a photo of my prescription."

    # PDF document (prescription list / medical history). Extract the text and hand
    # it to the turn as context; the agent may offer to save key facts to the medical
    # profile (update_medical_profile). Scanned/image PDFs extract nothing — ask for
    # a photo instead so the vision path can read it.
    doc = message.get("document")
    if doc and str(doc.get("mime_type") or "") == "application/pdf":
        try:
            pdf_bytes = await telegram.download_file(doc["file_id"])
            pdf_text = extract_pdf_text(pdf_bytes)
        except Exception:
            log.warning("failed to download/extract telegram PDF", exc_info=True)
            pdf_text = ""
        if pdf_text:
            caption = text or "Here is my document."
            text = (
                f"{caption}\n\n[Attached PDF contents]\n{pdf_text}\n[End of PDF]"
            )
        else:
            await telegram.send_message(
                chat_id,
                "I couldn't read that PDF (it may be a scan). Could you send a clear "
                "photo of the page instead?",
            )
            return

    # Voice note? Route STT by the elder's dialect (Whisper for high-resource langs,
    # MMS for Hokkien/Teochew), transcribe, and treat the transcript as the text.
    voice = message.get("voice") or message.get("audio")
    spoke = False  # the elder spoke -> speak the reply back too.
    if voice and not text:
        engine, hint = stt_plan(state.dialect)
        try:
            audio_bytes = await telegram.download_file(voice["file_id"])
            transcript = await transcribe(
                audio_bytes,
                content_type=voice.get("mime_type") or "audio/ogg",
                engine=engine,
                language=hint,
            )
        except Exception:
            log.warning("failed to download/transcribe telegram voice", exc_info=True)
            transcript = None
        if transcript:
            text = transcript
            spoke = True
        elif image_bytes is None:
            await telegram.send_message(
                chat_id,
                "I couldn't hear that clearly. Could you type it, or send it again?",
            )
            return

    if not text and image_bytes is None:
        return

    # Detect the language the elder is using now (fastText); fall back to their
    # stored dialect. This drives both the reply language and the TTS voice.
    lang_iso = detect_language(text) or DIALECT_ISO.get((state.dialect or "").lower())
    reply_language = language_name(lang_iso)

    await telegram.send_chat_action(chat_id)
    ctx = ToolContext(
        supabase=supabase,
        elder_id=state.elder_id,
        session=state,
        telegram=telegram,
    )
    try:
        reply, _tools, state.messages = await run_agent_turn(
            anthropic, ctx, text, image_bytes=image_bytes, history=state.messages,
            reply_language=reply_language,
        )
    except Exception:
        log.exception("agent turn failed")
        await telegram.send_message(
            chat_id, "Sorry, something went wrong. Let me get a person to help."
        )
        return
    # Send the reply (with a Yes/No tap-keyboard if the agent is awaiting a
    # confirmation) and, if the elder spoke, the same reply back as audio.
    await _deliver_reply(telegram, chat_id, state, reply, spoke=spoke, lang_iso=lang_iso)


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
