"""Thin async PostgREST wrapper for Supabase.

Two client flavours:

* ``user_client(elder_id)`` — calls Supabase *as the user* by attaching a minted
  JWT, so **RLS is enforced**. Used for every elder-owned read/write.
* ``service_client()`` — uses the service-role key (bypasses RLS). Used **only**
  for reference-table writes (``drug_cache``) and signed-URL generation, never on
  the interactive read path.

Because the service role bypasses RLS, its use is deliberately confined. The ONLY
sanctioned call sites (enforced by tests/test_service_client_guard.py) are:
  * ``tools/drug_info.py``      — drug_cache write-through (reference table).
  * ``channels/scheduler.py``   — identity-less cron reads across all elders.
  * ``upload_object`` in ``tools/medications.py`` — pill-photo Storage upload.
Adding a new service-role call site is a security decision: update that guard test
on purpose, don't route interactive elder data through it.
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

    async def delete(
        self, table: str, *, filters: dict[str, str], returning: bool = True
    ) -> list[dict[str, Any]]:
        """DELETE rows matching ``filters``. Under RLS this only removes rows the
        caller may delete — with the restrictive deny policies in migration 0004,
        that is *none* for an authenticated user (returns an empty list, not an
        error). Used by the RLS regression test."""
        headers = dict(self._headers)
        headers["Prefer"] = "return=representation" if returning else "return=minimal"
        resp = await self._http.delete(
            f"/rest/v1/{table}", params=filters, headers=headers
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
        # supabase_project_url tolerates a trailing /rest/v1[/] in SUPABASE_URL —
        # the methods above prepend /rest/v1 themselves, so a suffixed URL would
        # double it (PostgREST PGRST125 "Invalid path").
        self._http = httpx.AsyncClient(base_url=settings.supabase_project_url, timeout=20.0)

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

    async def upload_object(
        self, bucket: str, path: str, data: bytes, *, content_type: str, upsert: bool = True
    ) -> str:
        """Upload bytes to a Storage bucket via the service role (bypasses Storage
        RLS, per migration 0003). Returns the object path. Used for prescription
        photos into ``pill-photos`` after a confirmed scan."""
        key = self._settings.supabase_service_role_key
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type,
        }
        if upsert:
            headers["x-upsert"] = "true"
        resp = await self._http.post(
            f"/storage/v1/object/{bucket}/{path}", content=data, headers=headers
        )
        _raise_for_status(resp)
        return path
