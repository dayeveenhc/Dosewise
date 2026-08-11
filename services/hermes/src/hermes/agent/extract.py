"""Structured profile extraction — the "pull" side of the agent.

``extract_profile_fields`` reads a patient's uploaded medical record (a clinic
report or discharge summary as extracted PDF text, or a photo of a report/label
as a vision input) and returns structured profile fields for the app to
**pre-fill a form the patient then reviews**. It is deliberately *not* the chat
loop: one shot, no tools that write, no DB access, no identity — just
record-in, fields-out.

Like ``loop.py`` it is provider-agnostic (OpenAI default, Gemini, Anthropic
fallback), forcing a single ``record_profile`` tool call so the model must
return the structured shape rather than prose. Fields are best-effort: the
prompt tells the model to omit anything it can't read with confidence and never
to guess — this data is safety-sensitive and the user confirms it before it is
saved.
"""

from __future__ import annotations

import base64
import json
import logging

from ..config import get_settings
from . import llm

log = logging.getLogger("hermes.extract")

_MAX_TOKENS = 1024

# JSON-schema (Anthropic ``input_schema`` shape — the canonical form the OpenAI
# and Gemini converters in loop.py also consume). Mirrors the frontend's
# ProfileDetails / DraftMed shapes (apps/web/src/app/lib/profile.ts). Every field
# is optional: the model returns only what the record actually contains.
_MED_ITEM = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "Medication name."},
        "dose": {"type": "string", "description": "Dose, e.g. '500mg'."},
        "time": {"type": "string", "description": "Time of day taken, e.g. '08:00' or 'morning'."},
    },
}

_PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "full_name": {"type": "string", "description": "Patient's full name, if printed."},
        "dob": {"type": "string", "description": "Date of birth as YYYY-MM-DD."},
        "gender": {"type": "string", "enum": ["Female", "Male"], "description": "If stated."},
        "weight_kg": {"type": "number", "description": "Body weight in kilograms."},
        "height_cm": {"type": "number", "description": "Height in centimetres."},
        "conditions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Diagnosed medical conditions.",
        },
        "allergies": {
            "type": "array",
            "items": {"type": "string"},
            "description": "General (non-drug) allergies.",
        },
        "drug_allergies": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Medication/drug allergies.",
        },
        "current_meds": {
            "type": "array",
            "items": _MED_ITEM,
            "description": "Medications the patient currently takes.",
        },
        "past_meds": {
            "type": "array",
            "items": _MED_ITEM,
            "description": "Medications taken in the past / discontinued.",
        },
    },
}

_TOOL_NAME = "record_profile"
_TOOL_DESCRIPTION = (
    "Record the structured medical-profile fields read from the patient's "
    "uploaded record."
)

_SYSTEM = (
    "You extract structured medical-profile fields from a patient's uploaded "
    "record (a clinic report, discharge summary, referral letter, or medication "
    "label) so an app can PRE-FILL a form the patient will review and confirm. "
    f"Call the {_TOOL_NAME} tool with only the fields you can read directly and "
    "with confidence. Omit any field that is not clearly present — never guess, "
    "infer, or fabricate. Use YYYY-MM-DD for dates and plain numbers for weight "
    "(kg) and height (cm). Keep medication/drug allergies separate from general "
    "allergies. This data is safety-sensitive; when unsure, leave it out."
)


async def extract_profile_fields(
    client,
    *,
    image_bytes: bytes | None = None,
    image_media_type: str = "image/jpeg",
    pdf_text: str | None = None,
) -> dict:
    """Return structured profile fields read from an uploaded record.

    Provide either ``image_bytes`` (a photo, sent as a vision input) or
    ``pdf_text`` (already-extracted PDF text). Returns ``{}`` when there is
    nothing to read or the model returns no structured call.
    """
    has_text = bool((pdf_text or "").strip())
    if image_bytes is None and not has_text:
        return {}

    user_text = (
        "Here is the patient's uploaded medical record (extracted text). "
        f"Read it and extract the profile fields.\n\n{pdf_text.strip()}"
        if has_text
        else "Here is a photo of the patient's uploaded medical record. "
        "Read it and extract the profile fields."
    )

    return await _run_extraction(
        client,
        user_text=user_text,
        image_bytes=image_bytes,
        image_media_type=image_media_type,
        tool_name=_TOOL_NAME,
        tool_description=_TOOL_DESCRIPTION,
        schema=_PROFILE_SCHEMA,
        system=_SYSTEM,
        label="profile",
    )


