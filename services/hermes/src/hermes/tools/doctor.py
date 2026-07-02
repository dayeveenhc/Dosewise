"""Queue a question for the elder's doctor: add_doctor_question."""

from __future__ import annotations

from .base import ToolContext, register

_SCHEMA = {
    "name": "add_doctor_question",
    "description": (
        "Queue a question for the elder's doctor (e.g. about a side effect, an "
        "interaction, or a dosing concern). Use when the elder wants to ask their "
        "doctor something, or when a question is beyond what grounded facts can "
        "safely answer."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "The question to queue."},
            "context": {
                "type": "string",
                "description": "Optional brief context (symptom, medication).",
            },
        },
        "required": ["question"],
    },
}


async def add_doctor_question(
    ctx: ToolContext, question: str, context: str | None = None
) -> str:
    await ctx.db().insert(
        "doctor_questions",
        {
            "elder_id": ctx.elder_id,
            "question": question,
            "context": {"note": context} if context else {},
            "source": "agent",
            "status": "open",
        },
        returning=False,
    )
    return "Saved that question for the doctor. They'll see it on the next review."


register(_SCHEMA, add_doctor_question)
