"""Storage RLS proof for the `pill-photos` and `videos` buckets — Track F of
Round 2. Migration 0003_storage.sql defines SELECT/INSERT/UPDATE policies on
`storage.objects` mirroring the owner-or-linked-caregiver predicate used on the
`medications` table, keyed on the object path's first folder segment being the
elder's uuid. There is NO delete policy anywhere for storage.objects (confirmed
absent from 0004_rls_hardening.sql too, which hardens every public.* table's
DELETE but never touches Storage) — so pill-photos delete is implicit-deny-only
and has never been proven against Supabase Storage's actual engine, which is
architecturally separate from PostgREST (Storage enforces RLS via its own
`storage.objects` policies, evaluated by a different code path than the REST
API `hermes.db.supabase.Supabase.service_client/user_client` normally drive).

`upload_object` in `hermes.db.supabase.Supabase` always uses the service role
(bypasses RLS by design — see its docstring and tests/test_service_client_guard.py).
This file adds a *user-authenticated* Storage helper mirroring `user_client`'s
header construction, so it can issue raw Storage API requests as a real
non-service-role caller and observe what Storage's policy engine actually does.

Requires a live, seeded local Supabase (migrations 0001-0005 applied) reachable
at SUPABASE_URL. Run with:

    cd /opt/dosewise/services/hermes && \\
    SUPABASE_URL="http://127.0.0.1:54321" \\
    SUPABASE_ANON_KEY="<local anon key>" \\
    SUPABASE_SERVICE_ROLE_KEY="<local service key>" \\
    SUPABASE_JWT_SECRET="<local jwt secret>" \\
    RUN_INTEGRATION=1 uv run pytest -q -m integration tests/test_storage_rls.py
"""

from __future__ import annotations

import os
import uuid

import httpx
import pytest

from hermes.config import get_settings
from hermes.db.auth import mint_user_jwt
from hermes.db.supabase import Supabase

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Disposable-identity helpers — same pattern as test_rls_integration.py, kept
# local rather than factored into conftest.py since this is the only other
# file needing them so far and duplication here is cheap / self-contained.
# ---------------------------------------------------------------------------


async def _create_disposable_profile(supabase: Supabase, role: str) -> str:
    settings = get_settings()
    email = f"track-f-{uuid.uuid4().hex}@dosewise.local"
    resp = await supabase._http.post(
        "/auth/v1/admin/users",
        json={"email": email, "password": "password", "email_confirm": True},
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": f"Bearer {settings.supabase_service_role_key}",
            "Content-Type": "application/json",
        },
    )
    resp.raise_for_status()
    user_id = resp.json()["id"]
    await supabase.service_client().insert(
        "profiles", {"id": user_id, "role": role, "full_name": f"track-f {role}"}
    )
    return user_id


