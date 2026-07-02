"""Surface a how-to clip: show_instruction_video."""

from __future__ import annotations

from .base import ToolContext, register

_SCHEMA = {
    "name": "show_instruction_video",
    "description": (
        "Find a short how-to video for a medication technique (e.g. eye drops, "
        "inhaler, ointment). Use when the elder is unsure how to physically take or "
        "apply a medication. Returns the video's title and location."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "technique": {
                "type": "string",
                "description": "Technique keyword, e.g. 'eye_drops', 'inhaler'.",
            }
        },
        "required": ["technique"],
    },
}


async def show_instruction_video(ctx: ToolContext, technique: str) -> str:
    rows = await ctx.db().select(
        "instruction_videos",
        columns="title,technique,storage_path",
        filters={"technique": f"eq.{technique}"},
        limit=1,
    )
    if not rows:
        return (
            f"No instruction video is available for '{technique}'. Offer to explain "
            "the steps in words instead, or to escalate to a caregiver."
        )
    v = rows[0]
    return (
        f"Found a video: '{v['title']}' ({v['storage_path']}). "
        "Tell the elder you can play it for them."
    )


register(_SCHEMA, show_instruction_video)
