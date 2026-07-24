"""Escalate to a human: request_human_help.

Uses the doctor_questions table as the escalation log (source='agent'), per the
architecture doc which designates it the escalation log.
"""

from __future__ import annotations

from .base import ToolContext, first_id, record_action, register

_SCHEMA = {
    "name": "request_human_help",
    "description": (
        "Escalate to a human when you are uncertain, when there is a possible "
        "safety concern, or when the elder is distressed or asks for a person. "
        "Logs the escalation and signals that a caregiver/support should follow up. "
        "Prefer escalating over guessing on anything safety-relevant."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "Why help is needed (the concern or request).",
            },
            "urgency": {
                "type": "string",
                "enum": ["low", "medium", "high"],
                "description": "How time-sensitive this is.",
            },
        },
        "required": ["reason"],
    },
}


async def request_human_help(
    ctx: ToolContext, reason: str, urgency: str = "medium"
) -> str:
    inserted = await ctx.db().insert(
        "doctor_questions",
        {
            "elder_id": ctx.elder_id,
            "question": f"[ESCALATION] {reason}",
            "context": {"type": "escalation", "urgency": urgency},
            "source": "agent",
            "status": "open",
        },
        returning=True,
    )
    record_action(
        ctx,
        tool="request_human_help",
        summary=reason,
        entity_type="escalation",
        entity_id=first_id(inserted),
        changed_fields={"reason": {"before": None, "after": reason}},
    )
    return (
        "Logged an escalation for a human to follow up. Reassure the elder that a "
        "caregiver or support person will be in touch."
    )


register(_SCHEMA, request_human_help)
