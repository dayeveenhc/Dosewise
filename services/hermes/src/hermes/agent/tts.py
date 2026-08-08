"""Expressive spoken replies for the WEB client, over OpenAI's TTS models.

Separate from ``channels/voice.py`` on purpose: that module is Telegram's
HuggingFace path (MMS-TTS), which is a different provider, a different audio
format, and — the reason this exists at all — noticeably more robotic than what
a browser already does on its own. This one is the opposite trade: a real
neural voice with an ``instructions`` channel for delivery ("warm, unhurried,
expressive"), which the Web Speech API has no equivalent of at any price.

Fully optional. With no ``OPENAI_API_KEY`` (or an empty ``OPENAI_TTS_MODEL``)
``synthesize_reply`` returns ``None`` and the route answers 503, which is the
signal the web client falls back to ``speechSynthesis`` on. Never raises for a
provider failure — the caller must always be able to degrade to text/browser
voice rather than show an error.
"""

from __future__ import annotations

import logging

# TTS_CHAR_LIMIT/chunk_text are reused rather than re-derived: past that length
# the spoken version stops adding anything over the text already on screen, and
# an elder is not listening to a 40-second monologue from a chat bubble. Text
# past the limit is cut at a sentence boundary, never mid-word.
from ..channels.voice import TTS_CHAR_LIMIT, chunk_text
from ..config import get_settings

log = logging.getLogger("hermes.tts")

# The audio the route hands back. mp3 is the one format every browser's
# <audio>/Audio() can decode without a codec question.
AUDIO_FORMAT = "mp3"
AUDIO_MEDIA_TYPE = "audio/mpeg"


def available(settings=None) -> bool:
    """True when a neural voice can actually be served."""
    settings = settings or get_settings()
    return bool(settings.openai_api_key and settings.openai_tts_model)


def speakable(text: str) -> str:
    """The portion of ``text`` worth speaking: trimmed, and cut to the first
    whole sentences that fit inside TTS_CHAR_LIMIT. Pure — no I/O."""
    chunks = chunk_text(text or "", TTS_CHAR_LIMIT)
    return chunks[0] if chunks else ""


async def synthesize_reply(text: str, *, settings=None) -> bytes | None:
    """Speak ``text`` in Mei's voice, or None if TTS is unavailable/failed."""
    settings = settings or get_settings()
    if not available(settings):
        return None
    body = speakable(text)
    if not body:
        return None

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    try:
        # Non-streaming: the client plays the whole clip at once anyway, and a
        # single response keeps this route a plain bytes body the browser can
        # hand straight to Audio() with no MediaSource plumbing.
        resp = await client.audio.speech.create(
            model=settings.openai_tts_model,
            voice=settings.openai_tts_voice,
            input=body,
            instructions=settings.openai_tts_instructions,
            response_format=AUDIO_FORMAT,
        )
        audio = resp.read() if hasattr(resp, "read") else bytes(resp.content)
        return audio or None
    except Exception:
        # A provider hiccup must never surface as an error in the chat — the
        # client falls back to the browser voice on a non-200.
        log.warning("openai tts failed", exc_info=True)
        return None
