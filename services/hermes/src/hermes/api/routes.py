"""HTTP surface: health, the agent-turn contract, and the Telegram webhook."""

from __future__ import annotations

import base64

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from ..agent.loop import run_agent_turn
from ..channels.session import SessionState
from ..channels.telegram import handle_update
from ..config import get_settings
from ..db.auth import verify_jwt
from ..tools import ToolContext

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


class AgentTurnResponse(BaseModel):
    reply: str
    tools_used: list[str]


@router.post("/agent/turn", response_model=AgentTurnResponse)
async def agent_turn(body: AgentTurnRequest, request: Request) -> AgentTurnResponse:
    app = request.app.state
    settings = get_settings()

    if body.jwt:
        try:
            elder_id = verify_jwt(body.jwt)["sub"]
        except Exception as exc:
            raise HTTPException(status_code=401, detail=f"invalid jwt: {exc}") from exc
    else:
        elder_id = body.elder_id or settings.dev_default_elder_id

    image_bytes = base64.b64decode(body.image_base64) if body.image_base64 else None
    # Reuse (or create) this elder's persistent session so pending_proposal and the
    # message history carry across requests — otherwise scan-propose-confirm can
    # never complete over HTTP and every turn starts with no memory.
    state = app.http_sessions.get(elder_id)
    if state is None:
        state = SessionState(elder_id)
        app.http_sessions[elder_id] = state
    ctx = ToolContext(supabase=app.supabase, elder_id=elder_id, session=state)
    reply, tools_used, state.messages = await run_agent_turn(
        app.llm_client, ctx, body.message, image_bytes=image_bytes, history=state.messages
    )
    return AgentTurnResponse(reply=reply, tools_used=tools_used)


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
    )
    return {"ok": True}
