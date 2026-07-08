"""Save the patient's medical profile: update_medical_profile.

Stores a plain-language summary of allergies, conditions, and relevant history at
``profiles.accessibility.medical_profile`` so later drug answers can be tailored to
the patient. Human-in-the-loop: like a prescription, an update is PROPOSED first
(confirmed=false), read back, and only written after a clear yes. Never diagnoses;
it records what the patient/caregiver states or what a document lists.
"""

from __future__ import annotations

from .base import ToolContext, register

_SCHEMA = {
    "name": "update_medical_profile",
    "description": (
        "Save or update the patient's medical profile — allergies, conditions, and "
        "relevant history — so future answers can be tailored to them. Use after "
        "reading a prescription list / medical-history document or when the patient "
        "states a condition or allergy. SAFETY: propose→confirm — first call with "
        "confirmed=false to read the summary back, then confirmed=true after a clear "
        "yes. By default this APPENDS to the existing profile; pass replace=true only "
        "to overwrite it. Record facts plainly; never diagnose or infer conditions."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "Plain-language facts to record (e.g. 'Allergic to "
                "penicillin. Has type 2 diabetes and high blood pressure.').",
            },
            "replace": {
                "type": "boolean",
                "description": "false (default) appends; true overwrites the profile.",
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = propose only (no write); true = commit after "
                "the patient confirmed.",
            },
        },
        "required": ["content", "confirmed"],
    },
}


async def update_medical_profile(
    ctx: ToolContext,
    content: str,
    confirmed: bool,
    replace: bool = False,
) -> str:
    content = (content or "").strip()
    if not content:
        return "Ask the patient what to record in their medical profile, then propose it."

    if not confirmed:
        if ctx.session is not None:
            ctx.session.pending_profile = {"content": content, "replace": replace}
            ctx.session.awaiting_confirmation = True
        verb = (
            "replace their medical profile with" if replace
            else "add this to their medical profile"
        )
        return (
            "PROPOSED (not yet saved). Read this back to the patient and ask them to "
            f"confirm before saving — {verb}: {content}"
        )

    pending = getattr(ctx.session, "pending_profile", None) if ctx.session else None
    if pending is None or pending.get("content") != content:
        return (
            "Refused to save: no matching pending profile update was confirmed. "
            "Propose it first (confirmed=false) and get the patient's explicit yes."
        )
    replace = bool(pending.get("replace"))

    db = ctx.db()
    rows = await db.select(
        "profiles", columns="accessibility", filters={"id": f"eq.{ctx.elder_id}"}, limit=1
    )
    access = dict((rows[0].get("accessibility") if rows else None) or {})
    existing = access.get("medical_profile")
    if replace or not (isinstance(existing, str) and existing.strip()):
        new_profile = content
    else:
        new_profile = f"{existing.strip()}\n{content}"
    access["medical_profile"] = new_profile

    await db.update(
        "profiles",
        {"accessibility": access},
        filters={"id": f"eq.{ctx.elder_id}"},
        returning=False,
    )
    # Refresh the session cache so the new profile tailors the very next turn.
    if ctx.session is not None:
        ctx.session.medical_profile = new_profile
        ctx.session.medical_profile_loaded = True
        ctx.session.pending_profile = None
        ctx.session.awaiting_confirmation = False
        # A committed profile ends any guided-intake (/setup) re-run.
        ctx.session.intake_active = False
    ctx.committed_actions.append(
        {"tool": "update_medical_profile", "summary": "medical profile"}
    )
    return "Saved to the patient's medical profile. I'll keep it in mind going forward."


register(_SCHEMA, update_medical_profile)
