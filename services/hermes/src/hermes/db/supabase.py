"""Thin async PostgREST wrapper for Supabase.

Two client flavours:

* ``user_client(elder_id)`` — calls Supabase *as the user* by attaching a minted
  JWT, so **RLS is enforced**. Used for every elder-owned read/write.
* ``service_client()`` — uses the service-role key (bypasses RLS). Used **only**
  for reference-table writes (``drug_cache``) and signed-URL generation, never on
  the interactive read path.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..config import get_settings
from .auth import mint_user_jwt


class PostgrestError(RuntimeError):
    """Raised when a PostgREST request returns a non-2xx status."""


class SupabaseClient:
    """A minimal PostgREST client bound to one set of auth headers."""

    def __init__(self, http: httpx.AsyncClient, headers: dict[str, str]):
        self._http = http
        self._headers = headers

    async def select(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: dict[str, str] | None = None,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {"select": columns}
        if filters:
            params.update(filters)
        if order:
            params["order"] = order
        if limit is not None:
            params["limit"] = str(limit)
        resp = await self._http.get(
            f"/rest/v1/{table}", params=params, headers=self._headers
        )
        _raise_for_status(resp)
        return resp.json()

    async def insert(
        self, table: str, row: dict[str, Any], *, returning: bool = True
    ) -> list[dict[str, Any]]:
        headers = dict(self._headers)
        headers["Prefer"] = "return=representation" if returning else "return=minimal"
        resp = await self._http.post(
            f"/rest/v1/{table}", json=row, headers=headers
        )
        _raise_for_status(resp)
        return resp.json() if returning else []

    async def update(
        self,
        table: str,
        patch: dict[str, Any],
        *,
        filters: dict[str, str],
        returning: bool = True,
    ) -> list[dict[str, Any]]:
        headers = dict(self._headers)
        headers["Prefer"] = "return=representation" if returning else "return=minimal"
        resp = await self._http.patch(
            f"/rest/v1/{table}", params=filters, json=patch, headers=headers
        )
        _raise_for_status(resp)
        return resp.json() if returning else []


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code >= 300:
        raise PostgrestError(
            f"PostgREST {resp.request.method} {resp.request.url.path} "
            f"-> {resp.status_code}: {resp.text}"
        )


class Supabase:
    """Owns the shared ``httpx.AsyncClient`` and hands out scoped clients."""

    def __init__(self) -> None:
        settings = get_settings()
        self._settings = settings
        self._http = httpx.AsyncClient(base_url=settings.supabase_url, timeout=20.0)

    async def aclose(self) -> None:
        await self._http.aclose()

    def user_client(self, elder_id: str) -> SupabaseClient:
        token = mint_user_jwt(elder_id)
        return SupabaseClient(
            self._http,
            {
                "apikey": self._settings.supabase_anon_key,
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )

    def service_client(self) -> SupabaseClient:
        key = self._settings.supabase_service_role_key
        return SupabaseClient(
            self._http,
            {
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
        )
