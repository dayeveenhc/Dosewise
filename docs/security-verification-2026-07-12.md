# Security / RLS / Rate-Limit / API Load-Test Verification — 2026-07-12

A verification pass on the Dosewise/Hermes stack: three parallel subagent
tracks (RLS security, rate limiting, load testing) empirically confirmed six
findings against an isolated local Supabase instance and the offline test
suite. All six were fixed and re-verified in the same pass. The hosted
Supabase project and the pm2-managed prod processes (`hermes`, `hermes-demo`)
were never touched — confirmed by PID/restart-count comparison before and
after.

## Method

- Stood up an isolated local Supabase (`npx supabase@latest start` + `db
  reset`, project-scoped Docker containers, no `supabase link`) so RLS
  exploits could be proven live without touching the hosted project or real
  patient-shaped data.
- Three parallel subagents each wrote failing-then-passing tests: assert the
  *secure* behavior, run it now (a failure proves the vulnerability is real),
  fix the code, re-run (now passes).
- One environment-only complication surfaced and was resolved with explicit
  user authorization — see **Environment note** below.

## Findings

### 1. `care_links` self-grant (High) — FIXED

Any authenticated user could insert `care_links {elder_id: <victim>,
caregiver_id: <self>}` with no elder consent — the INSERT policy only checked
`auth.uid() = caregiver_id`, and `status` defaulted to `'active'`. This
instantly granted full RLS-based read/write over the victim elder's
medications, doses, refills, doctor_questions, conversation_turns, profile,
and pill-photos.

- **Live reproduction (before fix):** `tests/test_rls_integration.py::test_care_links_self_grant_active_is_rejected` — FAILED, confirming an unlinked caregiver could self-grant an active link and read the victim's medications.
- **Fix:** `supabase/migrations/0005_care_links_consent_hardening.sql` — `status` now defaults to `'pending'`; `care_links_insert_as_caregiver`'s check now requires `status = 'pending'`, so a self-inserted row can never land active.
- **Re-verification (after fix):** same test — PASSED.
- **Scope note (per explicit user decision):** this is RLS-only hardening. No approve/deny endpoint was built for pending invites — nothing in the app today reads/writes `care_links` except read-only tool code, so this is a deferred, separate piece of product work, not silently invented here.

### 2. `care_links` un-revoke (High) — FIXED

A caregiver whose link was revoked could immediately PATCH the same row back
to `status = 'active'` themselves — the UPDATE policy applied the same
`elder_id OR caregiver_id` check on both sides with no restriction on which
party could drive which transition.

- **Live reproduction (before fix):** `test_care_links_caregiver_cannot_self_reactivate` — FAILED with `update_result=[{...'status': 'active'...}]` — the revoked caregiver's own PATCH request actually reactivated their link.
- **Fix:** same migration — split `care_links_update_party` into `care_links_update_by_elder` (elder retains unrestricted control of their own row) and `care_links_update_by_caregiver` (`with check (auth.uid() = caregiver_id and status = 'revoked')` — a caregiver can only ever move a row to revoked, never back to active). A comment in the migration explains why these must stay two separate permissive policies rather than being merged back into one.
- **Re-verification (after fix):** PASSED.

### 3. `/profile/extract` has zero rate limiting (High, cost exposure) — FIXED

`/profile/extract` calls a paid vision LLM, is reachable pre-account (no JWT
by design), and was absent from `main.py`'s `_RATE_LIMITED_PATHS` — its
handler never called `limiter.check(...)` at all.

- **Live reproduction (before fix):** `test_profile_extract_has_no_rate_limit_ceiling` — 10/10 requests returned 200, no 429 ever appeared. Track C's load test additionally quantified this under real concurrency: thousands of requests in a 5-second sustained burst, 100% 200s.
- **Fix:** `main.py` — `/profile/extract` added to `_RATE_LIMITED_PATHS`, so it now shares the coarse per-IP ceiling (`RATE_LIMIT_HTTP_PER_MINUTE`, default 60/min) — the natural fit since it has no JWT/elder_id of its own for a per-user tier.
- **Re-verification (after fix):** unit test PASSED; load-test re-run confirms it under real concurrency too — burst of 200 now shows 60 allowed / 140 → 429 (70% error rate), sustained load shows 60 allowed / ~22k → 429 (99.7%), both matching the per-IP ceiling exactly.

### 4. `/agent/turn` per-user cap bypassable by rotating `elder_id` (Medium) — DOCUMENTED, NOT FIXED

When `HERMES_STRICT_AUTH=False` (the default), `elder_id` is a raw
client-supplied string, and the per-user turn cap is keyed by
`f"turn:{elder_id}"` — rotating it per request gets a fresh budget each time,
leaving only the shared per-IP ceiling.

- **Live reproduction:** `test_agent_turn_elder_id_rotation_bypasses_per_user_cap` — PASSES today as a pinning/documentation test (written to assert the current, accepted behavior, not to go red).
- **Disposition:** not fixed in this pass. Rate-limiting by an IP+elder_id tuple isn't a real fix (the attacker controls both); the actual mitigation is a deployment decision — set `HERMES_STRICT_AUTH=1` on any internet-exposed deployment, which removes the client's ability to supply an unverified `elder_id` at all. This is an existing, already-tested config default (`test_ratelimit.py::test_strict_auth_requires_jwt`), not new code.
- **Residual risk:** real, but bounded by the shared per-IP ceiling (default 60/min) unless the deployment is also missing rate limiting entirely.

### 5. Unguarded `base64.b64decode` → bare 500 (Medium) — FIXED

`base64.b64decode(...)` calls in both `/agent/turn` and `/profile/extract`
ran outside any try/except, unlike the rest of each handler, which
deliberately catches broad `Exception` and returns a friendly 200.

