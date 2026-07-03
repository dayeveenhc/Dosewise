"""Tests for the MongoDB-backed dialect slang loader (slang.py) — offline."""

from __future__ import annotations

import hermes.slang as slang
from fakes import FakeMongoClient

DOCS = [
    {"dialect": "hokkien", "term": "pang sai", "meaning": "bowel movement"},
    {"dialect": "hokkien", "term": "sng", "normalized_en": "sour"},
    {"dialect": "tamil", "term": "maruthuvam", "meaning": "medicine"},
]


async def test_get_slang_returns_terms_for_dialect(monkeypatch):
    monkeypatch.setattr(slang, "_get_client", lambda: FakeMongoClient(DOCS))
    slang._CACHE.clear()
    out = await slang.get_slang("hokkien")
    assert ("pang sai", "bowel movement") in out
    assert ("sng", "sour") in out  # normalized_en accepted as the meaning
    assert all(t != "maruthuvam" for t, _ in out)  # other dialects excluded


async def test_get_slang_empty_for_english():
    assert await slang.get_slang("en") == []
    assert await slang.get_slang(None) == []


async def test_get_slang_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(slang, "_get_client", lambda: None)
    slang._CACHE.clear()
    assert await slang.get_slang("tamil") == []


async def test_get_slang_caches(monkeypatch):
    calls = {"n": 0}

    def _client():
        calls["n"] += 1
        return FakeMongoClient(DOCS)

    monkeypatch.setattr(slang, "_get_client", _client)
    slang._CACHE.clear()
    await slang.get_slang("hokkien")
    await slang.get_slang("hokkien")
    assert calls["n"] == 1  # second lookup served from cache
