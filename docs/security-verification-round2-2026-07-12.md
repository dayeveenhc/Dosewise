# Security Verification — Round 2 — 2026-07-12

Extends the same-day Round 1 pass (`docs/security-verification-2026-07-12.md`).
Round 1 fixed 6 issues found via subagent-divided, live-exploit-then-fix
testing. This round covers the attack surfaces Round 1's own exploration
flagged as untested but out of scope, plus the one concrete unaddressed
hardening gap from Round 1 (the body-size ceiling). Same methodology: an
isolated local Supabase (never the hosted project), 3 parallel subagent
tracks, each asserting secure behavior and proving it live.

**Outcome: clean bill of health.** Unlike Round 1, no new vulnerabilities were
found — every write/UPDATE RLS boundary, Storage bucket policy, API-key gate,
Telegram webhook guard, and JWT edge case tested came back CONFIRMED-SAFE. One
real fix landed anyway: the request-body-size ceiling Round 1 measured but
didn't close.

## Method

- Fresh isolated local Supabase (migrations `0001`–`0005`, including Round
  1's `care_links` fix). The same local-only baseline-grant workaround from
  Round 1 was needed again for this new instance — this time the harness
  correctly required a **fresh** confirmation rather than carrying forward
  Round 1's authorization automatically (scoped per-instance, as it should
  be); the user re-authorized it for this instance specifically.
- 3 parallel tracks, each writing tests that assert secure behavior and run
  them for real before reporting a result.
- One sequential, coordinator-owned fix (not a subagent): the body-size
  middleware, since it's small and touches shared files.

## Findings

### Track D — API-key gate, Telegram webhook route, JWT edge cases — all CONFIRMED-SAFE (except one pre-existing, documented gap)

| Item | Disposition |
|---|---|
| `require_api_key` (no header / wrong-length / correct-length-wrong-value / correct value / unset-default-no-op) | CONFIRMED-SAFE |
| `/telegram/webhook` HTTP route (secret mismatch → 403, match → 200, unset → passes, `telegram=None` → 503, per-IP rate limit applies) | CONFIRMED-SAFE |
| Expired JWT → generic 401 (regression-tests Round 1's fix #6) | CONFIRMED-SAFE |
| Wrong/missing `aud` claim → 401 | CONFIRMED-SAFE |
| Alg-confusion probe (HS256 token relabeled ES256 in its header) → 401, not a bypass | CONFIRMED-SAFE |
| No `iss` (issuer) claim check exists in `verify_jwt` | **DOCUMENTED-NOT-FIXED** — same disposition as Round 1's `elder_id`-rotation bypass. Low severity: exploiting it requires an attacker already holding valid signing credentials for this project or a JWKS-trusted key, at which point `iss` isn't providing meaningful additional control. |

New files: `tests/test_apikey.py`, `tests/test_jwt_edge_cases.py`; extended `tests/test_telegram.py` (+6 tests).

### Track E — RLS write/UPDATE boundaries (refills, doctor_questions, conversation_turns, profiles) — all CONFIRMED-SAFE

For each of `refills`/`doctor_questions`/`conversation_turns`: an unlinked
caregiver cannot INSERT or UPDATE another elder's rows; a linked caregiver
can (positive control, proving the read-only Round-1-tested surface wasn't
accidentally over- or under-restricted on the write side). For `profiles`:
inserting a row with someone else's `id` is rejected; a linked caregiver
cannot UPDATE the elder's profile (by design — `profiles_update_self` has no
caregiver branch, unlike the other tables) but can still SELECT it.

12 new tests added to `tests/test_rls_integration.py`, all passing (20/20 in
the file total, including Round 1's 8). No RLS gap found — no new migration
needed.

### Track F — Storage bucket policies (pill-photos, videos) — all CONFIRMED-SAFE

First-ever test of these policies under a real, non-service-role caller (via
a new authenticated Storage helper mirroring `Supabase.user_client`'s header
construction, since `upload_object` is service-role-only). Findings:

- Owner and linked-caregiver upload/read both work as intended.
- An unlinked caregiver's read of another elder's photo comes back as
  Storage's own "object not found" (400/`not_found`) rather than an explicit
  403 — the RLS-filtered SELECT doesn't leak existence of the object.
- An unlinked caregiver's upload attempt into another elder's folder is
  rejected (403 "new row violates row-level security policy"); confirmed
  nothing landed.
- **No delete policy exists anywhere for `storage.objects`** (confirmed
  absent from both `0003_storage.sql` and `0004_rls_hardening.sql`) — tested
  whether this actually holds under Supabase Storage's own engine (separate
  from PostgREST). It does: an owner's own DELETE attempt is rejected (403
  "Access denied"), object confirmed to survive. Storage's engine
  independently defaults to deny-on-no-policy, the same net effect as
  `0004`'s explicit restrictive-deny pattern on tables — just implicit
  rather than written down. **Not a live vulnerability**, but worth
  eventually codifying explicitly for documentation parity with `0004` (not
  done in this pass — no fix needed since nothing failed).