async def _run_extraction(
    client,
    *,
    user_text: str,
    image_bytes: bytes | None,
    image_media_type: str,
    tool_name: str,
    tool_description: str,
    schema: dict,
    system: str,
    label: str,
) -> dict:
    """Provider dispatch + the never-raise contract, shared by both extractors."""
    provider = llm.effective_provider()
    try:
        impl = (
            _extract_openai if provider == "openai"
            else _extract_gemini if provider == "gemini"
            else _extract_anthropic
        )
        fields = await impl(
            client,
            user_text,
            image_bytes,
            image_media_type,
            tool_name=tool_name,
            tool_description=tool_description,
            schema=schema,
            system=system,
        )
    except Exception:
        log.exception("%s extraction failed (provider=%s)", label, provider)
        return {}

    return _clean(fields)


# ---------------------------------------------------------------------------
# Prescription labels — the "photo in, filled form out" path
# ---------------------------------------------------------------------------
# Deliberately its own tool and schema rather than a widened _MED_ITEM. The
# profile extractor's live consumer is the onboarding wizard's profile form, and
# its system prompt is written for clinic records; a prescription needs `times`,
# `duration_days` and `instructions`, which are meaningless in a discharge
# summary. Additive, so /profile/extract and its callers are untouched.
_RX_TOOL_NAME = "record_prescription"
_RX_TOOL_DESCRIPTION = (
    "Record the structured prescription fields read from a photo of a medication "
    "label, box, or printed prescription."
)

# NOTE for anyone copying from the walkthrough code: `times` here is a real JSON
# array. This is a structured HTTP tool result, not tools/walkthrough.py's
# str()-coercing `params` path, so the comma-separated-string workaround that
# add_prescription_auto needs does NOT apply and must not be introduced here.
_RX_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "Medication name exactly as printed."},
        "dose": {
            "type": "string",
            "description": (
                "Strength or amount PER DOSE as printed, e.g. '500mg', '2 tablets', "
                "'1 drop in each eye'. OMIT THIS FIELD ENTIRELY if the label does not "
                "state it — never supply a typical, usual or assumed amount."
            ),
        },
        "purpose": {
            "type": "string",
            "description": "What it treats, if the label says so.",
        },
        "times": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Concrete 24h clock times as HH:MM. Convert the printed frequency: "
                "'every 8 hours' -> 08:00,16:00,00:00; 'three times a day' -> "
                "08:00,13:00,20:00; 'twice daily' -> 08:00,20:00; 'at night' -> 21:00."
            ),
        },
        "frequency": {
            "type": "string",
            "description": "The cadence in the label's own words, e.g. 'twice daily'.",
        },
        "duration_days": {
            "type": "integer",
            "description": (
                "Course length in days when the label states a FIXED period ('for 5 "
                "days', 'two week course'). Omit for an ongoing prescription."
            ),
        },
        "instructions": {
            "type": "string",
            "description": (
                "Any 'with food' / 'at night' / 'shake well' note printed on the label."
            ),
        },
        "inferred": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Names of the fields in THIS object you DERIVED rather than read "
                "verbatim off the label — e.g. `times` worked out from a stated "
                "frequency. The app marks these for the person to check. NEVER list "
                "`dose` here: omit the dose instead of guessing it."
            ),
        },
    },
}

_RX_SYSTEM = (
    "You read a photo of a medication label, box, or printed prescription and "
    "return its details as structured fields, so an app can PRE-FILL a form the "
    f"person reviews and confirms. Call the {_RX_TOOL_NAME} tool.\n"
    "Fill in everything the label actually prints. Where you had to work a value "
    "out rather than read it (turning a stated frequency into clock times, for "
    "instance), still provide it, and name that field in `inferred`.\n"
    "Omit any field the label does not give you — do not guess it. The dose is "
    "the strict case: if no amount per dose is printed, leave `dose` out entirely "
    "rather than supplying a usual or typical amount, and never name it in "
    "`inferred`. This data is safety-sensitive."
)


