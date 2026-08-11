"""HTTP surface: health, the agent-turn contract, and the Telegram webhook."""

from __future__ import annotations

import asyncio
import base64
import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..agent.extract import extract_prescription_fields, extract_profile_fields
from ..agent.loop import run_agent_turn
from ..agent.tts import AUDIO_MEDIA_TYPE, synthesize_reply
from ..agent.tts import available as tts_available
from ..channels.pdf import extract_pdf_text
from ..channels.session import SessionState
from ..channels.telegram import handle_update
from ..config import get_settings
from ..db.auth import verify_jwt
from ..ratelimit import turn_tiers
from ..tools import ToolContext
from .apikey import require_api_key

router = APIRouter()

log = logging.getLogger("hermes.api")


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "hermes"}


class AgentTurnRequest(BaseModel):
    message: str
    # Production: the client forwards its Supabase JWT. Dev: pass elder_id directly.
    jwt: str | None = None
    elder_id: str | None = None
    image_base64: str | None = None
    # Several photos on ONE turn — the web composer lets someone attach a few
    # pages of a prescription (or both sides of a box) and ask about them
    # together. Additive: `image_base64` above still works on its own and is
    # what the Telegram channel sends, so this is purely the list form for
    # callers that have more than one. When both arrive the list wins.
    images_base64: list[str] | None = None
    # Text-based PDF (e.g. a clinic report); extracted server-side and folded into
    # the message, same as the Telegram document path.
    pdf_base64: str | None = None
    # The language the client wants Mei to reply in (from the app's "Voice &
    # Language" setting). Optional; None keeps the agent's default behaviour.
    reply_language: str | None = None
    # Walkthrough task_names the client has already recorded as completed for this
    # user (from profiles.accessibility.completedWalkthroughs) — so Mei doesn't
    # re-offer a walkthrough already done. Client-supplied, stateless on Hermes,
    # same trust model as reply_language.
    completed_walkthroughs: list[str] = []
    # Which app shell is asking: "elder" (default) or "caregiver". The two
    # shells render entirely different screens, so a walkthrough offered to the
    # wrong one can only ever spotlight elements that don't exist there.
    # Client-supplied and stateless, same trust model as reply_language;
    # Telegram omits it and gets the elder default, correct for that channel.
    app_role: str | None = None


class AgentTurnResponse(BaseModel):
    reply: str
    tools_used: list[str]
    # Writes the agent actually committed this turn (name + short summary), so the
    # client can confirm and navigate to the page that shows the change. Empty on
    # a propose turn (nothing saved yet).
    actions: list[dict] = []
    # Set when start_walkthrough was called this turn — {"task_name": str,
    # "params": dict[str, str], "risk"?: {"flagged": bool, "signals": [str],
    # "reasons": [str]}} — so the client can mount the spotlight overlay.
    # "signals" is a stable per-axis code (e.g. "dosage_jump"), same
    # order/length as "reasons"' human-readable prose — match on "signals" to
    # key any client behaviour off a SPECIFIC risk axis, never on "reasons"
    # text (tools/risk.py's module docstring explains why). "risk"
    # (tools/risk.py::assess_risk) is present ONLY for the *_auto family this
    # dispatch actually risk-assesses (tools/walkthrough.py::
    # RISK_ASSESSED_TASKS); every other task_name carries no "risk" key at
    # all. None on every other turn. (Untyped `dict` on purpose — this is a
    # straight passthrough of ctx.walkthrough, so a new key added there reaches
    # the client with no change needed here; this comment is what must stay
    # in sync instead.)
    walkthrough: dict | None = None
    # Set when offer_choices was called this turn — [{"label", "value"}] — so the
    # client can render tappable answer buttons under the reply. None otherwise.
    choices: list[dict] | None = None
    # True when a tool PROPOSED something this turn and is waiting on a yes/no
    # (session.awaiting_confirmation — the same signal Telegram uses to attach its
    # ✅/✖ keyboard, channels/telegram.py). Deterministic, unlike `choices` above,
    # which only appears if the model elects to call offer_choices. The web client
    # synthesizes its own localized Yes/No buttons from this when `choices` is
    # empty, so a confirm is never a "type the word yes" dead end.
    awaiting_confirmation: bool = False
    # Set when raise_alert fired this turn — {"severity", "title", "body",
    # "medication_name"}. The web client shows it as a full-screen popup that
    # still reaches the person after they leave the chat, which is the point:
    # this is for something they must act on today. Not a write, like
    # `walkthrough`/`choices`. Telegram ignores it (the tool's return text is
    # what the model says there).
    alert: dict | None = None