- **Live reproduction (before fix):** `test_base64_decode_error_is_friendly_not_500` — FAILED, malformed base64 raised `binascii.Error: Incorrect padding` uncaught, producing a bare 500.
- **Fix:** `api/routes.py` — both handlers' decode logic (image + PDF) wrapped in try/except, matching the codebase's existing friendly-error convention (log server-side via `log.exception`, return the same response shape the rest of the handler already uses on failure).
- **Re-verification (after fix):** PASSED — both endpoints now return 200 with a friendly reply/note.

### 6. JWT verification error leaks raw exception text (Low) — FIXED

`raise HTTPException(status_code=401, detail=f"invalid jwt: {exc}")` echoed
the raw PyJWT/PyJWKClient exception string (e.g. "Signature has expired",
"Not enough segments") in the 401 response body.

- **Live reproduction (before fix):** `test_jwt_invalid_error_detail_is_generic` — FAILED with `body='{"detail":"invalid jwt: Not enough segments"}'`.
- **Fix:** `api/routes.py` — generic `detail="invalid jwt"`, with `log.warning("jwt verification failed: %s", exc)` added so the real reason is still visible server-side.
- **Re-verification (after fix):** PASSED.

## Load-test results (Track C, in-process, zero LLM/Supabase cost)

- **Rate limiter under real concurrency:** engages cleanly and immediately — `/agent/turn`'s per-user cap (default 12/min) holds exactly at 12 allowed regardless of burst (200 concurrent) or sustained (20 workers × 5s, ~20k+ attempts) load.
- **Body-size / memory exposure (unfixed, documented as residual risk):** no request-body-size limit exists anywhere in the stack (FastAPI/Starlette, Caddy, pm2, docker-compose all confirmed absent). Sending 10MB/50MB/100MB base64 payloads showed peak RSS growth of +77MB / +134MB / +317MB respectively, with 64–183MB per request never returned to the OS even after `gc.collect()` — memory ratchets upward across repeated large-payload requests. Not yet a demonstrated crash at the sizes safely tested on this shared box (bottomed at 1.9GB available, recovered after); the true failure ceiling is higher than what was safe to probe here. **Not fixed in this pass** — flagged as a follow-up (a request body-size limit, e.g. at the reverse-proxy or FastAPI layer, is the natural fix).

## Environment note (a false-alarm worth recording)

During Track A's run, the harness's security classifier flagged (and
correctly blocked, twice) an attempt to run `GRANT ... ALL TABLES` +
`ALTER DEFAULT PRIVILEGES` on the local Supabase container. Investigation
confirmed the command was scoped only to the throwaway local Docker
container (`supabase_db_dosewise`, a project-local Docker volume with no
remote connection) — never the hosted project or anything backing the live
pm2 `hermes` process — and it never executed (verified directly via `\dp`
before and after: privileges were unchanged). The underlying issue was real
and separate from any RLS bug: a fresh Supabase-CLI-provisioned local
Postgres has no baseline table GRANTs for `anon`/`authenticated`/
`service_role` (only `Dxt`), which blocks PostgREST with a 403 *before* RLS
is ever evaluated — a gap in the local dev-tooling story, not present on the
hosted project (which provisions these automatically), and not a
vulnerability in the app itself. With the user's explicit authorization,
these baseline grants were applied to the local container only, which is
what allowed findings #1 and #2 above to be proven live rather than left as
static-analysis-only. Worth a note in `MEMORY.md` so a future session
attempting local Supabase CLI integration testing doesn't re-diagnose this
from scratch.

## Prod posture — could not be determined from permitted sources

`pm2 env`/`pm2 show hermes` (read-only, no secret values read) does not
expose `HERMES_STRICT_AUTH`/`HERMES_API_KEY` directly — Hermes loads these
from the repo-root `.env`, which is out of scope to read under this task's
constraints. **Someone with access to `/opt/dosewise/.env` should confirm
`HERMES_STRICT_AUTH=1` is actually set for the real prod `hermes` process**
— finding #4's residual risk (identity spoofing via client-supplied
`elder_id`) is only fully closed when that flag is on, and the finding
report above cannot confirm today's real-world posture either way.

## Follow-ups (not done in this pass, by design)

1. Apply migration `0005_care_links_consent_hardening.sql` to the **hosted**
   Supabase project, then `pm2 restart hermes` + `bash scripts/post.sh` —
   deliberately not done automatically here, per the plan's isolation
   requirement from prod/hosted infrastructure.
2. Decide on and build a pending-invite approve/deny flow (product scope,
   explicitly deferred per user decision above).
3. Confirm real `HERMES_STRICT_AUTH`/`HERMES_API_KEY` values in the prod
   `.env` directly.
4. Consider a request body-size limit (the unbounded-payload memory finding
   above) — not fixed in this pass.
5. Add `MEMORY.md` note about the local-Supabase-CLI baseline-grants gap so
   it isn't re-diagnosed by a future session.

## Files changed

- `supabase/migrations/0005_care_links_consent_hardening.sql` (new)
- `services/hermes/src/hermes/main.py` (`_RATE_LIMITED_PATHS`)
- `services/hermes/src/hermes/api/routes.py` (base64 try/except ×2, generic JWT error detail)
- `services/hermes/tests/test_rls_integration.py` (+3 tests)
- `services/hermes/tests/test_ratelimit.py` (+3 tests)
- `services/hermes/tests/loadtest/loadtest_inprocess.py`, `loadtest_bodysize_probe.py` (new)

Full offline suite: 185 passed. RLS integration suite (local instance): 8
passed, 0 failed (up from 5 passed / 3 failed pre-fix).
