"""Reusable offline test doubles for Supabase, Telegram, and Anthropic.

No network, no live services. FakeDB applies just enough PostgREST-style filter
semantics (eq / ilike / lte / gte) that tool logic exercises real branches.
"""

from __future__ import annotations

import json
from types import SimpleNamespace


def _match_one(row: dict, col: str, expr: str) -> bool:
    op, _, val = expr.partition(".")
    actual = row.get(col)
    if op == "eq":
        return str(actual).lower() == val.lower()
    if op == "ilike":
        return val.strip("%").lower() in str(actual).lower()
    if op == "lte":
        return actual is not None and str(actual) <= val
    if op == "gte":
        return actual is not None and str(actual) >= val
    return True


class FakeDB:
    """A single PostgREST client double, backed by in-memory tables."""

    def __init__(self, tables: dict[str, list[dict]] | None = None):
        self.tables = {k: list(v) for k, v in (tables or {}).items()}
        self.inserted: list[tuple[str, dict]] = []
        self.updated: list[tuple[str, dict, dict]] = []

    async def select(self, table, *, columns="*", filters=None, order=None, limit=None):
        rows = list(self.tables.get(table, []))
        for col, expr in (filters or {}).items():
            rows = [r for r in rows if _match_one(r, col, expr)]
        if limit is not None:
            rows = rows[:limit]
        return rows

    async def insert(self, table, row, returning=True):
        self.inserted.append((table, row))
        return [row] if returning else []

    async def update(self, table, patch, *, filters, returning=True):
        self.updated.append((table, patch, filters))
        return [patch] if returning else []


class FakeSupabase:
    """Hands out user- and service-scoped clients (same FakeDB unless split)."""

    def __init__(
        self, db: FakeDB | None = None, service_db: FakeDB | None = None, fail_upload: bool = False
    ):
        self.db = db or FakeDB()
        self.service = service_db or self.db
        self.uploads: list[tuple[str, str, str]] = []
        self._fail_upload = fail_upload

    def user_client(self, elder_id):
        return self.db

    def service_client(self):
        return self.service

    async def upload_object(self, bucket, path, data, *, content_type, upsert=True):
        if self._fail_upload:
            raise RuntimeError("storage unavailable")
        self.uploads.append((bucket, path, content_type))
        return path


class FakeTelegram:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []
        self.markups: list[dict | None] = []
        self.answered: list[str] = []
        self.audio_sent: list[tuple[int, bytes]] = []
        self.downloads: list[str] = []
        self.audio = b"fake-audio-bytes"

    async def send_message(self, chat_id, text, reply_markup=None):
        self.sent.append((chat_id, text))
        self.markups.append(reply_markup)

    async def answer_callback_query(self, callback_query_id, text=None):
        self.answered.append(callback_query_id)

    async def send_audio(self, chat_id, audio, *, filename="reply.wav", mime="audio/wav"):
        self.audio_sent.append((chat_id, audio))

    async def send_chat_action(self, chat_id, action="typing"):
        pass

    async def download_file(self, file_id):
        self.downloads.append(file_id)
        return self.audio


def use_anthropic(monkeypatch) -> None:
    """Pin the effective LLM provider to Anthropic for a test.

    ``hermes.config.Settings`` reads the real repo-root ``.env`` (pydantic-settings
    ``env_file=``), so tests using ``FakeAnthropic`` must not rely on whatever the
    *deployed* .env happens to contain (e.g. it may set LLM_PROVIDER=openai with a
    working key, which would route these tests into the OpenAI/Gemini code path
    instead). Mirrors the ``_use_gemini``/``_use_openai`` helpers in the
    provider-specific test files.
    """
    from hermes.config import get_settings

    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)


# --- Anthropic response builders -------------------------------------------
def text_block(text: str):
    return SimpleNamespace(type="text", text=text)


def tool_use_block(name: str, tool_input: dict, block_id: str = "tu_1"):
    return SimpleNamespace(type="tool_use", name=name, input=tool_input, id=block_id)


def response(stop_reason: str, content: list):
    return SimpleNamespace(stop_reason=stop_reason, content=content)


class FakeMessages:
    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        # Repeat the last response if the loop iterates more than we scripted.
        return self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]


class FakeAnthropic:
    def __init__(self, responses: list):
        self.messages = FakeMessages(responses)


# --- Gemini response builders ----------------------------------------------
def gemini_function_call(name: str, args: dict):
    return SimpleNamespace(function_call=SimpleNamespace(name=name, args=args), text=None)


def gemini_text_part(text: str):
    return SimpleNamespace(function_call=None, text=text)


def gemini_response(parts: list):
    content = SimpleNamespace(role="model", parts=parts)
    return SimpleNamespace(candidates=[SimpleNamespace(content=content)])


class _FakeGeminiModels:
    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list = []

    async def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        return self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]


class FakeGemini:
    """Doubles ``genai.Client``: exposes ``.aio.models.generate_content``."""

    def __init__(self, responses: list):
        self.aio = SimpleNamespace(models=_FakeGeminiModels(responses))


# --- OpenAI response builders ------------------------------------------------
def openai_tool_call(name: str, args: dict, call_id: str = "call_1"):
    return SimpleNamespace(
        id=call_id, type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )


def openai_message(content: str | None = None, tool_calls: list | None = None):
    return SimpleNamespace(content=content, tool_calls=tool_calls or [])


def openai_response(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class _FakeOpenAICompletions:
    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]


class FakeOpenAI:
    """Doubles ``AsyncOpenAI``: exposes ``.chat.completions.create``."""

    def __init__(self, responses: list):
        self.chat = SimpleNamespace(completions=_FakeOpenAICompletions(responses))


# --- MongoDB (slang dictionary) doubles -------------------------------------
class _FakeMongoCursor:
    def __init__(self, docs: list[dict]):
        self._docs = list(docs)

    def limit(self, n: int):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration from None


class _FakeMongoCollection:
    def __init__(self, docs: list[dict]):
        self._docs = docs

    def find(self, query: dict, projection: dict | None = None):
        dialect = query.get("dialect")
        return _FakeMongoCursor([d for d in self._docs if d.get("dialect") == dialect])


class _FakeMongoDB:
    def __init__(self, docs: list[dict]):
        self._docs = docs

    def __getitem__(self, _collection):
        return _FakeMongoCollection(self._docs)


class FakeMongoClient:
    """Doubles ``AsyncIOMotorClient``: ``client[db][collection].find(...)``."""

    def __init__(self, docs: list[dict]):
        self._docs = docs
        self.closed = False

    def __getitem__(self, _db):
        return _FakeMongoDB(self._docs)

    def close(self):
        self.closed = True
