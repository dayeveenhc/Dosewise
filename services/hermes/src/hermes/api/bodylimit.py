"""Hard cap on request body size.

A pure ASGI middleware class — deliberately NOT the ``@app.middleware("http")``
/ ``BaseHTTPMiddleware`` pattern ``main.py``'s rate limiter uses.
``BaseHTTPMiddleware``'s request-caching wrapper
(``starlette.middleware.base._CachedRequest.wrapped_receive``) replays an
**empty body** to the downstream app once a dispatch function has consumed
``request.stream()`` itself — verified directly against the installed
``starlette`` package. A size guard has to inspect the stream *without* first
buffering the whole thing (buffering defeats the point), so it can't go
through that wrapper; it has to sit at the raw ASGI layer instead.

Closes the gap measured in docs/security-verification-2026-07-12.md: no
request-body-size limit existed anywhere in the stack (confirmed absent from
FastAPI/Starlette config, the deploy proxy configs, pm2, docker-compose).
10/50/100MB payloads showed +77MB/+134MB/+317MB peak RSS growth per request,
with a meaningful chunk never returned to the OS.

Two enforcement paths: a declared Content-Length over the limit is rejected
with a clean 413 before any body byte is read. A streaming/chunked body with
no (or an understated) declared length is capped incrementally as bytes
arrive by raising ``_BodyTooLarge`` from inside ``receive()`` — but note this
second path's HTTP status is NOT guaranteed to be 413: if the oversized
request is consumed via FastAPI's own `request.body()`/`request.json()`
(inside route-parameter parsing), FastAPI's routing wraps that call in a bare
`except Exception` and re-raises as a generic `HTTPException(400, "There was
an error parsing the body")` (fastapi/routing.py, verified against the
installed package) before our exception ever unwinds back out to this
middleware's own except block. The security property that actually matters —
immediate abort with no full buffering past max_bytes, and the route handler
never runs — holds either way; only the exact status code differs depending
on where in the stack the read was aborted.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send


class _BodyTooLarge(Exception):
    pass


class MaxBodySizeMiddleware:
    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or ())
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                declared = None
            if declared is not None and declared > self.max_bytes:
                await self._reject(send)
                return

        total = 0

        async def guarded_receive():
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body") or b"")
                if total > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        try:
            await self.app(scope, guarded_receive, send)
        except _BodyTooLarge:
            await self._reject(send)

    async def _reject(self, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": b'{"detail":"request body too large"}',
            }
        )