def _authenticate_and_check_rate_limit(
    body: AgentTurnRequest, request: Request, *, bucket: str = "turn"
) -> tuple[str, object]:
    """Resolve elder_id from the JWT (or dev fallback) and enforce the per-user
    turn rate limit. Raises HTTPException on failure. Shared by /agent/turn and
    /agent/turn/stream so the two auth paths can't silently diverge — and by
    /voice/tts, which only needs the auth half plus its OWN ``bucket`` (reading
    a reply aloud must not eat the allowance for asking the next question).
    Only ``body.jwt``/``body.elder_id`` are read, so any request model carrying
    those two fields fits."""
    app = request.app.state
    settings = get_settings()

    if body.jwt:
        try:
            elder_id = verify_jwt(body.jwt)["sub"]
        except Exception as exc:
            log.warning("jwt verification failed: %s", exc)
            raise HTTPException(status_code=401, detail="invalid jwt") from exc
    elif settings.hermes_strict_auth:
        # Strict prod posture: no verified JWT means no identity — refuse rather
        # than mint a token for a caller-supplied elder_id (impersonation).
        raise HTTPException(status_code=401, detail="jwt required")
    else:
        elder_id = body.elder_id or settings.dev_default_elder_id

    # Per-user cap on expensive agent turns (the coarse per-IP ceiling is applied
    # by the HTTP middleware in main.py).
    limiter = getattr(app, "rate_limiter", None)
    if settings.rate_limit_enabled and limiter is not None:
        allowed, retry_after = limiter.check(f"{bucket}:{elder_id}", turn_tiers(settings))
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="rate limit exceeded",
                headers={"Retry-After": str(int(retry_after) + 1)},
            )
    return elder_id, app


# Hard ceiling on photos per turn. Each one is a full vision input sent on every
# iteration of the agent loop, so this bounds both the request body and the
# per-turn token spend regardless of what a client asks for. The web composer
# caps itself lower (lib/images.ts MAX_ATTACHMENTS) so a person never watches a
# photo attach and then silently not arrive.
_MAX_IMAGES_PER_TURN = 6


def _prepare_message(
    body: AgentTurnRequest, elder_id: str
) -> tuple[str, list[bytes]] | AgentTurnResponse:
    """Decode any attachment and fold PDF text into the message text. Returns an
    early AgentTurnResponse for the friendly-nudge / decode-failure cases (never
    raises), so both call sites just check the return type."""
    try:
        raw_images = body.images_base64 or ([body.image_base64] if body.image_base64 else [])
        if len(raw_images) > _MAX_IMAGES_PER_TURN:
            log.warning(
                "dropping %d image(s) over the per-turn cap for elder_id=%s",
                len(raw_images) - _MAX_IMAGES_PER_TURN,
                elder_id,
            )
            raw_images = raw_images[:_MAX_IMAGES_PER_TURN]
        images = [base64.b64decode(raw) for raw in raw_images if raw]

        message = body.message
        if body.pdf_base64:
            pdf_text = extract_pdf_text(base64.b64decode(body.pdf_base64))
            if not pdf_text:
                # Scanned/image-only PDF — mirror the Telegram channel's graceful
                # nudge instead of burning an LLM turn on empty content.
                return AgentTurnResponse(
                    reply=(
                        "I couldn't read that PDF (it may be a scan). Could you send a "
                        "clear photo of the page instead?"
                    ),
                    tools_used=[],
                )
            message = (
                f"{message or 'Here is my document.'}\n\n"
                f"[Attached PDF contents]\n{pdf_text}\n[End of PDF]"
            )
    except Exception:
        log.exception("failed to decode attachment for elder_id=%s", elder_id)
        return AgentTurnResponse(
            reply="Sorry, I'm having trouble right now. Please try again in a moment.",
            tools_used=[],
        )
    return message, images


