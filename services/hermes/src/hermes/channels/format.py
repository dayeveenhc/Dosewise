"""Outbound message formatting for the chat channels.

Telegram messages are sent as plain text (no ``parse_mode``), so any markdown the
model emits — ``**bold**``, ``*italic*``, backtick code, ``#`` headings — reaches
the elder literally as clutter. ``strip_markdown`` removes those markers while
keeping the words, numbers, dosages, and emoji anchors the persona relies on.

Conservative by design: it only touches recognised markdown syntax, so drug names
and quantities like "Metformin 500mg" pass through untouched.
"""

from __future__ import annotations

import re

# [text](url) -> text (url), so links stay readable without markdown syntax.
_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_BOLD_STAR = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_BOLD_UNDER = re.compile(r"__(.+?)__", re.DOTALL)
# Emphasis with word-boundary guards so a bare '*' or an underscore inside a word
# (e.g. eye_drops) is left alone.
_ITALIC_STAR = re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", re.DOTALL)
_ITALIC_UNDER = re.compile(r"(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])", re.DOTALL)
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_BULLET_STAR = re.compile(r"^(\s*)\*\s+", re.MULTILINE)
_BACKTICKS = re.compile(r"`+")


def strip_markdown(text: str) -> str:
    """Remove markdown emphasis/heading/code markers, preserving the text itself."""
    if not text:
        return text
    text = _LINK.sub(r"\1 (\2)", text)
    text = _BOLD_STAR.sub(r"\1", text)
    text = _BOLD_UNDER.sub(r"\1", text)
    text = _ITALIC_STAR.sub(r"\1", text)
    text = _ITALIC_UNDER.sub(r"\1", text)
    text = _HEADING.sub("", text)
    # A leading "* " bullet becomes "- " (the persona's list style); do this before
    # dropping stray backticks so list structure survives.
    text = _BULLET_STAR.sub(r"\1- ", text)
    text = _BACKTICKS.sub("", text)
    return text
