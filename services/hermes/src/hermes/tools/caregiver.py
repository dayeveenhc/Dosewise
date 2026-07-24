"""Bridge to the caregiver: message_caregiver.

Records the message as a system conversation turn (the durable record) and, when
the linked caregiver also happens to be chatting with the Telegram bot, delivers
it to them directly. No dedicated messages table exists, so conversation_turns is
the system of record here — grounded in the existing schema.
"""

from __future__ import annotations

from .base import ToolContext, record_action, register

_SCHEMA = {
    "name": "message_caregiver",
    "description": (
        "Send a message or alert to the elder's linked caregiver (e.g. 'she missed "
        "her morning metformin' or 'he asked me to let you know he's feeling dizzy'). "
        "Use to keep the caregiver in the loop, especially for missed critical doses "
        "or concerns."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "What to tell the caregiver."}
        },
        "required": ["message"],
    },
}


async def message_caregiver(ctx: ToolContext, message: str) -> str:
    db = ctx.db()
    # Durable record of the outbound message.
    inserted = await db.insert(
        "conversation_turns",
        {
            "elder_id": ctx.elder_id,
            "speaker": "system",
            "transcript": message,
            "tool": "message_caregiver",
            "outcome": {"delivered_to": "caregiver"},
        },
        returning=True,
    )
    record_action(
        ctx,
        tool="message_caregiver",
        summary=message,
        entity_type="caregiver_message",
        entity_id=inserted[0]["id"] if inserted else "",
        changed_fields={"message": {"before": None, "after": message}},
    )

    # Best-effort live delivery over Telegram if a linked caregiver is mapped.
    delivered = 0
    if ctx.telegram is not None and ctx.session is not None:
        links = await db.select(
            "care_links",
            columns="caregiver_id",
            filters={"elder_id": f"eq.{ctx.elder_id}", "status": "eq.active"},
        )
        lookup = getattr(ctx.session, "registry", None)
        for link in links:
            chat_id = lookup.chat_for_profile(link["caregiver_id"]) if lookup else None
            if chat_id is not None:
                await ctx.telegram.send_message(
                    chat_id, f"\U0001f48a Dosewise update: {message}"
                )
                delivered += 1

    if delivered:
        return f"Message recorded and delivered to {delivered} caregiver(s)."
    return "Message recorded for the caregiver; they'll see it next time they check in."


register(_SCHEMA, message_caregiver)
