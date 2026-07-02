"""Supabase identity for Hermes.

Production forwards a Supabase-issued JWT from the client. For the CLI / Telegram
test harness there is no client JWT, so Hermes *mints* a short-lived JWT for a
mapped elder, signed with the project's ``SUPABASE_JWT_SECRET``. PostgREST reads
the ``sub`` claim as ``auth.uid()`` and ``role`` as the Postgres role, so every
existing RLS policy applies exactly as if the elder had queried directly.
"""

from __future__ import annotations

import time

import jwt

from ..config import get_settings

_ALGORITHM = "HS256"
_TTL_SECONDS = 3600


def mint_user_jwt(elder_id: str, ttl_seconds: int = _TTL_SECONDS) -> str:
    """Sign a short-lived Supabase-compatible JWT that acts *as* ``elder_id``."""
    settings = get_settings()
    if not settings.supabase_jwt_secret:
        raise RuntimeError(
            "SUPABASE_JWT_SECRET is not set — cannot mint a user token. "
            "Fill it in from `supabase status` (JWT secret)."
        )
    now = int(time.time())
    payload = {
        "sub": elder_id,
        "role": "authenticated",
        "aud": "authenticated",
        "iat": now,
        "exp": now + ttl_seconds,
    }
    return jwt.encode(payload, settings.supabase_jwt_secret, algorithm=_ALGORITHM)


def verify_jwt(token: str) -> dict:
    """Verify a client-supplied Supabase JWT (the real ``/agent/turn`` path).

    Returns the decoded claims. Raises ``jwt.InvalidTokenError`` on failure.
    """
    settings = get_settings()
    return jwt.decode(
        token,
        settings.supabase_jwt_secret,
        algorithms=[_ALGORITHM],
        audience="authenticated",
    )
