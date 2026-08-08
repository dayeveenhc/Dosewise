"""Answer buttons for a question the model asked conversationally.

Replaces test_yesno_backstop.py. That covered a REGEX heuristic
(`_looks_like_yesno_question` + English-only `_apply_yesno_backstop`) which was
deleted, not disabled: it could not be made correct — nothing in a turn
separates "Shall I look that up?" from "Which medicine did you take?" — and,
decisively, Hermes holds no translation table, so it could only ever emit
English labels into a Tamil or Mandarin conversation.

`agent/answers.py` replaces it with a FORCED `suggest_answers` tool call
(extract.py's trick), so the model both judges whether the question has pickable
answers and writes them in the reader's own language. What is testable offline
is the gate, the cleaning rules, and — most importantly — that every failure
mode is silent.
"""

from __future__ import annotations

import pytest

from hermes.agent import answers
from hermes.agent.answers import _clean, ends_with_question, suggest_answers
from hermes.config import get_settings

# --- the cheap gate: is it even worth spending a completion? -----------------

@pytest.mark.parametrize(
    "reply, expected",
    [
        ("Would you like me to note that down?", True),
        ("I've noted it down.", False),
        ("", False),
        ("   \n  \n ", False),
        # Multi-line: only the LAST non-empty line decides.
        ("💊 Metformin 500mg\n🕗 8:00 AM\n\nShall I set a reminder?", True),
        ("Shall I set a reminder?\n\nI've saved it.", False),
        # Trailing blank lines must not hide the question.
        ("Would you like that?\n\n\n", True),
        # Full-width '？' — Mandarin/Cantonese/Hokkien replies use it, and those
        # readers are exactly the ones for whom typing is hardest.
        ("要我帮您记下来吗？", True),
        ("已经记下来了。", False),
    ],
)
def test_gate_reads_the_last_line_only(reply, expected):
    assert ends_with_question(reply) is expected


# --- cleaning: the same shape offer_choices enforces -------------------------

def test_clean_trims_dedupes_caps_and_requires_two():
    assert _clean(["  Yes, please  ", "No, not now"]) == ["Yes, please", "No, not now"]
    # Case-insensitive dedupe, and one option is not a choice.
    assert _clean(["Yes", "yes", "YES"]) == []
    assert _clean(["a", "b", "c", "d", "e"]) == ["a", "b", "c", "d"]
    assert _clean(["Only one"]) == []
    assert _clean([]) == []


def test_clean_survives_anything_the_model_returns():
    # A wrong option is sent verbatim as the person's next message, so garbage
    # in must mean nothing out — never a partially-parsed list.
    assert _clean(None) == []
    assert _clean("Yes, please") == []
    assert _clean({"options": ["Yes"]}) == []
    assert _clean([1, 2, 3]) == []
    assert _clean(["", "   ", "Yes, please", "No, not now"]) == ["Yes, please", "No, not now"]


# --- suggest_answers: every path that must NOT spend a completion ------------

@pytest.mark.anyio
async def test_no_completion_when_the_reply_asks_nothing(monkeypatch):
    called = False

    async def boom(*_a, **_k):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(answers, "_suggest_openai", boom)
    monkeypatch.setattr(answers.llm, "effective_provider", lambda *_a, **_k: "openai")
    assert await suggest_answers(object(), "I've noted it down.") == []
    assert called is False


@pytest.mark.anyio
async def test_disabled_by_setting(monkeypatch):
    monkeypatch.setattr(get_settings(), "answer_buttons", False, raising=False)

    async def boom(*_a, **_k):
        raise AssertionError("must not call the model when the feature is off")

    monkeypatch.setattr(answers, "_suggest_openai", boom)
    assert await suggest_answers(object(), "Would you like me to note that?") == []


@pytest.mark.anyio
async def test_a_provider_failure_is_silent(monkeypatch):
    """A UI affordance must never take a turn down — the person can still type."""
    monkeypatch.setattr(get_settings(), "answer_buttons", True, raising=False)
    monkeypatch.setattr(answers.llm, "effective_provider", lambda *_a, **_k: "openai")

    async def explode(*_a, **_k):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(answers, "_suggest_openai", explode)
    assert await suggest_answers(object(), "Would you like me to note that?") == []


@pytest.mark.anyio
async def test_returns_the_models_labels_verbatim(monkeypatch):
    monkeypatch.setattr(get_settings(), "answer_buttons", True, raising=False)
    monkeypatch.setattr(answers.llm, "effective_provider", lambda *_a, **_k: "openai")

    async def fake(_client, reply):
        assert "Would you like me to note that?" in reply
        return {"options": ["Yes, please", "No, not now"]}

    monkeypatch.setattr(answers, "_suggest_openai", fake)
    assert await suggest_answers(object(), "Would you like me to note that?") == [
        "Yes, please",
        "No, not now",
    ]


@pytest.mark.anyio
async def test_an_open_question_yields_nothing(monkeypatch):
    """The model returning [] is the designed answer for an open question, and
    it must survive as [] rather than becoming a generic Yes/No."""
    monkeypatch.setattr(get_settings(), "answer_buttons", True, raising=False)
    monkeypatch.setattr(answers.llm, "effective_provider", lambda *_a, **_k: "openai")
    monkeypatch.setattr(answers, "_suggest_openai", lambda *_a, **_k: _empty())
    assert await suggest_answers(object(), "Which medicine did you take?") == []


async def _empty() -> dict:
    return {"options": []}


@pytest.mark.anyio
async def test_labels_are_not_forced_into_english(monkeypatch):
    """The whole reason this replaced the regex backstop: the model writes the
    labels, so a Mandarin conversation gets Mandarin answers."""
    monkeypatch.setattr(get_settings(), "answer_buttons", True, raising=False)
    monkeypatch.setattr(answers.llm, "effective_provider", lambda *_a, **_k: "openai")

    async def fake(*_a, **_k):
        return {"options": ["好的，请记下", "先不用"]}

    monkeypatch.setattr(answers, "_suggest_openai", fake)
    assert await suggest_answers(object(), "要我帮您记下来吗？") == ["好的，请记下", "先不用"]
