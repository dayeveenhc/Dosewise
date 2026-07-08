"""HTTP surface: health, the agent-turn contract, and the Telegram webhook."""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

from ..agent.loop import run_agent_turn
from ..channels.pdf import extract_pdf_text
from ..channels.session import SessionState
from ..channels.telegram import handle_update
from ..config import get_settings
from ..db.auth import verify_jwt
from ..ratelimit import turn_tiers
from ..tools import ToolContext
from .apikey import require_api_key

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "hermes"}


class AgentTurnRequest(BaseModel):
    message: str
    # Production: the client forwards its Supabase JWT. Dev: pass elder_id directly.
    jwt: str | None = None
    elder_id: str | None = None
    image_base64: str | None = None
    # Text-based PDF (e.g. a clinic report); extracted server-side and folded into
    # the message, same as the Telegram document path.
    pdf_base64: str | None = None
    # The language the client wants Mei to reply in (from the app's "Voice &
    # Language" setting). Optional; None keeps the agent's default behaviour.
    reply_language: str | None = None


class AgentTurnResponse(BaseModel):
    reply: str
    tools_used: list[str]
    # Writes the agent actually committed this turn (name + short summary), so the
    # client can confirm and navigate to the page that shows the change. Empty on
    # a propose turn (nothing saved yet).
    actions: list[dict] = []


@router.post("/agent/turn", response_model=AgentTurnResponse, dependencies=[Depends(require_api_key)])
async def agent_turn(body: AgentTurnRequest, request: Request) -> AgentTurnResponse:
    app = request.app.state
    settings = get_settings()

    if body.jwt:
        try:
            elder_id = verify_jwt(body.jwt)["sub"]
        except Exception as exc:
            raise HTTPException(status_code=401, detail=f"invalid jwt: {exc}") from exc
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
        allowed, retry_after = limiter.check(f"turn:{elder_id}", turn_tiers(settings))
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="rate limit exceeded",
                headers={"Retry-After": str(int(retry_after) + 1)},
            )

    image_bytes = base64.b64decode(body.image_base64) if body.image_base64 else None

    message = body.message
    if body.pdf_base64:
        pdf_text = extract_pdf_text(base64.b64decode(body.pdf_base64))
        if not pdf_text:
            # Scanned/image-only PDF — mirror the Telegram channel's graceful nudge
            # instead of burning an LLM turn on empty content.
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

    # Reuse (or create) this elder's persistent session so pending_proposal and the
    # message history carry across requests — otherwise scan-propose-confirm can
    # never complete over HTTP and every turn starts with no memory.
    state = app.http_sessions.get(elder_id)
    if state is None:
        state = SessionState(elder_id)
        app.http_sessions[elder_id] = state
    ctx = ToolContext(supabase=app.supabase, elder_id=elder_id, session=state)
    reply, tools_used, state.messages = await run_agent_turn(
        app.llm_client,
        ctx,
        message,
        image_bytes=image_bytes,
        history=state.messages,
        reply_language=body.reply_language,
    )
    # ctx.committed_actions is populated by write tools that actually saved this
    # turn (a fresh ctx per request means it never carries over).
    return AgentTurnResponse(
        reply=reply, tools_used=tools_used, actions=ctx.committed_actions
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