def _build_context(
    app, elder_id: str, images: list[bytes], app_role: str | None = None
) -> tuple[ToolContext, SessionState]:
    """Reuse (or create) this elder's persistent session so pending_proposal and the
    message history carry across requests — otherwise scan-propose-confirm can
    never complete over HTTP and every turn starts with no memory."""
    state = app.http_sessions.get(elder_id)
    if state is None:
        state = SessionState(elder_id)
        app.http_sessions[elder_id] = state
    # Tie a just-uploaded photo to this session so add_prescription's propose→
    # confirm flow can persist it to the pill-photos bucket (same as the Telegram
    # channel). Without this the web path analyses the image for vision but never
    # saves it, so the confirmed medication has no photo. The tool consumes this
    # slot at propose time and binds it to the matched proposal only.
    #
    # Deliberately still a SINGLE image even when several arrive: this slot
    # exists only so one pill photo can be stored against the medication that
    # gets confirmed, and a medication row has one pill_photo_path. Every
    # attachment is still shown to the model for vision — that path is the
    # `images` list handed to run_agent_turn, not this one.
    if images:
        state.pending_image = images[0]
    # Per-TURN on the web. The propose→confirm guards live entirely in the
    # pending_* slots (tools/base.py::match_pending), never in this flag, so
    # clearing it here makes it mean exactly "a tool proposed something during
    # THIS turn" — which is what the client needs to decide whether to paint
    # Yes/No buttons. Left sticky it would sit true across every later turn
    # (nothing on the web path clears it; _clear_pending is Telegram-only) and
    # paint a confirm affordance under replies that asked nothing. A "yes" typed
    # two turns later still commits, because that reads the stashed proposal.
    # Telegram is untouched: it runs off app.state.registry, not http_sessions.
    state.awaiting_confirmation = False
    ctx = ToolContext(
        supabase=app.supabase,
        elder_id=elder_id,
        session=state,
        app_role=app_role or "elder",
    )
    return ctx, state


@router.post(
    "/agent/turn", response_model=AgentTurnResponse, dependencies=[Depends(require_api_key)]
)
async def agent_turn(body: AgentTurnRequest, request: Request) -> AgentTurnResponse:
    elder_id, app = _authenticate_and_check_rate_limit(body, request)

    prepared = _prepare_message(body, elder_id)
    if isinstance(prepared, AgentTurnResponse):
        return prepared
    message, images = prepared

    ctx, state = _build_context(app, elder_id, images, body.app_role)
    try:
        reply, tools_used, state.messages = await run_agent_turn(
            app.llm_client,
            ctx,
            message,
            images=images,
            history=state.messages,
            reply_language=body.reply_language,
            completed_walkthroughs=body.completed_walkthroughs,
            app_role=body.app_role,
        )
    except Exception:
        # A provider/DB error mid-turn used to surface as a bare HTTP 500, which
        # the browser then hid behind its own generic fallback — the real cause
        # vanished. Log it server-side and return a friendly, honest reply so the
        # failure is both visible (here) and clear to the user (not "understood").
        log.exception("agent turn failed for elder_id=%s", elder_id)
        return AgentTurnResponse(
            reply="Sorry, I'm having trouble right now. Please try again in a moment.",
            tools_used=[],
        )
    # ctx.committed_actions/ctx.walkthrough are populated by tools that actually
    # acted this turn (a fresh ctx per request means neither ever carries over).
    return AgentTurnResponse(
        reply=reply,
        tools_used=tools_used,
        actions=ctx.committed_actions,
        walkthrough=ctx.walkthrough,
        choices=ctx.choices,
        alert=ctx.alert,
        awaiting_confirmation=bool(getattr(state, "awaiting_confirmation", False)),
    )


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


