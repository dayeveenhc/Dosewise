"""raise_alert: interrupt the person for something that needs acting on today.

Sets ``ctx.alert``, which the web client turns into a full-screen popup —
deliberately reaching them even after they have left the chat, since the whole
point is a thing they would otherwise miss. Not a write (mirrors
``start_walkthrough`` / ``offer_choices``: a client-side UI signal, not a
change to any record). A documented no-op on Telegram, where the tool's return
text is simply what the model says.

**Why this is a tool with a MEANINGFUL RETURN, and not a bare side effect.**
MEMORY.md's 2026-08-07 entry records the measurement that governs this file: a
tool whose only effect is a side effect gets skipped by a model that has already
committed to a text reply — ``offer_choices`` scored 0/6 with correct prompting
in place. The fix there was a forced extra completion, which worked because a
cheap deterministic gate existed ("the reply ends in a question mark"). No such
gate exists for "should this turn raise an alert?", so forcing would tax every
turn in the app.

So this tool is built to not have that shape: it returns the DEDUPLICATION
VERDICT, a fact the model cannot know on its own and has to incorporate —
either "raised, so tell them in one line" or "NOT raised, they are already
seeing this, so say it in your reply and do not promise a notification". A tool
whose answer changes what you must write next is a tool that gets called.
"""

from __future__ import annotations

from .base import ToolContext, register

_SEVERITIES = ("critical", "urgent")

_SCHEMA = {
    "name": "raise_alert",
    "description": (
        "Put an urgent notice in front of the person NOW, as a popup they will "
        "see even if they leave this conversation. Use it ONLY for something "
        "they must act on today and would otherwise miss — a dangerous "
        "interaction you just grounded in the label, a critical medicine about "
        "to run out, a repeatedly missed critical dose. Never for information "
        "you can simply say in your reply, never to repeat something they are "
        "already looking at, and never more than once in a conversation. "
        "Interrupting someone elderly for something that could have waited is "
        "worse than not interrupting at all. Write the title and body in the "
        "person's own language, short and plain, and say what to DO."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "severity": {
                "type": "string",
                "enum": list(_SEVERITIES),
                "description": (
                    "'critical' = acting on it cannot wait until tomorrow (it "
                    "overrides quiet hours); 'urgent' = today, but it can wait "
                    "for morning."
                ),
            },
            "title": {"type": "string", "description": "One short line, in their language."},
            "body": {
                "type": "string",
                "description": "One or two plain sentences saying what to do about it.",
            },
            "medication_name": {
                "type": "string",
                "description": "The medication this is about, when it is about one.",
            },
        },
        "required": ["severity", "title", "body"],
    },
}


async def raise_alert(
    ctx: ToolContext,
    severity: str,
    title: str,
    body: str,
    medication_name: str | None = None,
) -> str:
    if severity not in _SEVERITIES:
        severity = "urgent"

    # At most one interruption per turn. A second call is not an error — the
    # model may reasonably notice two things — but the person gets the more
    # serious one, and is told about the other in the reply text instead.
    existing = ctx.alert
    if existing is not None:
        if existing.get("severity") == "critical" or severity != "critical":
            return (
                "NOT raised — a more serious alert is already going to interrupt "
                f"them this turn ('{existing.get('title')}'). Mention this second "
                "one in your reply text instead, and do not promise a popup for it."
            )

    ctx.alert = {
        "severity": severity,
        "title": title,
        "body": body,
        "medication_name": medication_name,
    }
    return (
        f"Alert raised ({severity}): {title}. The person will see this as a popup "
        "even if they leave this conversation, so say it once in your reply, "
        "briefly, and do not repeat the whole thing."
    )


register(_SCHEMA, raise_alert)
