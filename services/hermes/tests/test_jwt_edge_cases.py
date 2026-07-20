"""Adversarial coverage for db/auth.py::verify_jwt, driven through /agent/turn's
``body.jwt`` field (the real production entry point for client-supplied JWTs).

No network / JWKS calls: ``hermes.db.auth._get_jwks_client`` is monkeypatched
wherever the asymmetric branch needs to be reached.
"""

from __future__ import annotations

import json
import time

import httpx
import jwt
from jwt.utils import base64url_decode, base64url_encode

import hermes.api.routes as routes
import hermes.db.auth as auth
from fakes import FakeSupabase
from hermes.config import get_settings
from hermes.main import create_app
from hermes.ratelimit import SlidingWindowLimiter

JWT_SECRET = "unit-test-jwt-secret-that-is-long-enough-for-hs256"
ELDER = "00000000-0000-0000-0000-00000000000a"


def _make_app(monkeypatch):
    async def fake_turn(client, ctx, message, *, image_bytes=None, history=None, **_):
        return "ok", [], history or []

    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    s = get_settings()
    monkeypatch.setattr(s, "supabase_jwt_secret", JWT_SECRET, raising=False)
    monkeypatch.setattr(s, "hermes_strict_auth", False, raising=False)
    monkeypatch.setattr(s, "rate_limit_enabled", False, raising=False)

    app = create_app()
    app.state.rate_limiter = SlidingWindowLimiter()
    app.state.http_sessions = {}
    app.state.supabase = FakeSupabase()
    app.state.llm_client = None
    app.state.telegram = None
    return app


def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


def _sign(payload: dict, alg: str = "HS256") -> str:
    return jwt.encode(payload, JWT_SECRET, algorithm=alg)


def _mutate_header_alg(token: str, new_alg: str) -> str:
    """Base64url-decode the JOSE header segment, edit only the declared "alg",
    and reassemble with the original payload+signature segments untouched (so
    the signature no longer matches the (now-mismatched) claimed alg)."""
    header_b64, payload_b64, sig_b64 = token.split(".")
    header = json.loads(base64url_decode(header_b64.encode()))
    header["alg"] = new_alg
    new_header_b64 = base64url_encode(json.dumps(header).encode()).decode()
    return f"{new_header_b64}.{payload_b64}.{sig_b64}"


async def test_expired_jwt_is_rejected_with_generic_detail(monkeypatch):
    """Regression test for Round 1 fix #6 (no raw exception string leaked)."""
    app = _make_app(monkeypatch)
    now = int(time.time())
    token = _sign({
        "sub": ELDER, "role": "authenticated", "aud": "authenticated",
        "iat": now - 7200, "exp": now - 3600,  # expired an hour ago
    })

    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "jwt": token})

    assert resp.status_code == 401
    detail = resp.json()["detail"]
    assert detail == "invalid jwt"
    # Must not leak the raw pyjwt exception text (e.g. "Signature has expired").
    assert "expired" not in detail.lower()
    assert "signature" not in detail.lower()


async def test_wrong_audience_jwt_is_rejected(monkeypatch):
    app = _make_app(monkeypatch)
    now = int(time.time())
    token = _sign({
        "sub": ELDER, "role": "authenticated", "aud": "some-other-audience",
        "iat": now, "exp": now + 3600,
    })

    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "jwt": token})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "invalid jwt"


async def test_missing_audience_jwt_is_rejected(monkeypatch):
    app = _make_app(monkeypatch)
    now = int(time.time())
    token = _sign({
        "sub": ELDER, "role": "authenticated", "iat": now, "exp": now + 3600,
    })  # no "aud" claim at all

    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "jwt": token})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "invalid jwt"


async def test_alg_confusion_header_mutation_is_rejected(monkeypatch):
    """An HS256-signed token whose JOSE header is mutated post-hoc to claim
    "ES256" must NOT be accepted via the asymmetric branch. The signature no
    longer matches the (now-claimed) alg, so a real JWKS client would fail to
    validate it; we simulate that by having the (mocked) JWKS client raise
    PyJWKClientError, and assert the failure surfaces as a clean 401 rather
    than, say, an unhandled 500 or — worse — a bypass."""
    app = _make_app(monkeypatch)
    now = int(time.time())
    token = _sign({
        "sub": ELDER, "role": "authenticated", "aud": "authenticated",
        "iat": now, "exp": now + 3600,
    }, alg="HS256")
    confused = _mutate_header_alg(token, "ES256")
    assert jwt.get_unverified_header(confused)["alg"] == "ES256"

    class _FakeJWKSClient:
        def get_signing_key_from_jwt(self, token):
            raise jwt.PyJWKClientError("no matching signing key found")

    monkeypatch.setattr(auth, "_get_jwks_client", lambda: _FakeJWKSClient())

    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "jwt": confused})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "invalid jwt"


async def test_wrong_issuer_is_currently_accepted_documented_gap(monkeypatch):
    """DOCUMENTED, NOT FIXED (pinning test, matches how Round 1 pinned the
    elder_id-rotation bypass in test_ratelimit.py): ``verify_jwt`` performs no
    ``iss`` check, so a validly-signed token asserting an arbitrary/wrong
    "iss" claim (e.g. a different Supabase project's URL) is accepted as-is.

    This is a low-severity, accepted gap: exploiting it requires the attacker
    to already hold valid HS256 signing credentials for *this* Supabase
    project (the shared JWT secret) or a JWKS-trusted asymmetric key — at
    which point "iss" is not doing any real access-control work, since they
    could mint a token with the "correct" iss anyway. Pinned here so a future
    change to add issuer validation has a clear regression signal to update.
    """
    app = _make_app(monkeypatch)
    now = int(time.time())
    token = _sign({
        "sub": ELDER, "role": "authenticated", "aud": "authenticated",
        "iss": "https://totally-different-project.supabase.co/auth/v1",
        "iat": now, "exp": now + 3600,
    })

    async with _client(app) as c:
        resp = await c.post("/agent/turn", json={"message": "hi", "jwt": token})

    # Currently accepted — no iss check exists in verify_jwt.
    assert resp.status_code == 200
