"""Language mapping + input-language detection for the voice pipeline.

Ties together three things Hermes needs to talk to an elder in their own language:

* which STT engine + hint to use for a given dialect (Whisper for high-resource
  languages; MMS for low-resource topolects like Hokkien/Teochew);
* what language the elder is actually using this turn (fastText LID on the text);
* which MMS-TTS voice to speak the reply with.

The fastText model is loaded **locally** (downloaded once via ``huggingface_hub``;
it is not served by the HF Inference API) and imported lazily, so the dependency is
only needed when language detection is enabled. Everything degrades to ``None``.
"""

from __future__ import annotations

import logging

from ..config import get_settings

log = logging.getLogger("hermes.lang")

# profiles.dialect -> ISO 639-3 (used for MMS ASR target + MMS-TTS voice).
DIALECT_ISO: dict[str, str] = {
    "en": "eng", "ms": "zlm", "zh": "cmn",
    "cantonese": "yue", "hokkien": "nan", "teochew": "nan", "tamil": "tam",
}
# profiles.dialect -> Whisper language code (ISO 639-1-ish). Hokkien/Teochew have
# no reliable Whisper support, so they are absent -> routed to MMS instead.
WHISPER_LANG: dict[str, str] = {
    "en": "en", "ms": "ms", "zh": "zh", "cantonese": "yue", "tamil": "ta",
}
# Dialects Whisper handles poorly -> try the MMS low-resource model.
LOW_RESOURCE: set[str] = {"hokkien", "teochew"}
# ISO 639-3 codes we have an MMS-TTS voice for (facebook/mms-tts-<iso3>).
TTS_SUPPORTED: set[str] = {"eng", "cmn", "yue", "nan", "tam", "zlm"}
# Human-readable names for the reply-language prompt hint.
LANG_NAMES: dict[str, str] = {
    "eng": "English", "cmn": "Mandarin Chinese", "yue": "Cantonese",
    "nan": "Hokkien", "tam": "Tamil", "zlm": "Malay",
}


def stt_plan(dialect: str | None) -> tuple[str, str | None]:
    """(engine, hint) for transcribing this elder. engine is ``"mms"`` (hint = the
    ISO 639-3 target) for low-resource dialects, else ``"whisper"`` (hint = a Whisper
    language code, or ``None`` to autodetect)."""
    d = (dialect or "").lower()
    if d in LOW_RESOURCE:
        return "mms", DIALECT_ISO.get(d, "nan")
    return "whisper", WHISPER_LANG.get(d)


def tts_model_for(iso3: str | None, default: str | None) -> str | None:
    """The MMS-TTS model id for a language, or ``default`` when unsupported."""
    if iso3 and iso3 in TTS_SUPPORTED:
        return f"facebook/mms-tts-{iso3}"
    return default or None


def language_name(iso3: str | None) -> str | None:
    """A human-readable language name for the reply-language prompt hint."""
    return LANG_NAMES.get(iso3) if iso3 else None


_lid_model = None
_lid_unavailable = False


def _load_lid():
    """The fastText LID model, or None if disabled/unavailable (cached)."""
    global _lid_model, _lid_unavailable
    if _lid_model is not None or _lid_unavailable:
        return _lid_model
    settings = get_settings()
    if not settings.hf_lid_model:
        _lid_unavailable = True
        return None
    try:
        import fasttext
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(settings.hf_lid_model, "model.bin")
        _lid_model = fasttext.load_model(path)
    except Exception:
        log.warning("fastText LID model unavailable; skipping language detection", exc_info=True)
        _lid_unavailable = True
    return _lid_model


def detect_language(text: str | None) -> str | None:
    """Detect the ISO 639-3 language of ``text`` with fastText, or ``None``.

    fastText labels look like ``__label__eng_Latn``; we return the ``eng`` part.
    """
    cleaned = (text or "").strip().replace("\n", " ")
    if not cleaned:
        return None
    model = _load_lid()
    if model is None:
        return None
    try:
        labels, _probs = model.predict(cleaned, k=1)
    except Exception:
        return None
    if not labels:
        return None
    code = labels[0].replace("__label__", "").split("_")[0]
    return code or None
