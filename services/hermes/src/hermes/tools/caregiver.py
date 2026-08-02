"""Bridge to the caregiver: message_caregiver, add_care_note, list_caregivers.

Records the message as a system conversation turn (the durable record) and, when
the linked caregiver also happens to be chatting with the Telegram bot, delivers
it to them directly. No dedicated messages table exists, so conversation_turns is
the system of record here — grounded in the existing schema. ``add_care_note``
is the caregiver's own care log, persisted the same way.
"""

from __future__ import annotations

from .base import ToolContext, first_id, record_action, register

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
        entity_id=first_id(inserted),
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


_NOTE_SCHEMA = {
    "name": "add_care_note",
    "description": (
        "Save a note in the care log ('note that mom seemed tired today', "
        "'add to the care log that she ate well'). The note is recorded under "
        "the account that is chatting — chat cannot write to another person's "
        "record. Saves immediately."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "note": {"type": "string", "description": "The care note to save."}
        },
        "required": ["note"],
    },
}


async def add_care_note(ctx: ToolContext, note: str) -> str:
    """The chat identity IS the record owner: routes.py derives ``elder_id``
    from the JWT sub, and no act-on-behalf-of exists — so in the caregiver's
    chat this note lands in the caregiver's OWN thread. Mirrors the exact
    conversation_turns insert message_caregiver performs, which 0002's RLS
    allows via ``auth.uid() = elder_id``."""
    note = (note or "").strip()
    if not note:
        return "Ask what the care note should say, then save it."
    inserted = await ctx.db().insert(
        "conversation_turns",
        {
            "elder_id": ctx.elder_id,
            "speaker": "system",
            "transcript": note,
            "tool": "add_care_note",
            "outcome": {"kind": "care_note"},
        },
        returning=True,
    )
    record_action(
        ctx,
        tool="add_care_note",
        summary=note,
        entity_type="care_note",
        entity_id=first_id(inserted),
        changed_fields={"note": {"before": None, "after": note}},
    )
    return "Saved to the care log — it'll be there whenever they look back."


register(_NOTE_SCHEMA, add_care_note)


_LIST_SCHEMA = {
    "name": "list_caregivers",
    "description": (
        "Look up who is linked to this account as a caregiver / emergency contact, "
        "and how they are related. Use whenever the person asks 'who is my emergency "
        "contact', 'who can I call', 'who's my caregiver', 'who looks after me', "
        "'is anyone linked to my account', or — in a caregiver's own chat — 'who are "
        "my patients'. Read-only: it saves nothing and contacts nobody. Dosewise "
        "stores no phone numbers, so this never returns one."
    ),
    "input_schema": {"type": "object", "properties": {}, "required": []},
}

# Returned in place of a name when none can be resolved. An elder CANNOT read
# their caregiver's profiles row (0002_rls_policies.sql's
# profiles_select_self_or_caregiver grants caregiver→elder, not the reverse), so
# the only name available to them is whatever the app stashed in the link's
# permissions blob at request time (apps/web/src/app/lib/careLinks.ts). Seeded and
# provisioned links carry no such key, so this fallback is a normal path, not an
# edge case — say so honestly rather than inventing a name.
_UNNAMED_CAREGIVER = "a caregiver (name not recorded here)"
_UNNAMED_PATIENT = "a patient (name not recorded here)"

_COLS = "id,elder_id,caregiver_id,relationship,permissions,status,created_at"

_NO_PHONE = (
    "Dosewise stores no phone number for anyone — there is no phone field in this "
    "app. Give their name and relationship, and say plainly that you don't have a "
    "number saved for them. Never guess, invent, or read out a number. If this "
    "sounds like a real emergency, tell them to call local emergency services."
)


def _describe(row: dict, name_key: str, fallback: str) -> str:
    """One '- Name — relationship' line from a care_links row."""
    perms = row.get("permissions") or {}
    if not isinstance(perms, dict):
        perms = {}
    name = str(perms.get(name_key) or "").strip() or fallback
    # permissions.relationship beats the top-level column: careLinks.ts's re-arm
    # path (a previously revoked link being re-requested) updates only
    # {status, permissions}, so the column goes stale while the blob stays fresh.
    relationship = str(perms.get("relationship") or row.get("relationship") or "").strip()
    return f"- {name} — {relationship}" if relationship else f"- {name}"


