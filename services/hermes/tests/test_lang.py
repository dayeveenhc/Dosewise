"""Tests for dialect/language mapping + fastText detection (channels/lang.py)."""

from __future__ import annotations

import hermes.channels.lang as lang


def test_stt_plan_routes_low_resource_to_mms():
    assert lang.stt_plan("hokkien") == ("mms", "nan")
    assert lang.stt_plan("teochew") == ("mms", "nan")


def test_stt_plan_uses_whisper_for_high_resource():
    assert lang.stt_plan("en") == ("whisper", "en")
    assert lang.stt_plan("zh") == ("whisper", "zh")
    assert lang.stt_plan("tamil") == ("whisper", "ta")
    assert lang.stt_plan("cantonese") == ("whisper", "yue")
    assert lang.stt_plan("klingon") == ("whisper", None)  # unknown -> autodetect


def test_tts_model_for():
    assert lang.tts_model_for("cmn", None) == "facebook/mms-tts-cmn"
    assert lang.tts_model_for("nan", None) == "facebook/mms-tts-nan"
    assert lang.tts_model_for("xyz", "facebook/mms-tts-eng") == "facebook/mms-tts-eng"
    assert lang.tts_model_for(None, None) is None


def test_language_name():
    assert lang.language_name("nan") == "Hokkien"
    assert lang.language_name("zlm") == "Malay"
    assert lang.language_name(None) is None


def test_detect_language_parses_fasttext_label(monkeypatch):
    class _FakeLid:
        def predict(self, text, k=1):
            return (["__label__zlm_Latn"], [0.99])

    monkeypatch.setattr(lang, "_load_lid", lambda: _FakeLid())
    assert lang.detect_language("apa khabar") == "zlm"


def test_detect_language_none_when_model_unavailable(monkeypatch):
    monkeypatch.setattr(lang, "_load_lid", lambda: None)
    assert lang.detect_language("hello") is None


def test_detect_language_none_for_empty_text():
    assert lang.detect_language("") is None
    assert lang.detect_language(None) is None
