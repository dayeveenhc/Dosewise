"""Tests for HuggingFace STT (channels/voice.py)."""

from __future__ import annotations

import hermes.channels.voice as voice
from hermes.config import get_settings


async def test_transcribe_returns_none_without_key(monkeypatch):
    # With no HUGGINGFACE_API_KEY, STT is unavailable and returns a graceful None.
    monkeypatch.setattr(get_settings(), "huggingface_api_key", "", raising=False)
    assert await voice.transcribe(b"audio") is None


async def test_transcribe_parses_whisper_text(monkeypatch):
    monkeypatch.setattr(
        get_settings(), "huggingface_api_key", "hf_test", raising=False
    )

    class _Resp:
        status_code = 200

        def json(self):
            return {"text": "I took my metformin"}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, content=None):
            return _Resp()

    monkeypatch.setattr(voice.httpx, "AsyncClient", _Client)
    out = await voice.transcribe(b"audio")
    assert out == "I took my metformin"


class _StatusResp:
    def __init__(self, status, data=None):
        self.status_code = status
        self._data = data
        self.text = ""

    def json(self):
        return self._data


async def test_transcribe_mms_falls_back_to_whisper(monkeypatch):
    monkeypatch.setattr(get_settings(), "huggingface_api_key", "hf_test", raising=False)
    monkeypatch.setattr(get_settings(), "hf_stt_lowresource_model",
                        "facebook/mms-1b-all", raising=False)
    monkeypatch.setattr(get_settings(), "hf_stt_model",
                        "openai/whisper-large-v3", raising=False)

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None, content=None):
            if "mms-1b-all" in url:
                return _StatusResp(503)  # MMS route fails
            return _StatusResp(200, {"text": "i took my metformin"})

    monkeypatch.setattr(voice.httpx, "AsyncClient", _Client)
    out = await voice.transcribe(b"audio", engine="mms", language="nan")
    assert out == "i took my metformin"  # fell back to Whisper autodetect


async def test_transcribe_whisper_passes_language_hint(monkeypatch):
    monkeypatch.setattr(get_settings(), "huggingface_api_key", "hf_test", raising=False)
    monkeypatch.setattr(get_settings(), "hf_stt_model",
                        "openai/whisper-large-v3", raising=False)
    captured = {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None, content=None):
            captured["json"] = json
            return _StatusResp(200, {"text": "apa khabar"})

    monkeypatch.setattr(voice.httpx, "AsyncClient", _Client)
    out = await voice.transcribe(b"audio", engine="whisper", language="ms")
    assert out == "apa khabar"
    assert captured["json"]["parameters"]["language"] == "ms"


async def test_synthesize_returns_none_without_tts_model(monkeypatch):
    # STT key present but no HF_TTS_MODEL -> TTS stays off (returns None).
    monkeypatch.setattr(get_settings(), "huggingface_api_key", "hf_test", raising=False)
    monkeypatch.setattr(get_settings(), "hf_tts_model", "", raising=False)
    assert await voice.synthesize("hello") is None


async def test_synthesize_returns_audio_bytes(monkeypatch):
    monkeypatch.setattr(get_settings(), "huggingface_api_key", "hf_test", raising=False)
    monkeypatch.setattr(get_settings(), "hf_tts_model", "facebook/mms-tts-eng",
                        raising=False)

    class _Resp:
        status_code = 200
        content = b"OGGaudio"

        def json(self):  # unused for TTS, present for parity
            return {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            return _Resp()

    monkeypatch.setattr(voice.httpx, "AsyncClient", _Client)
    out = await voice.synthesize("take your metformin")
    assert out == b"OGGaudio"


# --- chunk_text (TTS chunking) ----------------------------------------------
def test_chunk_text_short_text_is_one_chunk():
    assert voice.chunk_text("Take your metformin.") == ["Take your metformin."]
    assert voice.chunk_text("") == []
    assert voice.chunk_text("   ") == []


def test_chunk_text_splits_on_sentence_boundaries():
    text = "First sentence here. Second sentence follows! Third one asks?"
    chunks = voice.chunk_text(text, limit=25)
    assert chunks == ["First sentence here.", "Second sentence follows!", "Third one asks?"]


def test_chunk_text_packs_sentences_up_to_limit():
    text = "One. Two. Three."
    assert voice.chunk_text(text, limit=10) == ["One. Two.", "Three."]


def test_chunk_text_hard_splits_an_overlong_sentence():
    text = "a" * 25
    chunks = voice.chunk_text(text, limit=10)
    assert chunks == ["a" * 10, "a" * 10, "a" * 5]
    assert all(len(c) <= 10 for c in chunks)


def test_chunk_text_handles_cjk_punctuation():
    text = "吃药了吗。记得吃饭！"
    assert voice.chunk_text(text, limit=6) == ["吃药了吗。", "记得吃饭！"]
