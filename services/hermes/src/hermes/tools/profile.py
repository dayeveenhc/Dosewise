"""Save the patient's medical profile: update_medical_profile, set_allergy_severity.

Stores a plain-language summary of allergies, conditions, and relevant history at
``profiles.accessibility.medical_profile`` so later drug answers can be tailored to
the patient; ``set_allergy_severity`` grades a saved ``accessibility.allergies``
entry. Human-in-the-loop: like a prescription, an update is PROPOSED first
(confirmed=false), read back, and only written after a clear yes. Never diagnoses;
it records what the patient/caregiver states or what a document lists.
"""

from __future__ import annotations

import re

from .base import (
    ToolContext,
    match_pending,
    match_pending_bulk,
    record_action,
    register,
)

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

    pending = match_pending(ctx, "pending_profile", "content", content)
    if pending is None:
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
    record_action(
        ctx,
        tool="update_medical_profile",
        summary="medical profile",
        entity_type="profile_field",
        # A stable field key (not the elder uuid) so the UI can place the highlight
        # on the specific settings field: data-testid="profile_field-medical_profile".
        entity_id="medical_profile",
        changed_fields={
            "medical_profile": {"before": existing or None, "after": new_profile}
        },
    )
    return "Saved to the patient's medical profile. I'll keep it in mind going forward."


register(_SCHEMA, update_medical_profile)


_SEVERITIES = ("mild", "moderate", "severe")

_ALLERGY_SCHEMA = {
    "name": "set_allergy_severity",
    "description": (
        "Record how severe one of the patient's SAVED allergies is ('my "
        "penicillin allergy is severe'). severity must be mild, moderate, or "
        "severe. Only grades an allergy already on the profile — it never adds "
        "one. SAFETY: propose→confirm — first call with confirmed=false to "
        "read it back, then confirmed=true after the patient's clear yes."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "allergy": {
                "type": "string",
                "description": "The allergy's name as saved on the profile "
                "(e.g. 'Penicillin').",
            },
            "severity": {
                "type": "string",
                "enum": ["mild", "moderate", "severe"],
                "description": "How severe the patient says it is.",
            },
            "confirmed": {
                "type": "boolean",
                "description": "false = propose only (no write); true = commit "
                "after the patient confirmed.",
            },
        },
        "required": ["allergy", "severity"],
    },
}


def _allergy_slug(name: str) -> str:
    """Stable DOM id for an allergy entry.

    THE rule the frontend mirrors EXACTLY to build
    ``data-testid="allergy-{slug}"`` — never change one side alone: lowercase,
    keep ``[a-z0-9]``, every run of any other characters becomes a single
    ``-``, then trim leading/trailing ``-``. "Penicillin G" → "penicillin-g".
    """
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _promote_allergies(raw: list) -> list[dict]:
    """Promote legacy plain-string allergy entries to ``{"name", "severity"}``.

    The stored shape becomes a dict for EVERY entry on first write (order and
    names preserved; unknown extra keys on already-dict entries survive), so
    the list is uniformly shaped from then on."""
    out: list[dict] = []
    for entry in raw or []:
        if isinstance(entry, dict):
            out.append(
                {**entry, "name": str(entry.get("name") or ""),
                 "severity": entry.get("severity")}
            )
        else:
            out.append({"name": str(entry), "severity": None})
    return out


def _allergy_names(raw: list) -> list[str]:
    return [
        str((e.get("name") if isinstance(e, dict) else e) or "") for e in raw or []
    ]


async def set_allergy_severity(
    ctx: ToolContext, allergy: str, severity: str, confirmed: bool = False
) -> str:
    allergy = (allergy or "").strip()
    sev = (severity or "").strip().lower()
    if not allergy:
        return "Ask the patient which allergy they mean, then propose the change."
    if sev not in _SEVERITIES:
        return (
            "Severity must be one of: mild, moderate, severe. Ask the patient "
            "which fits best, and don't save yet."
        )

    db = ctx.db()
    if not confirmed:
        rows = await db.select(
            "profiles",
            columns="accessibility",
            filters={"id": f"eq.{ctx.elder_id}"},
            limit=1,
        )
        access = dict((rows[0].get("accessibility") if rows else None) or {})
        names = [n for n in _allergy_names(access.get("allergies")) if n]
        if not any(n.strip().lower() == allergy.lower() for n in names):
            listing = ", ".join(names) if names else "none on file"
            return (
                f"No allergy named '{allergy}' is saved on the profile (saved "
                f"allergies: {listing}). This tool only grades a saved allergy "
                "— offer to add it to their profile first."
            )
        if ctx.session is not None:
            ctx.session.pending_bulk = {
                "tool": "set_allergy_severity",
                "items": [{"allergy": allergy, "severity": sev}],
            }
            ctx.session.awaiting_confirmation = True
        return (
            "PROPOSED (not yet saved). Read this back to the patient and ask "
            f"them to confirm before saving: mark their {allergy} allergy as "
            f"{sev}."
        )

    # confirmed=true: only honor a confirm for the allergy that was read back.
    items = match_pending_bulk(ctx, "set_allergy_severity")
    item = items[0] if items else None
    stashed = ((item or {}).get("allergy") or "").strip().lower()
    if item is None or stashed != allergy.lower():
        return (
            "Refused to save: no matching pending allergy update was confirmed. "
            "Propose it first (confirmed=false) and get the patient's explicit "
            "yes."
        )
    sev = (item.get("severity") or sev).strip().lower()
    if ctx.session is not None:
        ctx.session.pending_bulk = None
        ctx.session.awaiting_confirmation = False

    # Read-merge-write on accessibility (never overwrite the whole object),
    # promoting the whole allergies list to the dict shape in place.
    rows = await db.select(
        "profiles",
        columns="accessibility",
        filters={"id": f"eq.{ctx.elder_id}"},
        limit=1,
    )
    access = dict((rows[0].get("accessibility") if rows else None) or {})
    promoted = _promote_allergies(access.get("allergies"))
    target = next(
        (e for e in promoted if e["name"].strip().lower() == allergy.lower()), None
    )
    if target is None:
        listing = ", ".join(e["name"] for e in promoted if e["name"]) or "none on file"
        return (
            f"No allergy named '{allergy}' is saved on the profile (saved "
            f"allergies: {listing}) — nothing was changed. Ask the patient to "
            "confirm the name."
        )
    before = target.get("severity")
    target["severity"] = sev
    access["allergies"] = promoted
    await db.update(
        "profiles",
        {"accessibility": access},
        filters={"id": f"eq.{ctx.elder_id}"},
        returning=False,
    )
    record_action(
        ctx,
        tool="set_allergy_severity",
        summary=f"{target['name']} allergy: {sev}",
        entity_type="allergy",
        entity_id=_allergy_slug(target["name"]),
        changed_fields={"severity": {"before": before, "after": sev}},
        name=target["name"],
    )
    return f"Saved. The {target['name']} allergy is marked {sev} on the profile."


register(_ALLERGY_SCHEMA, set_allergy_severity)
