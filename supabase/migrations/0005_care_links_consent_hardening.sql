-- Dosewise — care_links consent hardening
--
-- Closes two RLS gaps in 0002_rls_policies.sql, confirmed by live exploit
-- tests in services/hermes/tests/test_rls_integration.py before this fix:
--
-- 1. care_links_insert_as_caregiver only checked `auth.uid() = caregiver_id`
--    — no elder consent, no status constraint — combined with `status`
--    defaulting to 'active', any authenticated user could self-grant an
--    ACTIVE caregiver link to an arbitrary elder with zero consent.
-- 2. care_links_update_party's using/with-check was symmetric across both
--    parties with no restriction on which party may drive which status
--    transition — a caregiver whose link was revoked could immediately
--    PATCH it back to 'active' themselves.
--
-- This migration only narrows the RLS surface. It intentionally does NOT
-- add an approve/deny endpoint for pending invites (no such route/tool
-- exists in the app today) — that UX remains a deferred follow-up, not
-- invented here.

-- New links must land as 'pending' by default; the elder brings them to
-- 'active' via their own row-owner update right (preserved below).
alter table public.care_links alter column status set default 'pending';

-- ---------------------------------------------------------------------------
-- Fix 1: a caregiver may only create a link naming themselves, landing as
-- 'pending' — never 'active' — so an elder's consent is required before any
-- data access is granted.
-- ---------------------------------------------------------------------------
drop policy if exists care_links_insert_as_caregiver on public.care_links;

create policy care_links_insert_as_caregiver
  on public.care_links for insert
  to authenticated
  with check ( auth.uid() = caregiver_id and status = 'pending' );

-- ---------------------------------------------------------------------------
-- Fix 2: split the single symmetric update policy into two permissive
-- policies. Postgres OR's permissive policies' WITH CHECK clauses together,
-- so a caregiver's own update can never satisfy the "elder" policy's check —
-- the only way a caregiver's update passes is via their own policy, which
-- only ever allows moving status to 'revoked'. The elder keeps unrestricted
-- control over their own row (activate a pending invite, revoke, etc).
--
-- Do NOT merge these back into one policy — that reopens the bug, since a
-- single `(auth.uid() = elder_id or auth.uid() = caregiver_id)` check can't
-- distinguish which party is performing which transition.
-- ---------------------------------------------------------------------------
drop policy if exists care_links_update_party on public.care_links;

create policy care_links_update_by_elder
  on public.care_links for update
  to authenticated
  using ( auth.uid() = elder_id )
  with check ( auth.uid() = elder_id );

create policy care_links_update_by_caregiver
  on public.care_links for update
  to authenticated
  using ( auth.uid() = caregiver_id )
  with check ( auth.uid() = caregiver_id and status = 'revoked' );