@router.post("/agent/turn/stream", dependencies=[Depends(require_api_key)])
async def agent_turn_stream(body: AgentTurnRequest, request: Request) -> StreamingResponse:
    """Same contract as /agent/turn, but streams a `tool_start`/`tool_end` SSE
    event per tool call as the agent loop runs, ending with a `final` event
    carrying the same fields as AgentTurnResponse. Added alongside (not
    replacing) /agent/turn — existing callers are unaffected."""
    elder_id, app = _authenticate_and_check_rate_limit(body, request)

    prepared = _prepare_message(body, elder_id)
    if isinstance(prepared, AgentTurnResponse):
        async def _early_events():
            yield _sse({"type": "final", **prepared.model_dump()})

        return StreamingResponse(_early_events(), media_type="text/event-stream")
    message, images = prepared

    ctx, state = _build_context(app, elder_id, images, body.app_role)
    queue: asyncio.Queue = asyncio.Queue()

    async def on_event(event: dict) -> None:
        await queue.put(event)

    async def run() -> None:
        try:
            reply, tools_used, state.messages = await run_agent_turn(
                app.llm_client,
                ctx,
                message,
                images=images,
                history=state.messages,
                reply_language=body.reply_language,
                completed_walkthroughs=body.completed_walkthroughs,
                app_role=body.app_role,
                on_event=on_event,
            )
            await queue.put(
                {
                    "type": "final",
                    "reply": reply,
                    "tools_used": tools_used,
                    "actions": ctx.committed_actions,
                    "walkthrough": ctx.walkthrough,
                    "choices": ctx.choices,
                    "alert": ctx.alert,
                    "awaiting_confirmation": bool(
                        getattr(state, "awaiting_confirmation", False)
                    ),
                }
            )
        except Exception:
            log.exception("agent turn (stream) failed for elder_id=%s", elder_id)
            # Same KEY SET as the success branch above — this used to omit
            # `choices` entirely, so the two `final` shapes diverged and the
            # client only survived it by defaulting a missing key. Nothing may
            # render a confirm affordance under an error reply.
            await queue.put(
                {
                    "type": "final",
                    "reply": "Sorry, I'm having trouble right now. Please try again in a moment.",
                    "tools_used": [],
                    "actions": [],
                    "walkthrough": None,
                    "choices": None,
                    "alert": None,
                    "awaiting_confirmation": False,
                }
            )
        finally:
            await queue.put(None)  # sentinel: no more events

    async def events():
        task = asyncio.create_task(run())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield _sse(event)
        finally:
            await task

    return StreamingResponse(events(), media_type="text/event-stream")


class ProfileExtractRequest(BaseModel):
    # A photo of a report/label (vision input) or a text-based PDF (extracted
    # server-side). No jwt: extraction is stateless — it reads a document and
    # returns fields, touching no per-user data — so it works during onboarding
    # before an account exists. Still API-key gated + IP rate-limited.
    image_base64: str | None = None
    pdf_base64: str | None = None


class ProfileExtractResponse(BaseModel):
    # Structured fields read from the record (snake_case; see agent/extract.py).
    # Empty when nothing could be read. `note` carries a friendly reason (e.g. a
    # scanned PDF with no text layer) so the client can prompt for a photo.
    fields: dict = {}
    note: str | None = None