async def list_caregivers(ctx: ToolContext) -> str:
    """Read-only: who is linked to this account, in either direction.

    The link DIRECTION is the role, and it is RLS-verified truth — rows on
    ``elder_id`` are "my caregivers", rows on ``caregiver_id`` are "my patients".
    That's why this needs no ``app_role``: the client-supplied one is untrusted,
    while ``care_links`` under ``care_links_select_party`` is not.

    Every filter is ``eq.`` on purpose. tests/fakes.py's FakeDB implements only
    eq/ilike/lte/gte and treats anything else as "no filter at all", so an
    ``in.(active,pending)`` would make the offline "a revoked link must never
    leak" test pass vacuously against a query that returns everything.
    """
    db = ctx.db()
    try:
        mine = await db.select(
            "care_links",
            columns=_COLS,
            filters={"elder_id": f"eq.{ctx.elder_id}", "status": "eq.active"},
        )
        caring_for = await db.select(
            "care_links",
            columns=_COLS,
            filters={"caregiver_id": f"eq.{ctx.elder_id}", "status": "eq.active"},
        )
        # Only worth mentioning when there's no real caregiver to report.
        pending = (
            await db.select(
                "care_links",
                columns=_COLS,
                filters={"elder_id": f"eq.{ctx.elder_id}", "status": "eq.pending"},
            )
            if not mine
            else []
        )
    except Exception:
        return (
            "I couldn't check who's linked to this account just now. Say so plainly "
            "and offer to try again in a moment — do NOT guess at a name."
        )

    blocks: list[str] = []
    if mine:
        lines = "\n".join(_describe(r, "requested_by_name", _UNNAMED_CAREGIVER) for r in mine)
        blocks.append(f"Caregivers linked to this account ({len(mine)}):\n{lines}\n\n{_NO_PHONE}")
    elif pending:
        lines = "\n".join(
            _describe(r, "requested_by_name", _UNNAMED_CAREGIVER) + " (waiting)" for r in pending
        )
        blocks.append(
            "No caregiver is linked to this account yet.\n"
            f"{len(pending)} caregiver request(s) still waiting for the patient's own "
            f"approval:\n{lines}\n\n"
            "A pending request is NOT a caregiver — nobody is linked until the patient "
            "accepts it themselves. Say that plainly, then offer to walk them through "
            "accepting it (start_walkthrough with accept_caregiver_link)."
        )
    elif not caring_for:
        blocks.append(
            "No caregiver is linked to this account.\n\n"
            "Say plainly that there is no caregiver or emergency contact on file. Do "
            "NOT name anyone and do NOT invent a phone number. Offer to show them how "
            "to add one (start_walkthrough with link_caregiver)."
        )

    if caring_for:
        # Legal in this direction only: is_linked_caregiver(elder_id) is true for
        # an active link, so profiles_select_self_or_caregiver permits the read.
        named: list[str] = []
        for row in caring_for:
            elder = row.get("elder_id")
            full_name = ""
            try:
                found = await db.select(
                    "profiles", columns="id,full_name", filters={"id": f"eq.{elder}"}
                )
                full_name = str((found[0].get("full_name") if found else "") or "").strip()
            except Exception:
                full_name = ""
            enriched = dict(row)
            perms = dict(enriched.get("permissions") or {})
            perms["patient_name"] = full_name
            enriched["permissions"] = perms
            named.append(_describe(enriched, "patient_name", _UNNAMED_PATIENT))
        blocks.append(
            f"People this account is a caregiver for ({len(caring_for)}):\n"
            + "\n".join(named)
            + "\n\nThis is the caregiver's own chat, so this lists THEIR patients, not "
            "a caregiver for them — say which it is so it can't be misread. "
            + _NO_PHONE
        )

    return "\n\n".join(blocks)


register(_LIST_SCHEMA, list_caregivers)
