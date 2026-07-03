#!/usr/bin/env python3
"""Provision the Dosewise seed users + data on a HOSTED Supabase project.

The local `supabase/seed/seed.sql` inserts directly into `auth.users`, which only
works against a local Supabase. A hosted project won't let you write `auth.users`
by SQL, so this script does the equivalent through the supported paths:

  1. Creates the three fixed-UUID users via the GoTrue **Admin API**
     (`POST /auth/v1/admin/users`, which accepts an explicit `id`).
  2. Upserts `profiles`, `care_links`, `medications`, `doses`, and a little
     reference data via **PostgREST** using the service-role key (bypasses RLS).

It mirrors `seed.sql` exactly — same UUIDs, same rows — so `DEV_DEFAULT_ELDER_ID`
and every FK line up. Safe to re-run (idempotent: user creation tolerates
"already exists"; table writes use upsert / select-guard).

Usage:
    # reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the repo-root .env
    uv run --with httpx python supabase/scripts/provision_hosted.py
    # or: python supabase/scripts/provision_hosted.py   (if httpx is installed)

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env or the environment).
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import httpx

# --- Fixed identities (mirror supabase/seed/seed.sql) ------------------------
ELDER_A = "00000000-0000-0000-0000-00000000000a"
ELDER_B = "00000000-0000-0000-0000-00000000000b"
CAREGIVER_C = "00000000-0000-0000-0000-00000000000c"

USERS = [
    {"id": ELDER_A, "email": "elder.a@dosewise.local", "full_name": "Elder A"},
    {"id": ELDER_B, "email": "elder.b@dosewise.local", "full_name": "Elder B"},
    {"id": CAREGIVER_C, "email": "caregiver.c@dosewise.local", "full_name": "Caregiver C"},
]
SEED_PASSWORD = "password"  # LOCAL/DEMO ONLY — rotate for anything real.

PROFILES = [
    {"id": ELDER_A, "role": "elder", "full_name": "Elder A", "dialect": "hokkien",
     "accessibility": {"font_scale": 1.5, "tts_default": True}},
    {"id": ELDER_B, "role": "elder", "full_name": "Elder B", "dialect": "tamil",
     "accessibility": {"font_scale": 1.25, "tts_default": True}},
    {"id": CAREGIVER_C, "role": "caregiver", "full_name": "Caregiver C", "dialect": "en",
     "accessibility": {"font_scale": 1.0, "tts_default": False}},
]

CARE_LINKS = [
    # C is ACTIVE caregiver for A only. No link to B => the RLS isolation proof.
    {"id": "00000000-0000-0000-0000-0000000c0a01", "elder_id": ELDER_A,
     "caregiver_id": CAREGIVER_C, "relationship": "daughter",
     "permissions": {"view_meds": True, "view_doses": True,
                     "quiet_hours": {"start": "22:00", "end": "07:00"},
                     "alert_on_missed_critical": True},
     "status": "active"},
]

MEDICATIONS = [
    {"id": "00000000-0000-0000-0000-00000a0e0d01", "elder_id": ELDER_A,
     "name": "Metformin", "purpose": "Blood sugar control", "dosage": "500mg",
     "schedule": {"times": ["08:00", "20:00"], "frequency": "daily"},
     "priority": "critical",
     "instructions": "Take after a meal — it works better and is gentler on your stomach."},
    {"id": "00000000-0000-0000-0000-00000a0e0d02", "elder_id": ELDER_A,
     "name": "Vitamin D3", "purpose": "Bone health", "dosage": "1000 IU",
     "schedule": {"times": ["08:00"], "frequency": "daily"}, "priority": "vitamin",
     "instructions": "Take once in the morning with breakfast."},
    {"id": "00000000-0000-0000-0000-00000b0e0d01", "elder_id": ELDER_B,
     "name": "Amlodipine", "purpose": "Blood pressure", "dosage": "5mg",
     "schedule": {"times": ["09:00"], "frequency": "daily"}, "priority": "standard",
     "instructions": "Take once a day, morning is best. It helps keep blood pressure steady."},
]

DOSES = [
    {"id": "00000000-0000-0000-0000-00000a0d0501", "medication_id": "00000000-0000-0000-0000-00000a0e0d01",
     "elder_id": ELDER_A, "scheduled_at": "2026-07-02 08:00:00+00", "status": "taken"},
    {"id": "00000000-0000-0000-0000-00000a0d0502", "medication_id": "00000000-0000-0000-0000-00000a0e0d01",
     "elder_id": ELDER_A, "scheduled_at": "2026-07-02 20:00:00+00", "status": "pending"},
    {"id": "00000000-0000-0000-0000-00000a0d0503", "medication_id": "00000000-0000-0000-0000-00000a0e0d02",
     "elder_id": ELDER_A, "scheduled_at": "2026-07-02 08:00:00+00", "status": "taken"},
    {"id": "00000000-0000-0000-0000-00000b0d0501", "medication_id": "00000000-0000-0000-0000-00000b0e0d01",
     "elder_id": ELDER_B, "scheduled_at": "2026-07-02 09:00:00+00", "status": "pending"},
]

DIALECT_LEXICON = [
    {"dialect": "hokkien", "term": "pang sai", "normalized_en": "bowel movement",
     "mapping": {"category": "symptom"}},
    {"dialect": "tamil", "term": "maruthuvam", "normalized_en": "medicine",
     "mapping": {"category": "general"}},
]

INSTRUCTION_VIDEOS = [
    {"title": "How to use eye drops", "technique": "eye_drops",
     "storage_path": "videos/eye_drops.mp4", "drug_match": []},
    {"title": "How to use an inhaler", "technique": "inhaler",
     "storage_path": "videos/inhaler.mp4", "drug_match": []},
]


def _load_env() -> tuple[str, str]:
    """Read SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env wins over repo .env)."""
    repo_root = Path(__file__).resolve().parents[2]
    env_path = repo_root / ".env"
    values: dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.split("#", 1)[0].strip()
    url = os.environ.get("SUPABASE_URL") or values.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or values.get(
        "SUPABASE_SERVICE_ROLE_KEY", ""
    )
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env or env).")
    return url.rstrip("/"), key


async def _create_users(client: httpx.AsyncClient, headers: dict[str, str]) -> None:
    for user in USERS:
        payload = {
            "id": user["id"],
            "email": user["email"],
            "password": SEED_PASSWORD,
            "email_confirm": True,
            "user_metadata": {"full_name": user["full_name"]},
            "app_metadata": {"provider": "email", "providers": ["email"]},
        }
        resp = await client.post("/auth/v1/admin/users", json=payload, headers=headers)
        if resp.status_code in (200, 201):
            print(f"  created auth user {user['email']}")
        elif resp.status_code in (409, 422) or "already" in resp.text.lower():
            print(f"  auth user {user['email']} already exists — skipping")
        else:
            sys.exit(f"  FAILED to create {user['email']}: {resp.status_code} {resp.text}")


async def _upsert(
    client: httpx.AsyncClient, headers: dict[str, str], table: str,
    rows: list[dict], *, on_conflict: str,
) -> None:
    resp = await client.post(
        f"/rest/v1/{table}",
        params={"on_conflict": on_conflict},
        json=rows,
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    if resp.status_code >= 300:
        sys.exit(f"  FAILED upsert {table}: {resp.status_code} {resp.text}")
    print(f"  upserted {len(rows)} row(s) into {table}")


async def _insert_if_absent(
    client: httpx.AsyncClient, headers: dict[str, str], table: str,
    rows: list[dict], *, match: str,
) -> None:
    """For reference tables with no unique constraint: insert only if `match`
    column value isn't already present."""
    existing = await client.get(
        f"/rest/v1/{table}", params={"select": match}, headers=headers
    )
    seen = {r[match] for r in existing.json()} if existing.status_code < 300 else set()
    fresh = [r for r in rows if r[match] not in seen]
    if not fresh:
        print(f"  {table} already populated — skipping")
        return
    resp = await client.post(
        f"/rest/v1/{table}", json=fresh,
        headers={**headers, "Prefer": "return=minimal"},
    )
    if resp.status_code >= 300:
        sys.exit(f"  FAILED insert {table}: {resp.status_code} {resp.text}")
    print(f"  inserted {len(fresh)} row(s) into {table}")


async def main() -> None:
    url, service_key = _load_env()
    rest_headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    admin_headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    print(f"Provisioning hosted Supabase at {url}")
    async with httpx.AsyncClient(base_url=url, timeout=30.0) as client:
        print("auth.users (Admin API):")
        await _create_users(client, admin_headers)
        print("domain tables (PostgREST, service role):")
        await _upsert(client, rest_headers, "profiles", PROFILES, on_conflict="id")
        await _upsert(client, rest_headers, "care_links", CARE_LINKS, on_conflict="elder_id,caregiver_id")
        await _upsert(client, rest_headers, "medications", MEDICATIONS, on_conflict="id")
        await _upsert(client, rest_headers, "doses", DOSES, on_conflict="id")
        print("reference tables:")
        await _insert_if_absent(client, rest_headers, "dialect_lexicon", DIALECT_LEXICON, match="term")
        await _insert_if_absent(client, rest_headers, "instruction_videos", INSTRUCTION_VIDEOS, match="technique")
    print("Done. Caregiver C can read Elder A (linked) but not Elder B (unlinked).")


if __name__ == "__main__":
    asyncio.run(main())
