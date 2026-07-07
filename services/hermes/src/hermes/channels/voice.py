"""Voice for Telegram over the HuggingFace Inference API — speech-to-text and,
optionally, text-to-speech.

Telegram voice messages are OGG/Opus. ``transcribe`` POSTs the raw bytes to a
hosted Whisper model and returns the transcript; ``synthesize`` POSTs reply text
to a hosted TTS model and returns audio bytes. Both are stretch features and fully
optional: with no ``HUGGINGFACE_API_KEY`` (or, for TTS, no ``HF_TTS_MODEL``) they
return ``None`` and the caller falls back to text.
"""

from __future__ import annotations

import base64
import logging

import httpx

from ..config import get_settings

log = logging.getLogger("hermes.voice")

_HF_BASE = "https://api-inference.huggingface.co/models"

# HF TTS degrades badly past ~1000 chars, so long replies are spoken in sentence
# chunks. Capped: past 3 clips the spoken version stops adding value over the text.
TTS_CHAR_LIMIT = 1000
MAX_TTS_CHUNKS = 3

_SENTENCE_ENDS = ".!?。！？\n"


def chunk_text(text: str, limit: int = TTS_CHAR_LIMIT) -> list[str]:
    """Split ``text`` into <=limit chunks on sentence boundaries for TTS.

    A single sentence longer than ``limit`` is hard-split. Pure — no I/O."""
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]

    # Split into sentences (keeping their end punctuation), then pack greedily.
    sentences: list[str] = []
    start = 0
    for i, ch in enumerate(text):
        if ch in _SENTENCE_ENDS:
            piece = text[start : i + 1].strip()
            if piece:
                sentences.append(piece)
            start = i + 1
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)

    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        while len(sentence) > limit:  # one overlong sentence: hard-split
            if current:
                chunks.append(current)
                current = ""
            chunks.append(sentence[:limit])
            sentence = sentence[limit:].strip()
        if not sentence:
            continue
        if current and len(current) + 1 + len(sentence) > limit:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks


def _extract_text(data) -> str | None:
    """Whisper returns {"text": "..."}; some models return a list of chunks."""
    if isinstance(data, dict):
        text = data.get("text")
    elif isinstance(data, list) and data:
        text = data[0].get("text") if isinstance(data[0], dict) else None
    else:
        text = None
    text = (text or "").strip()
    return text or None


async def _hf_stt(
    model: str, audio_bytes: bytes, content_type: str, language: str | None, settings
) -> str | None:
    """One HF Inference STT call. With a language hint, use the JSON+parameters form
    (base64 audio); otherwise POST raw bytes for autodetect. Returns None on error."""
    url = f"{_HF_BASE}/{model}"
    headers = {"Authorization": f"Bearer {settings.huggingface_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=60.0) as http:
            if language:
                payload = {
                    "inputs": base64.b64encode(audio_bytes).decode(),
                    "parameters": {"language": language, "task": "transcribe"},
                }
                resp = await http.post(url, headers=headers, json=payload)
            else:
                resp = await http.post(
                    url, headers={**headers, "Content-Type": content_type}, content=audio_bytes
                )
        if resp.status_code >= 300:
            log.warning("HF STT %s failed: %s %s", model, resp.status_code, resp.text[:200])
            return None
        return _extract_text(resp.json())
    except Exception:
        log.warning("HF STT request errored (%s)", model, exc_info=True)
        return None


async def transcribe(
    audio_bytes: bytes,
    *,
    content_type: str = "audio/ogg",
    engine: str = "whisper",
    language: str | None = None,
) -> str | None:
    """Transcribe an audio clip, or None if STT is unavailable.

    ``engine="mms"`` routes to the low-resource model (for Hokkien/Teochew) and
    **falls back to Whisper autodetect** on failure; ``engine="whisper"`` uses the
    multilingual model with an optional ``language`` hint (retrying without the hint
    if the hinted request fails).
    """
    settings = get_settings()
    if not settings.huggingface_api_key:
        return None

    if engine == "mms" and settings.hf_stt_lowresource_model:
        text = await _hf_stt(
            settings.hf_stt_lowresource_model, audio_bytes, content_type, language, settings
        )
        if text:
            return text
        return await _hf_stt(settings.hf_stt_model, audio_bytes, content_type, None, settings)

    text = await _hf_stt(settings.hf_stt_model, audio_bytes, content_type, language, settings)
    if text is None and language is not None:
        text = await _hf_stt(settings.hf_stt_model, audio_bytes, content_type, None, settings)
    return text


async def synthesize(text: str, *, model: str | None = None) -> bytes | None:
    """Return spoken audio for ``text``, or None if TTS is unavailable/failed.

    ``model`` selects a per-language MMS-TTS voice (facebook/mms-tts-<iso3>); when
    omitted it falls back to the configured ``hf_tts_model``.
    """
    settings = get_settings()
    model = model or settings.hf_tts_model
    if not settings.huggingface_api_key or not model or not text.strip():
        return None
    url = f"{_HF_BASE}/{model}"
    headers = {"Authorization": f"Bearer {settings.huggingface_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=60.0) as http:
            resp = await http.post(url, headers=headers, json={"inputs": text[:1000]})
        if resp.status_code >= 300:
            log.warning("HF TTS failed: %s %s", resp.status_code, resp.text[:200])
            return None
        return resp.content or None
    except Exception:
        log.warning("HF TTS request errored", exc_info=True)
        return None
