"""offer_choices: attach tappable option buttons to the agent's reply.

A web-only affordance so the person can TAP an answer — a yes/no confirm, or a
guided clarifying-question option — instead of typing it. The tool only records
the option set on the ToolContext (``ctx.choices``); the web client renders the
buttons under the reply and sends the tapped value back as the next turn. It is
NOT a write (mirrors start_walkthrough — a client-side UI hint only). Telegram
has its own inline-button path, so on that channel this is just a benign no-op
signal the channel ignores.
"""

from __future__ import annotations

from .base import ToolContext, register

_SCHEMA = {
    "name": "offer_choices",
    "description": (
        "Offer the person tappable option buttons in the app so they can answer "
        "with a single tap instead of typing. Call this WHENEVER you ask a yes/no "
        "question — especially before saving anything, offer a Yes and a No — or "
        "when you ask them to pick between options, or a guided clarifying question "
        "with a few likely answers (like verifying a detail before you act). Pass "
        "2-4 short options in the person's own language. Still say the question in "
        "your reply text too; the buttons accompany it. The tapped option is sent "
        "back verbatim as the person's next message, so word each option as the "
        "answer you want to receive (e.g. 'Yes, save it' / 'No, not now')."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "description": "2-4 short button labels, in the person's language.",
                "minItems": 2,
                "maxItems": 4,
            },
        },
        "required": ["options"],
    },
}


async def offer_choices(ctx: ToolContext, options: list[str]) -> str:
    # Trim, drop blanks, dedup case-insensitively preserving order, cap at 4 so
    # the button row stays tidy.
    seen: set[str] = set()
    uniq: list[str] = []
    for o in options or []:
        if not isinstance(o, str):
            continue
        label = o.strip()
        if not label or label.lower() in seen:
            continue
        seen.add(label.lower())
        uniq.append(label)
    uniq = uniq[:4]
    if len(uniq) < 2:
        ctx.choices = None
        return (
            "Didn't attach buttons — offer_choices needs at least 2 distinct "
            "options. Just ask the question in your reply instead."
        )
    # label == value: the button text IS the message sent when tapped, so the
    # model interprets it on the next turn exactly as if the person had typed it.
    ctx.choices = [{"label": o, "value": o} for o in uniq]
    # Channel-neutral phrasing: on the web the person sees tappable buttons, on
    # Telegram this is a no-op — so don't tell the model buttons definitely
    # rendered, or it may promise "tap below" where nothing appears.
    return (
        f"Recorded {len(uniq)} answer options for the app to show as tappable "
        "buttons. Still state the question in your reply text — the person can tap "
        "an option or just type their answer."
    )


register(_SCHEMA, offer_choices)
