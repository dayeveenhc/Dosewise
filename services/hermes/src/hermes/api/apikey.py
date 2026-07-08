"""Optional shared-secret guard for instances exposed outside the trusted
network (e.g. a demo Hermes tunneled publicly via ngrok).

No-op when ``settings.hermes_api_key`` is unset, so this has zero effect on
the default/prod configuration.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException

from ..config import get_settings


async def require_api_key(x_hermes_api_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    if not settings.hermes_api_key:
        return
    if not x_hermes_api_key or not hmac.compare_digest(x_hermes_api_key, settings.hermes_api_key):
        raise HTTPException(status_code=401, detail="invalid api key")