async def extract_prescription_fields(
    client,
    *,
    image_bytes: bytes | None = None,
    image_media_type: str = "image/jpeg",
    pdf_text: str | None = None,
) -> dict:
    """Return structured prescription fields read from a label photo or PDF text.

    Same contract as ``extract_profile_fields``: ``{}`` when there is nothing to
    read or the model returns no structured call, and never raises.
    """
    has_text = bool((pdf_text or "").strip())
    if image_bytes is None and not has_text:
        return {}

    user_text = (
        "Here is the text of the person's prescription. Read it and extract the "
        f"prescription fields.\n\n{pdf_text.strip()}"
        if has_text
        else "Here is a photo of the person's medication label. Read it and extract "
        "the prescription fields."
    )

    return await _run_extraction(
        client,
        user_text=user_text,
        image_bytes=image_bytes,
        image_media_type=image_media_type,
        tool_name=_RX_TOOL_NAME,
        tool_description=_RX_TOOL_DESCRIPTION,
        schema=_RX_SCHEMA,
        system=_RX_SYSTEM,
        label="prescription",
    )


def _clean(fields) -> dict:
    """Drop empty/None values so the client only sees fields worth pre-filling."""
    if not isinstance(fields, dict):
        return {}
    out: dict = {}
    for key, value in fields.items():
        if value in (None, "", [], {}):
            continue
        out[key] = value
    return out


# ---------------------------------------------------------------------------
# Anthropic (Claude) — forced single tool_use
# ---------------------------------------------------------------------------
async def _extract_anthropic(
    client, user_text, image_bytes, image_media_type, *, tool_name, tool_description, schema, system
) -> dict:
    settings = get_settings()
    content: list[dict] = []
    if image_bytes is not None:
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_media_type,
                    "data": base64.standard_b64encode(image_bytes).decode(),
                },
            }
        )
    content.append({"type": "text", "text": user_text})

    tool = {"name": tool_name, "description": tool_description, "input_schema": schema}
    response = await client.messages.create(
        model=settings.anthropic_model,
        max_tokens=_MAX_TOKENS,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool_name},
        messages=[{"role": "user", "content": content}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == tool_name:
            return dict(block.input or {})
    return {}


# ---------------------------------------------------------------------------
# OpenAI — forced single function call
# ---------------------------------------------------------------------------
async def _extract_openai(
    client, user_text, image_bytes, image_media_type, *, tool_name, tool_description, schema, system
) -> dict:
    settings = get_settings()
    user_content: list[dict] = []
    if image_bytes is not None:
        data = base64.standard_b64encode(image_bytes).decode()
        user_content.append(
            {"type": "image_url", "image_url": {"url": f"data:{image_media_type};base64,{data}"}}
        )
    user_content.append({"type": "text", "text": user_text})

    tools = [
        {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": tool_description,
                "parameters": schema,
            },
        }
    ]
    response = await client.chat.completions.create(
        model=settings.openai_model,
        max_tokens=_MAX_TOKENS,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        tools=tools,
        tool_choice={"type": "function", "function": {"name": tool_name}},
    )
    msg = response.choices[0].message
    if msg.tool_calls:
        try:
            return json.loads(msg.tool_calls[0].function.arguments or "{}")
        except json.JSONDecodeError:
            log.warning("openai extraction returned unparsable arguments")
    return {}


# ---------------------------------------------------------------------------
# Gemini — forced single function call (mode=ANY)
# ---------------------------------------------------------------------------
async def _extract_gemini(
    client, user_text, image_bytes, image_media_type, *, tool_name, tool_description, schema, system
) -> dict:
    from google.genai import types

    # Reuse loop.py's Anthropic-schema -> Gemini typed-Schema converter.
    from .loop import _to_gemini_schema

    settings = get_settings()
    parts = []
    if image_bytes is not None:
        parts.append(types.Part.from_bytes(data=image_bytes, mime_type=image_media_type))
    parts.append(types.Part.from_text(text=user_text))

    decl = types.FunctionDeclaration(
        name=tool_name,
        description=tool_description,
        parameters=_to_gemini_schema(schema),
    )
    config = types.GenerateContentConfig(
        system_instruction=system,
        max_output_tokens=_MAX_TOKENS,
        tools=[types.Tool(function_declarations=[decl])],
        tool_config=types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(
                mode="ANY", allowed_function_names=[tool_name]
            )
        ),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    response = await client.aio.models.generate_content(
        model=settings.gemini_model,
        contents=[types.Content(role="user", parts=parts)],
        config=config,
    )
    candidates = getattr(response, "candidates", None) or []
    for cand in candidates:
        content = getattr(cand, "content", None)
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if fc and fc.name == tool_name:
                return dict(fc.args or {})
    return {}
