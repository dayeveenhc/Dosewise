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

from ..agent.loop import (
    hydrate_medical_profile,
    persist_exchange,
    record_exchange,
    run_agent_turn,
)
from ..config import get_settings
from ..db.supabase import Supabase
from ..ratelimit import turn_tiers
from ..tools import ToolContext, get_handler
from .format import strip_markdown
from .lang import DIALECT_ISO, detect_language, language_name, stt_plan, tts_model_for
from .pdf import extract_pdf_text
from .session import SEED_ELDERS, SessionRegistry
from .voice import MAX_TTS_CHUNKS, chunk_text, synthesize, transcribe

log = logging.getLogger("hermes.telegram")

_HELP = (
    "Hi, I'm Dosewise — your medication helper. Just talk to me: ask about your "
    "medicines, tell me when you've taken one, or send a photo of a prescription.\n"
    "Commands: /schedule or /today (today's plan), /week (this week), "
    "/voice on|off (spoken replies), /setup (set up or redo your profile), /help.\n"
    "For testing: /whoami, /switch a|b."
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


async def _within_rate_limit(rate_limiter, chat_id: int, telegram: TelegramClient) -> bool:
    """Per-user cap on expensive agent turns, keyed by Telegram chat_id. On deny,
    send a gentle slow-down message and return False so the caller skips the turn.
    A ``None`` limiter (e.g. offline tests) means no limiting."""
    settings = get_settings()
    if not settings.rate_limit_enabled or rate_limiter is None:
        return True
    allowed, retry_after = rate_limiter.check(f"turn:{chat_id}", turn_tiers(settings))
    if allowed:
        return True
    wait = int(retry_after) + 1
    await telegram.send_message(
        chat_id,
        f"You're sending messages very quickly. Please wait about {wait} "
        "seconds and try again. 🙏",
    )
    return False


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

    async def set_my_commands(self, commands: list[dict]) -> dict:
        """Register the bot's command menu (the ☰ button next to the input field)."""
        return await self._call("setMyCommands", commands=commands)

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
    # Speak the reply when the elder spoke this turn OR opted into voice replies
    # (/voice on, profile tts:true). Long replies go out in sentence chunks. Text
    # always lands first; if voice was expected but nothing could be spoken, say so
    # instead of failing silently.
    if reply and (spoke or getattr(state, "voice_default", False)):
        sent_any = False
        try:
            model = tts_model_for(lang_iso, get_settings().hf_tts_model)
            for chunk in chunk_text(reply)[:MAX_TTS_CHUNKS]:
                audio = await synthesize(chunk, model=model)
                if audio is None:
                    break
                await telegram.send_audio(chat_id, audio)
                sent_any = True
        except Exception:
            log.warning("failed to send voice reply", exc_info=True)
        if not sent_any:
            try:
                await telegram.send_message(
                    chat_id,
                    "🔇 I couldn't send a voice reply this time — everything is in "
                    "the text above.",
                )
            except Exception:
                log.warning("failed to send TTS-failure notice", exc_info=True)


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


def _pending_commit_call(state) -> tuple[str, dict] | None:
    """Map the session's pending proposal to the (tool_name, kwargs) that commits
    it — the deterministic ✅-tap path, no LLM round-trip. Only the tool's declared
    args are passed (e.g. the stashed prescription photo is NOT a parameter; the
    commit path reads it from the matched proposal itself). Priority order matches
    how unlikely a clash is: prescription, then reminder, then profile."""
    p = getattr(state, "pending_proposal", None)
    if p:
        return "add_prescription", {
            "name": p.get("name"), "dosage": p.get("dosage"), "purpose": p.get("purpose"),
            "instructions": p.get("instructions"), "times": p.get("times"),
            "confirmed": True,
        }
    p = getattr(state, "pending_reminder", None)
    if p:
        return "set_medication_reminder", {
            "name": p.get("name"), "times": p.get("times"), "days": p.get("days"),
            "confirmed": True,
        }
    p = getattr(state, "pending_profile", None)
    if p:
        return "update_medical_profile", {
            "content": p.get("content"), "replace": bool(p.get("replace")),
            "confirmed": True,
        }
    return None


def _clear_pending(state) -> None:
    """Drop every pending proposal (and any held photo) — the elder said no, or a
    commit failed and must be re-proposed rather than half-retried."""
    state.pending_proposal = None
    state.pending_reminder = None
    state.pending_profile = None
    state.pending_image = None
    state.awaiting_confirmation = False


async def _handle_callback(
    callback: dict,
    *,
    anthropic: AsyncAnthropic,
    supabase: Supabase,
    registry: SessionRegistry,
    telegram: TelegramClient,
    rate_limiter=None,
) -> None:
    """Handle a tapped inline button (Telegram ``callback_query``).

    Two families of buttons:
    * ``confirm:yes|no`` — a confirmation of a pending proposal. When the proposal
      is still on the session, the tap commits (or discards) it deterministically —
      no LLM round-trip, so a ✅ always saves exactly what was read back. Only when
      the pending state is gone (e.g. the process restarted) does the tap fall back
      to a normal agent turn with the plain text "yes"/"no".
    * ``dose:taken|later:<med_id>`` — a daily-reminder response. "Taken" logs the
      dose deterministically (no LLM turn); "Later" just acknowledges.

    Telegram honors one answerCallbackQuery per tap, so each path acks exactly once
    — before its real work, so the client spinner never hangs on a slow turn.
    """
    cq_id = callback.get("id")
    message = callback.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    data = callback.get("data") or ""
    if chat_id is None:
        if cq_id is not None:
            await telegram.answer_callback_query(cq_id)
        return
    state = registry.get(chat_id)

    if data in ("confirm:yes", "confirm:no"):
        answer = "yes" if data == "confirm:yes" else "no"
        lang_iso = state.last_lang_iso or DIALECT_ISO.get((state.dialect or "").lower())
        ctx = ToolContext(
            supabase=supabase, elder_id=state.elder_id, session=state, telegram=telegram
        )

        call = _pending_commit_call(state)
        if call is not None:
            # Deterministic path — a cheap direct commit/discard, so it is exempt
            # from the per-user cap (same rationale as dose:taken below).
            if cq_id is not None:
                await telegram.answer_callback_query(cq_id)
            tools_used: list[str] = []
            if data == "confirm:no":
                _clear_pending(state)
                reply = "Okay, I won't save that. Tell me what you'd like to change."
            else:
                tool_name, kwargs = call
                try:
                    reply = await get_handler(tool_name)(ctx, **kwargs)
                    tools_used = [tool_name]
                except Exception:
                    log.exception("deterministic confirm failed (%s)", tool_name)
                    _clear_pending(state)
                    reply = (
                        "I couldn't save that just now. Please tell me again in a "
                        "message and I'll re-check it."
                    )
            # Keep the model's view of the conversation coherent: it never saw
            # this turn, so record the tap and the outcome in history + memory.
            state.messages = record_exchange(state.messages, answer, reply)
            await persist_exchange(ctx, answer, reply, tools_used)
            await _deliver_reply(telegram, chat_id, state, reply, spoke=False, lang_iso=lang_iso)
            return

        # Fallback (pending lost — e.g. process restart): re-enter the LLM turn, so
        # it's subject to the per-user cap. A denied tap must still get feedback:
        # ack with a visible toast (plus _within_rate_limit's chat message).
        if not await _within_rate_limit(rate_limiter, chat_id, telegram):
            if cq_id is not None:
                await telegram.answer_callback_query(
                    cq_id, text="One moment — please try again shortly."
                )
            return
        if cq_id is not None:
            await telegram.answer_callback_query(cq_id)
        await telegram.send_chat_action(chat_id)
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

    if cq_id is not None:
        await telegram.answer_callback_query(cq_id)

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
    rate_limiter=None,
) -> None:
    # A tapped inline button arrives as ``callback_query`` (no top-level message).
    callback = update.get("callback_query")
    if callback:
        await _handle_callback(
            callback, anthropic=anthropic, supabase=supabase,
            registry=registry, telegram=telegram, rate_limiter=rate_limiter,
        )
        return
    message = update.get("message") or update.get("edited_message")
    if not message:
        return
    chat_id = message["chat"]["id"]
    text = (message.get("text") or message.get("caption") or "").strip()

    # Commands.
    if text.startswith("/help"):
        await telegram.send_message(chat_id, _HELP)
        return
    if text.startswith("/start") or text.startswith("/setup"):
        # First-time setup: /start opens the guided intake only when no medical
        # profile is saved yet; /setup opens it unconditionally (redo/update).
        state = registry.get(chat_id)
        ctx = ToolContext(
            supabase=supabase, elder_id=state.elder_id, session=state, telegram=telegram
        )
        if text.startswith("/setup"):
            state.intake_active = True
            kickoff = (
                "[The patient asked to set up or redo their medical profile. Begin "
                "the setup questions.]"
            )
        else:
            await telegram.send_message(chat_id, _HELP)
            profile = await hydrate_medical_profile(ctx)
            if profile is not None:
                return  # already set up — the help text is enough
            kickoff = (
                "[The patient has just started the bot for the first time. Greet "
                "them warmly and begin the setup questions.]"
            )
        if not await _within_rate_limit(rate_limiter, chat_id, telegram):
            return
        lang_iso = state.last_lang_iso or DIALECT_ISO.get((state.dialect or "").lower())
        await telegram.send_chat_action(chat_id)
        try:
            reply, _tools, state.messages = await run_agent_turn(
                anthropic, ctx, kickoff, history=state.messages,
                reply_language=language_name(lang_iso),
            )
        except Exception:
            log.exception("agent turn failed (setup)")
            await telegram.send_message(
                chat_id, "Sorry, something went wrong. Let me get a person to help."
            )
            return
        await _deliver_reply(telegram, chat_id, state, reply, spoke=False, lang_iso=lang_iso)
        return
    if text.startswith("/whoami"):
        state = registry.get(chat_id)
        await telegram.send_message(chat_id, f"Acting as elder: {state.elder_id}")
        return
    if text.startswith("/voice"):
        state = registry.get(chat_id)
        arg = text.split(maxsplit=1)[1].strip().lower() if " " in text else ""
        if arg not in ("on", "off"):
            await telegram.send_message(
                chat_id, "Say /voice on for spoken replies, or /voice off for text only."
            )
            return
        on = arg == "on"
        # Persist to profiles.accessibility.tts (read-merge-write so the medical
        # profile and other keys survive). Best-effort: the session flag flips
        # regardless, so the change takes effect immediately either way.
        try:
            db = supabase.user_client(state.elder_id)
            rows = await db.select(
                "profiles", columns="accessibility",
                filters={"id": f"eq.{state.elder_id}"}, limit=1,
            )
            access = dict((rows[0].get("accessibility") if rows else None) or {})
            access["tts"] = on
            await db.update(
                "profiles", {"accessibility": access},
                filters={"id": f"eq.{state.elder_id}"}, returning=False,
            )
        except Exception:
            log.warning("failed to persist voice preference", exc_info=True)
        state.voice_default = on
        state.voice_loaded = True
        await telegram.send_message(
            chat_id,
            "🔊 Voice replies are on. I'll speak every reply. Say /voice off to stop."
            if on
            else "🔇 Voice replies are off. I'll still speak back when you send me a "
            "voice message. Say /voice on to change.",
        )
        return
    if text.startswith(("/schedule", "/today", "/week")):
        state = registry.get(chat_id)
        view = "week" if (text.startswith("/week") or "week" in text.lower()) else "today"
        try:
            await _send_schedule(chat_id, state, supabase, telegram, view)
        except Exception:
            log.exception("failed to render schedule")
            await telegram.send_message(chat_id, "I couldn't load your schedule just now.")
        return
    if text.startswith("/switch"):
        # Impersonating a seed elder is a dev-only affordance; strict prod disables it.
        if get_settings().hermes_strict_auth:
            await telegram.send_message(chat_id, "Switching identities is disabled here.")
            return
        code = text.split(maxsplit=1)[1].strip().lower() if " " in text else ""
        if code in SEED_ELDERS:
            registry.switch(chat_id, SEED_ELDERS[code])
            await telegram.send_message(chat_id, f"Now acting as elder {code.upper()}.")
        else:
            await telegram.send_message(chat_id, "Usage: /switch a  (or b)")
        return

    # Everything past here funnels into an agent turn (after optional STT/PDF/vision
    # work), so apply the per-user cap now — before any expensive download/inference.
    if not await _within_rate_limit(rate_limiter, chat_id, telegram):
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

    # Detect the language the elder is using now (fastText). Short/low-confidence
    # texts return None — then the last confident detection keeps the conversation
    # language steady, and the stored dialect is the final fallback. This drives
    # both the reply language and the TTS voice.
    detected = detect_language(text)
    if detected:
        state.last_lang_iso = detected
    lang_iso = detected or state.last_lang_iso or DIALECT_ISO.get((state.dialect or "").lower())
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
    rate_limiter=None,
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
                    rate_limiter=rate_limiter,
                )
            except Exception:
                log.exception("failed to handle update %s", update.get("update_id"))