async def _delete_disposable_profile(supabase: Supabase, user_id: str) -> None:
    settings = get_settings()
    try:
        await supabase._http.delete(
            f"/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
    except Exception:  # noqa: BLE001
        pass


async def _setup_e1_e2_c(supabase: Supabase) -> tuple[str, str, str]:
    """Disposable elder E1, elder E2 (victim), caregiver C linked ACTIVELY to
    E1 only."""
    e1 = await _create_disposable_profile(supabase, "elder")
    e2 = await _create_disposable_profile(supabase, "elder")
    c = await _create_disposable_profile(supabase, "caregiver")
    await supabase.service_client().insert(
        "care_links", {"elder_id": e1, "caregiver_id": c, "status": "active"}
    )
    return e1, e2, c


async def _teardown_e1_e2_c(supabase: Supabase, e1: str, e2: str, c: str) -> None:
    await _delete_disposable_profile(supabase, c)
    await _delete_disposable_profile(supabase, e2)
    await _delete_disposable_profile(supabase, e1)


# ---------------------------------------------------------------------------
# User-authenticated Storage helper — mirrors Supabase.user_client's header
# construction (apikey: anon key, Authorization: Bearer <minted user JWT>) but
# talks to the Storage API (/storage/v1/object/...) instead of PostgREST, and
# is a thin raw-httpx wrapper since Supabase.upload_object always signs with
# the service role (never suitable for this probe).
# ---------------------------------------------------------------------------


class StorageUserClient:
    def __init__(self, http: httpx.AsyncClient, user_id: str):
        settings = get_settings()
        token = mint_user_jwt(user_id)
        self._http = http
        self._headers = {
            "apikey": settings.supabase_anon_key,
            "Authorization": f"Bearer {token}",
        }

    async def upload(
        self, bucket: str, path: str, data: bytes, *, content_type: str = "image/jpeg"
    ) -> httpx.Response:
        headers = dict(self._headers)
        headers["Content-Type"] = content_type
        return await self._http.post(
            f"/storage/v1/object/{bucket}/{path}", content=data, headers=headers
        )

    async def read(self, bucket: str, path: str) -> httpx.Response:
        return await self._http.get(
            f"/storage/v1/object/{bucket}/{path}", headers=self._headers
        )

    async def delete(self, bucket: str, path: str) -> httpx.Response:
        return await self._http.delete(
            f"/storage/v1/object/{bucket}/{path}", headers=self._headers
        )


async def _service_upload(
    supabase: Supabase, bucket: str, path: str, data: bytes, content_type: str = "image/jpeg"
) -> httpx.Response:
    """Seed an object via the service role (bypasses Storage RLS) — used to
    seed the "victim" elder's photo without relying on the user-auth path
    under test."""
    settings = get_settings()
    key = settings.supabase_service_role_key
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    return await supabase._http.post(
        f"/storage/v1/object/{bucket}/{path}", content=data, headers=headers
    )


async def _service_read(supabase: Supabase, bucket: str, path: str) -> httpx.Response:
    settings = get_settings()
    key = settings.supabase_service_role_key
    return await supabase._http.get(
        f"/storage/v1/object/{bucket}/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )


def _is_not_found(resp: httpx.Response) -> bool:
    """This local Storage engine reports "object not found" as HTTP 400 with a
    JSON body `{"statusCode": "404", "error": "not_found", ...}` rather than a
    plain HTTP 404 — confirmed empirically against the running local instance.
    Treat either shape as "does not exist"."""
    if resp.status_code == 404:
        return True
    if resp.status_code == 400:
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            return False
        return body.get("statusCode") == "404" or body.get("error") == "not_found"
    return False


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture
async def supabase():
    if os.environ.get("RUN_INTEGRATION") != "1":
        pytest.skip("set RUN_INTEGRATION=1 (needs a live, seeded local Supabase)")
    supa = Supabase()
    try:
        await supa.service_client().select("profiles", columns="id", limit=1)
    except Exception as exc:  # noqa: BLE001
        await supa.aclose()
        pytest.skip(f"local Supabase not reachable: {exc}")
    yield supa
    await supa.aclose()


def _user_client(supabase: Supabase, user_id: str) -> StorageUserClient:
    return StorageUserClient(supabase._http, user_id)


# ---------------------------------------------------------------------------
# 1. Positive control — owner upload + read.
# ---------------------------------------------------------------------------


async def test_owner_can_upload_and_read_own_pill_photo(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    try:
        elder = _user_client(supabase, e1)
        payload = b"track-f owner photo bytes"
        upload_resp = await elder.upload("pill-photos", f"{e1}/photo.jpg", payload)
        assert upload_resp.status_code in (200, 201), (
            f"owner upload to own folder should succeed, got "
            f"{upload_resp.status_code}: {upload_resp.text}"
        )

        read_resp = await elder.read("pill-photos", f"{e1}/photo.jpg")
        assert read_resp.status_code == 200, (
            f"owner read of own photo should succeed, got "
            f"{read_resp.status_code}: {read_resp.text}"
        )
        assert read_resp.content == payload, "owner read returned mismatched bytes"
    finally:
        await supabase._http.delete(
            f"/storage/v1/object/pill-photos/{e1}/photo.jpg",
            headers={
                "apikey": get_settings().supabase_service_role_key,
                "Authorization": f"Bearer {get_settings().supabase_service_role_key}",
            },
        )
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# ---------------------------------------------------------------------------
# 2. Linked caregiver can upload into / read the elder's folder.
# ---------------------------------------------------------------------------


async def test_linked_caregiver_can_upload_and_read(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    settings = get_settings()
    try:
        elder = _user_client(supabase, e1)
        owner_payload = b"track-f owner photo for caregiver read"
        seed_resp = await elder.upload("pill-photos", f"{e1}/photo.jpg", owner_payload)
        assert seed_resp.status_code in (200, 201), (
            f"setup: owner seed upload failed: {seed_resp.status_code}: {seed_resp.text}"
        )

        caregiver = _user_client(supabase, c)
        caregiver_payload = b"track-f caregiver-uploaded photo"
        upload_resp = await caregiver.upload(
            "pill-photos", f"{e1}/photo2.jpg", caregiver_payload
        )
        assert upload_resp.status_code in (200, 201), (
            f"linked caregiver upload into elder's folder should succeed, got "
            f"{upload_resp.status_code}: {upload_resp.text}"
        )

        read_resp = await caregiver.read("pill-photos", f"{e1}/photo.jpg")
        assert read_resp.status_code == 200, (
            f"linked caregiver read of elder's photo should succeed, got "
            f"{read_resp.status_code}: {read_resp.text}"
        )
        assert read_resp.content == owner_payload
    finally:
        for p in (f"{e1}/photo.jpg", f"{e1}/photo2.jpg"):
            await supabase._http.delete(
                f"/storage/v1/object/pill-photos/{p}",
                headers={
                    "apikey": settings.supabase_service_role_key,
                    "Authorization": f"Bearer {settings.supabase_service_role_key}",
                },
            )
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# ---------------------------------------------------------------------------
# 3. Unlinked caregiver cannot read the victim's photo.
# ---------------------------------------------------------------------------


async def test_unlinked_caregiver_cannot_read_victim_photo(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    settings = get_settings()
    victim_path = f"{e2}/photo.jpg"
    try:
        seed_resp = await _service_upload(
            supabase, "pill-photos", victim_path, b"track-f victim photo"
        )
        assert seed_resp.status_code in (200, 201), (
            f"setup: service-role seed of victim photo failed: "
            f"{seed_resp.status_code}: {seed_resp.text}"
        )

        caregiver = _user_client(supabase, c)
        read_resp = await caregiver.read("pill-photos", victim_path)
        assert read_resp.status_code in (400, 401, 403, 404), (
            "VULNERABILITY CONFIRMED (pill-photos-read): an unlinked caregiver "
            f"read another elder's photo — status {read_resp.status_code}: "
            f"{read_resp.text!r}"
        )
    finally:
        await supabase._http.delete(
            f"/storage/v1/object/pill-photos/{victim_path}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# ---------------------------------------------------------------------------
# 4. Unlinked caregiver cannot upload into the victim's folder.
# ---------------------------------------------------------------------------


async def test_unlinked_caregiver_cannot_upload_into_victim_folder(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    settings = get_settings()
    victim_path = f"{e2}/malicious.jpg"
    try:
        caregiver = _user_client(supabase, c)
        upload_resp = await caregiver.upload(
            "pill-photos", victim_path, b"track-f malicious payload"
        )
        assert upload_resp.status_code not in (200, 201), (
            "VULNERABILITY CONFIRMED (pill-photos-insert): an unlinked "
            f"caregiver's upload into another elder's folder succeeded — "
            f"status {upload_resp.status_code}: {upload_resp.text!r}"
        )

        landed_resp = await _service_read(supabase, "pill-photos", victim_path)
        assert _is_not_found(landed_resp), (
            "VULNERABILITY CONFIRMED (pill-photos-insert): the object landed "
            f"despite a non-2xx upload response — service-role GET returned "
            f"{landed_resp.status_code}: {landed_resp.text!r}"
        )
    finally:
        await supabase._http.delete(
            f"/storage/v1/object/pill-photos/{victim_path}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# ---------------------------------------------------------------------------
# 5. Delete: no policy exists — is it actually denied?
# ---------------------------------------------------------------------------


async def test_delete_is_denied_or_has_no_effect(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    settings = get_settings()
    path = f"{e1}/deleteme.jpg"
    try:
        elder = _user_client(supabase, e1)
        seed_resp = await elder.upload("pill-photos", path, b"track-f delete probe")
        assert seed_resp.status_code in (200, 201), (
            f"setup: owner seed upload failed: {seed_resp.status_code}: {seed_resp.text}"
        )

        delete_resp = await elder.delete("pill-photos", path)

        still_there_resp = await _service_read(supabase, "pill-photos", path)
        object_survives = still_there_resp.status_code == 200

        assert object_survives, (
            "VULNERABILITY CONFIRMED (pill-photos-delete): with NO delete "
            "policy defined on storage.objects for pill-photos, an "
            "authenticated owner's DELETE request "
            f"(status {delete_resp.status_code}: {delete_resp.text!r}) actually "
            "removed the object — Storage's engine does NOT default-deny "
            "DELETE the way table RLS's explicit restrictive-deny policies do. "
            "Proposed fix (NOT applied — requires explicit approval): add a "
            "restrictive DENY-all delete policy on storage.objects, mirroring "
            "0004_rls_hardening.sql's pattern, e.g.:\n"
            "  create policy pill_photos_deny_delete on storage.objects\n"
            "    as restrictive for delete to authenticated using (false);"
        )
    finally:
        await supabase._http.delete(
            f"/storage/v1/object/pill-photos/{path}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# ---------------------------------------------------------------------------
# 6. Malformed folder path (not a uuid) as first segment.
# ---------------------------------------------------------------------------


async def test_malformed_folder_path_is_rejected_or_harmless(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    settings = get_settings()
    path = "not-a-uuid/x.jpg"
    try:
        caregiver = _user_client(supabase, c)
        upload_resp = await caregiver.upload("pill-photos", path, b"track-f malformed path")

        assert upload_resp.status_code not in (200, 201), (
            "VULNERABILITY CONFIRMED (pill-photos-path-validation): an upload "
            f"with a non-uuid first path segment succeeded — status "
            f"{upload_resp.status_code}: {upload_resp.text!r}"
        )

        landed_resp = await _service_read(supabase, "pill-photos", path)
        assert _is_not_found(landed_resp), (
            "VULNERABILITY CONFIRMED (pill-photos-path-validation): object "
            f"landed at malformed path despite non-2xx upload response: "
            f"service-role GET returned {landed_resp.status_code}: "
            f"{landed_resp.text!r}"
        )
    finally:
        await supabase._http.delete(
            f"/storage/v1/object/pill-photos/{path}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
        await _teardown_e1_e2_c(supabase, e1, e2, c)


# ---------------------------------------------------------------------------
# 7. videos bucket sanity.
# ---------------------------------------------------------------------------


async def test_videos_bucket_read_ok_write_denied(supabase):
    e1, e2, c = await _setup_e1_e2_c(supabase)
    settings = get_settings()
    video_path = f"track-f-{uuid.uuid4().hex}.mp4"
    try:
        seed_resp = await _service_upload(
            supabase, "videos", video_path, b"track-f seeded video bytes", content_type="video/mp4"
        )
        assert seed_resp.status_code in (200, 201), (
            f"setup: service-role video seed failed: {seed_resp.status_code}: {seed_resp.text}"
        )

        elder = _user_client(supabase, e1)
        read_resp = await elder.read("videos", video_path)
        assert read_resp.status_code == 200, (
            f"any authenticated user should be able to read a videos object, got "
            f"{read_resp.status_code}: {read_resp.text}"
        )
        assert read_resp.content == b"track-f seeded video bytes"

        upload_resp = await elder.upload(
            "videos", f"track-f-{uuid.uuid4().hex}-attempt.mp4", b"track-f attempted write",
            content_type="video/mp4",
        )
        assert upload_resp.status_code not in (200, 201), (
            "VULNERABILITY CONFIRMED (videos-insert): a plain authenticated "
            "user was able to upload into videos despite no insert policy "
            f"existing there by design — status {upload_resp.status_code}: "
            f"{upload_resp.text!r}"
        )
    finally:
        await supabase._http.delete(
            f"/storage/v1/object/videos/{video_path}",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
            },
        )
        await _teardown_e1_e2_c(supabase, e1, e2, c)
