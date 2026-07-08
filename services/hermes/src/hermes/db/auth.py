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


# Modern Supabase projects sign user access tokens with an asymmetric key
# (ES256/RS256) published at the project's JWKS endpoint; the legacy shared
# secret only covers HS256. Cache the JWKS client — it caches keys internally.
_ASYMMETRIC_ALGS = {"ES256", "RS256"}
_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        settings = get_settings()
        _jwks_client = jwt.PyJWKClient(
            f"{settings.supabase_project_url}/auth/v1/.well-known/jwks.json"
        )
    return _jwks_client


def verify_jwt(token: str) -> dict:
    """Verify a client-supplied Supabase JWT (the real ``/agent/turn`` path).

    Supports both signing schemes Supabase uses: legacy HS256 (the project's
    shared JWT secret — also how ``mint_user_jwt`` signs) and the newer
    asymmetric keys (ES256/RS256) verified against the project's JWKS.

    Returns the decoded claims. Raises ``jwt.InvalidTokenError`` on failure.
    """
    alg = jwt.get_unverified_header(token).get("alg")
    if alg in _ASYMMETRIC_ALGS:
        key = _get_jwks_client().get_signing_key_from_jwt(token).key
        return jwt.decode(token, key, algorithms=[alg], audience="authenticated")
    settings = get_settings()
    return jwt.decode(
        token,
        settings.supabase_jwt_secret,
        algorithms=[_ALGORITHM],
        audience="authenticated",
    )