def _sniff_image_media_type(data: bytes) -> str:
    """Best-effort content sniff so PNG/WebP/GIF aren't mislabelled as JPEG (the
    browser strips the data-URL mime before upload)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] in (b"GIF8",):
        return "image/gif"
    return "image/jpeg"


@router.post(
    "/profile/extract",
    response_model=ProfileExtractResponse,
    dependencies=[Depends(require_api_key)],
)
async def profile_extract(body: ProfileExtractRequest, request: Request) -> ProfileExtractResponse:
    app = request.app.state

    try:
        image_bytes = base64.b64decode(body.image_base64) if body.image_base64 else None
        image_media_type = _sniff_image_media_type(image_bytes) if image_bytes else "image/jpeg"

        pdf_text: str | None = None
        if body.pdf_base64:
            pdf_text = extract_pdf_text(base64.b64decode(body.pdf_base64))
            if not pdf_text and image_bytes is None:
                # Scanned/image-only PDF and no photo to fall back on — same nudge
                # as /agent/turn, but without burning an LLM call.
                return ProfileExtractResponse(
                    fields={},
                    note=(
                        "I couldn't read that PDF (it may be a scan). Could you upload a "
                        "clear photo of the page instead?"
                    ),
                )
    except Exception:
        log.exception("failed to decode attachment in profile_extract")
        return ProfileExtractResponse(fields={}, note="Sorry, I couldn't read that just now.")

    if image_bytes is None and not (pdf_text or "").strip():
        return ProfileExtractResponse(fields={}, note="No readable document was provided.")

    try:
        fields = await extract_profile_fields(
            app.llm_client,
            image_bytes=image_bytes,
            image_media_type=image_media_type,
            pdf_text=pdf_text,
        )
    except Exception:
        log.exception("profile extract failed")
        return ProfileExtractResponse(fields={}, note="Sorry, I couldn't read that just now.")

    return ProfileExtractResponse(fields=fields)


class PrescriptionExtractRequest(BaseModel):
    image_base64: str | None = None
    pdf_base64: str | None = None
    # Optional, exactly like /profile/extract: the add-prescription sheet always
    # has a session, but keeping it optional means the same endpoint can serve a
    # pre-account flow later, and a jwt-less call must not trip strict-auth.
    # When present it buys a per-USER rate-limit bucket on top of the per-IP one
    # main.py applies to every route.
    jwt: str | None = None
    elder_id: str | None = None


class PrescriptionExtractResponse(BaseModel):
    fields: dict = {}
    note: str | None = None


@router.post(
    "/prescription/extract",
    response_model=PrescriptionExtractResponse,
    dependencies=[Depends(require_api_key)],
)
async def prescription_extract(
    body: PrescriptionExtractRequest, request: Request
) -> PrescriptionExtractResponse:
    """Read a medication label into structured fields the app pre-fills a form with.

    The "pull" sibling of /profile/extract, and deliberately NOT the chat loop:
    one shot, no tools that write, no DB access. The person confirms by saving
    the form, which is where the human-in-the-loop rail lives on this path.
    """
    app = request.app.state
    if body.jwt:
        # Its own bucket: reading a label must not eat the allowance for the
        # next chat turn, same reasoning as /voice/tts.
        _authenticate_and_check_rate_limit(body, request, bucket="extract")

    try:
        image_bytes = base64.b64decode(body.image_base64) if body.image_base64 else None
        image_media_type = _sniff_image_media_type(image_bytes) if image_bytes else "image/jpeg"

        pdf_text: str | None = None
        if body.pdf_base64:
            pdf_text = extract_pdf_text(base64.b64decode(body.pdf_base64))
            if not pdf_text and image_bytes is None:
                # Scanned/image-only PDF with no photo to fall back on — nudge
                # without burning an LLM call, same as /profile/extract.
                return PrescriptionExtractResponse(
                    fields={},
                    note=(
                        "I couldn't read that PDF (it may be a scan). Could you take a "
                        "clear photo of the label instead?"
                    ),
                )
    except Exception:
        log.exception("failed to decode attachment in prescription_extract")
        return PrescriptionExtractResponse(
            fields={}, note="Sorry, I couldn't read that just now."
        )

    if image_bytes is None and not (pdf_text or "").strip():
        return PrescriptionExtractResponse(fields={}, note="No readable label was provided.")

    try:
        fields = await extract_prescription_fields(
            app.llm_client,
            image_bytes=image_bytes,
            image_media_type=image_media_type,
            pdf_text=pdf_text,
        )
    except Exception:
        log.exception("prescription extract failed")
        return PrescriptionExtractResponse(
            fields={}, note="Sorry, I couldn't read that just now."
        )

    return PrescriptionExtractResponse(fields=fields)


class VoiceTtsRequest(BaseModel):
    # The reply to speak. Same auth fields as /agent/turn (this reads nothing
    # per-user, but it spends money, so it stays behind a real identity for the
    # rate limiter to key on).
    text: str
    jwt: str | None = None
    elder_id: str | None = None


@router.post("/voice/tts", dependencies=[Depends(require_api_key)])
async def voice_tts(body: VoiceTtsRequest, request: Request) -> Response:
    """Speak a reply in Mei's voice, as mp3.

    503 — not a silent empty body — when no voice is configured: the web client
    treats any non-200 as "fall back to the browser's own speechSynthesis", so
    an honest failure code is what keeps spoken replies working everywhere
    rather than going quiet on a misconfigured deploy.
    """
    _authenticate_and_check_rate_limit(body, request, bucket="tts")

    if not tts_available():
        raise HTTPException(status_code=503, detail="tts not configured")

    audio = await synthesize_reply(body.text)
    if not audio:
        raise HTTPException(status_code=503, detail="tts unavailable")

    return Response(
        content=audio,
        media_type=AUDIO_MEDIA_TYPE,
        # A reply's audio is regenerated per request and never re-fetched; say
        # so rather than letting an intermediary cache someone's medication
        # details as a playable file.
        headers={"Cache-Control": "no-store"},
    )


@router.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict:
    app = request.app.state
    settings = get_settings()
    if settings.telegram_webhook_secret and (
        x_telegram_bot_api_secret_token != settings.telegram_webhook_secret
    ):
        raise HTTPException(status_code=403, detail="bad webhook secret")
    if app.telegram is None:
        raise HTTPException(status_code=503, detail="telegram not configured")

    update = await request.json()
    await handle_update(
        update,
        anthropic=app.llm_client,
        supabase=app.supabase,
        registry=app.registry,
        telegram=app.telegram,
        rate_limiter=getattr(app, "rate_limiter", None),
    )
    return {"ok": True}