- A malformed folder path (non-UUID first segment) fails with a Postgres
  cast error (400 `InvalidParameter`) from the policy's
  `(storage.foldername(name))[1]::uuid` expression — the anticipated failure
  mode, confirmed.
- `videos` bucket: read-all/write-none split behaves as designed.

New file: `tests/test_storage_rls.py` (7 tests, all passing).

### The one real fix: request-body-size ceiling

Round 1 measured (didn't fix) unbounded per-request memory growth — no
size limit existed anywhere in the stack. Fixed via `services/hermes/src/
hermes/api/bodylimit.py`'s `MaxBodySizeMiddleware`, wired into `main.py`.

**Why not another `@app.middleware("http")`** (the pattern the existing rate
limiter uses): verified directly against the installed `starlette` package
that `BaseHTTPMiddleware`'s `_CachedRequest.wrapped_receive` replays an
**empty body** downstream if a dispatch function consumes `Request.stream()`
directly rather than fully buffering via `Request.body()` first — which
would defeat the point of a size guard (buffering the whole thing before
checking its size). Had to be a raw ASGI middleware class instead.

Two enforcement paths: a declared `Content-Length` over the limit (default
25MB) is rejected with a clean `413` before any byte is read; a
streaming/chunked body with no declared length is capped incrementally as
bytes arrive. One nuance, verified and documented in the code: if the
oversized body is consumed via FastAPI's own `request.body()`/`request.json()`
during route-parameter parsing, FastAPI's routing (`fastapi/routing.py`) wraps
that in a bare `except Exception` and re-raises as a generic `HTTPException(400,
"There was an error parsing the body")` before our exception ever unwinds back
to our own middleware — so the streaming-without-declared-length path
surfaces as `400`, not `413`. The security property that actually matters
(immediate abort, no full buffering past the limit, route handler never
runs) holds either way; only the exact status code differs by path.

**Before/after, re-running the same load-test probe from Round 1:**

| Payload | Before (Round 1) | After (Round 2) |
|---|---|---|
| 10MB decoded (13.3MB base64, under the 25MB limit) | 200, +77MB peak RSS | 200, +77MB peak RSS (unaffected — legitimate small uploads unchanged) |
| 50MB decoded (66.7MB base64, over the limit) | 200, +133MB peak RSS, memory kept growing | **413**, escalation stopped immediately — the ceiling now actually holds |

New file `tests/test_bodylimit.py` (3 tests): oversized declared
`Content-Length` rejected before the route handler runs; an under-limit
request is unaffected (guards against the `_CachedRequest` empty-body-replay
bug ever being reintroduced); a chunked body with no declared length is still
capped (returns 400 via the FastAPI-routing path described above, documented
in the test itself).

## Confirmed safe by direct code inspection (no test needed)

`channels/scheduler.py::_tick`'s `_elder_quiet_hours`/`_taken_today` helpers
only ever receive `elder_id` values sourced from an unscoped, service-role
`medications` scan inside the same tick — there is no reachable external
(HTTP/Telegram) path that injects an arbitrary `elder_id` into these
service-role-backed helpers. Verified by direct read, not by test.

## Full regression check

- `uv run ruff check .` — 11 pre-existing lint findings remain (all in files
  untouched by either round: `agent/extract.py`, `tools/medications.py`,
  `test_profile_extract.py`, `api/routes.py:55`), 0 new. The lint issues this
  round's new test files introduced (line length, a mutable-default-argument
  smell, an unused loop variable) were fixed.
- `uv run pytest -q -m "not integration"` — **204 passed** (up from Round 1's
  185; +19 new offline tests across Track D and the body-size fix).
- `RUN_INTEGRATION=1 uv run pytest -q -m integration` — **27 passed** (up
  from Round 1's 8; +12 from Track E, +7 from Track F).
- pm2 (`hermes`, `hermes-demo`, `hermes-git-sync`) confirmed untouched
  throughout — same PIDs and restart counts before and after.

## Files changed

- `services/hermes/src/hermes/api/bodylimit.py` (new)
- `services/hermes/src/hermes/main.py` (wire in the middleware)
- `services/hermes/src/hermes/config.py` (`hermes_max_body_bytes`)
- `services/hermes/tests/test_apikey.py`, `test_jwt_edge_cases.py`,
  `test_storage_rls.py`, `test_bodylimit.py` (new)
- `services/hermes/tests/test_telegram.py`, `test_rls_integration.py`
  (extended)

## Follow-ups (unchanged from Round 1, still open)

Applying migrations to the hosted Supabase project + `pm2 restart hermes` +
`bash scripts/post.sh`; confirming real prod `.env` `HERMES_STRICT_AUTH`/
`HERMES_API_KEY` values; the pending-invite approve/deny UX (deferred product
scope); the `elder_id`-rotation bypass (deployment-config fix, not code).
New from this round: consider codifying Storage's implicit delete-deny as an
explicit policy for documentation parity with `0004` (not urgent — nothing is
currently broken).
