# Dosewise — Session Memory

A chronological log of decisions, gotchas, and non-obvious fixes — the "why"
behind things that aren't derivable from reading the code alone. For the
current-state architecture snapshot, read `CONTEXT.md` first.

Keep entries short and dated. Prune/consolidate stale entries rather than
letting this grow forever — it's a memory aid, not an audit log.

---

## 2026-07-12 (round 2) — Extended security verification: RLS write boundaries, Storage, apikey/telegram/JWT — all clean; body-size limit fixed

Extended the same-day Round 1 pass (below) into the attack surfaces it had
flagged as untested: `refills`/`doctor_questions`/`conversation_turns`/
`profiles` write RLS, Storage bucket policies (`pill-photos`/`videos`),
`require_api_key`, the `/telegram/webhook` HTTP route, and JWT edge cases
(expired, wrong `aud`, alg-confusion, no `iss` check). Full detail:
`docs/security-verification-round2-2026-07-12.md`.

**Result: no new bugs.** Every surface tested came back CONFIRMED-SAFE via
live exploit-attempt-then-fail tests, except the already-known pattern of
"documented, not fixed" for `verify_jwt`'s missing `iss` check (same
disposition as round 1's `elder_id`-rotation bypass — low severity, requires
already-valid signing credentials).

**One real fix landed:** a request-body-size ceiling
(`services/hermes/src/hermes/api/bodylimit.py::MaxBodySizeMiddleware`,
default 25MB, wired into `main.py`), closing the unbounded-memory-growth gap
round 1 measured but didn't fix. **Gotcha:** this can't be built as another
`@app.middleware("http")` like the existing rate limiter —
`starlette.middleware.base.BaseHTTPMiddleware`'s `_CachedRequest
.wrapped_receive` replays an *empty body* downstream if a dispatch function
reads `Request.stream()` directly instead of fully buffering via
`Request.body()` first (verified against the installed package's own
docstring) — which would defeat the whole point of a size guard. Had to be a
raw ASGI middleware class (`app.add_middleware(MaxBodySizeMiddleware, ...)`)
instead. Second gotcha: if the oversized body is consumed via FastAPI's own
`request.body()`/`request.json()` (inside route-parameter parsing), FastAPI's
routing wraps that in a bare `except Exception` and re-raises as a generic
`HTTPException(400, "There was an error parsing the body")` before our
exception ever unwinds back to the middleware's own except block — so the
declared-`Content-Length` path gives a clean `413`, but the
streaming-without-declared-length path surfaces as `400` instead. Still
correctly aborts before full buffering and the route handler never runs —
just don't expect a uniform status code across both paths.

**Gotcha (repeats, now confirmed twice):** each fresh local Supabase CLI
instance needs its own baseline-grants workaround re-applied (see round 1's
entry below) — the harness correctly does NOT carry an authorization for this
forward from a prior instance to a new one, even same-session; it's scoped
per-instance and needs a fresh ask each time a new local stack is stood up.

## 2026-07-12 — Security/RLS/rate-limit/load-test verification pass: 2 real RLS bugs fixed

Ran a subagent-divided verification pass (see `docs/security-verification-2026-07-12.md`
for full detail). Found and fixed six real issues via live exploit-then-fix tests
against an isolated local Supabase (never the hosted project):

1. **`care_links` self-grant** — any authenticated user could insert an
   **active** caregiver link to an arbitrary elder with zero consent
   (`care_links_insert_as_caregiver`'s check was only `auth.uid()=caregiver_id`,
   and `status` defaulted to `'active'`). Fixed in
   `supabase/migrations/0005_care_links_consent_hardening.sql`: default is now
   `'pending'`, insert requires `status='pending'`.
2. **`care_links` un-revoke** — a revoked caregiver could PATCH their own link
   back to `'active'`. Fixed in the same migration by splitting the update
   policy: the elder retains unrestricted control of their own row; a
   caregiver's own update policy can only ever move status to `'revoked'`.
   **Do not merge these two policies back into one** — a single symmetric
   `elder_id OR caregiver_id` check can't distinguish which party is driving
   which transition, which is exactly how this bug happened the first time.
3. `/profile/extract` had zero rate limiting despite calling a paid vision LLM
   pre-account — added to `main.py`'s `_RATE_LIMITED_PATHS`.
4. Unguarded `base64.b64decode()` in both `/agent/turn` and `/profile/extract`
   500'd on malformed input — now wrapped in try/except matching the existing
   friendly-error convention.
5. JWT verification errors leaked the raw PyJWT exception string in the 401
   body — now generic, with the real reason logged server-side only.
6. **Not fixed (accepted, documented):** `/agent/turn`'s per-user rate-limit
   cap is bypassable by rotating the client-supplied `elder_id` whenever
   `HERMES_STRICT_AUTH=False` (the default) — the real fix is a deployment
   decision (`HERMES_STRICT_AUTH=1`), not new code. Could not confirm from a
   permitted read-only source whether the real prod `.env` actually sets this
   — needs manual confirmation.

**Gotcha for next time — local Supabase CLI needs a manual baseline-grants
fix that the hosted project doesn't:** a fresh `npx supabase@latest start` +
`db reset` on this repo's migrations leaves every `public.*` table 403 to
`anon`/`authenticated`/**and `service_role`** via PostgREST — `\dp` shows only
`Dxt` (no `arwd`) — because none of `0001-0004` contain a baseline
`GRANT ... ON ALL TABLES IN SCHEMA public`; they assume the grants a hosted
Supabase project provisions automatically. This blocks PostgREST *before* RLS
is ever evaluated, including the `service_role` connectivity probe
`tests/test_rls_integration.py`'s `supabase` fixture uses to self-skip — so
all RLS integration tests silently SKIP (not fail) until you run, against the
**local container only**, never the hosted project:
```
docker exec supabase_db_dosewise psql -U postgres -d postgres -c \
  "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role; \
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;"
```
This is local-dev-tooling-only — not an app bug, not something to add to the
migrations (would be wrong/redundant on the hosted project).

## 2026-07-11 — i18n D2/D3 completed: full primary-flow translation, all 6 languages

Finished the i18n workstream flagged as remaining on 2026-07-09. Converted every
hardcoded string in the primary-flow surface to `t()` and added the matching
key in all 6 languages: `GuidedSetupWizard.tsx` (~45 strings, was 0% translated),
both chat screens (`AskMeiScreen`/`ElderlyAIScreen`, ~40 combined — greetings,
quick-help tiles, doctor tab, chips, disclaimers), shared components
(`ConfirmDialog`, `GuidedTour`, `CallMockup`, `PatientSwitcher` in `shared.tsx`),
`LoginScreen`/`OnboardingScreen` gaps, and the `App.tsx`/`ElderlyApp.tsx`
tour-step + toast + "Replay tour?" dialog copy. Also converted
`lib/agentActions.ts`'s `ACTION_TARGETS` from literal `done`/`label` strings to
`doneKey`/`labelKey` translation keys (both chat screens' confirm+redirect
messages were previously hardcoded English).

**Gotcha:** `App.tsx` owns/mounts `LanguageProvider` itself, so it sits *above*
the provider in the tree and cannot call the `useLanguage()` hook (throws).
Fixed by reading `readStoredLanguage()` (point-in-time, non-reactive — same
helper `lib/hermes.ts` already uses) at the top of the render body instead.
This is "eventually consistent" on a live toggle (updates on App's next
re-render, not instantly) — acceptable for demo tour/toast copy. Any *screen*
component (rendered as a child of the provider) should use the real
`useLanguage()` hook, not this pattern — `ElderlyApp.tsx` already did.

**Verification:** wrote a node completeness gate
(`scratchpad/i18n-check.mjs` pattern — not checked into the repo, recreate if
needed) that asserts (a) all 6 language tables have identical key sets and
(b) every string-literal key used in a `t(lang, "key")` call across the repo
resolves. Final state: **326 keys × 6 languages, exact parity**, 311 keys
actively used, zero missing/orphaned keys. `npm run build` clean throughout.

**Still out of scope (unchanged from 2026-07-09):** `AIScreen.tsx`/
`WeeklySummarySheet.tsx`, `EditProfileSheet.tsx`, `TravelModeSheet.tsx`,
`SendReminderSheet.tsx`, `MessagesScreen.tsx`, `SettingsScreen.tsx` seed/mock
data — deferred by explicit user choice ("primary flow + structural" scope).

## 2026-07-09 — Structured profile-extract "pull" API + autofill + timeline proof + i18n backfill

User-directed cross-cutting pass (web + hermes). Four threads:

1. **New `POST /profile/extract` (the "pull" API).** `services/hermes/src/hermes/
   agent/extract.py::extract_profile_fields` — provider-agnostic (mirrors loop.py's
   3 branches), forces a single `record_profile` tool call and returns structured
   `ProfileDetails`-shaped fields from an uploaded PDF text / photo (vision). Route
   in `api/routes.py` is **API-key gated but NOT jwt-required** on purpose — it's
   stateless (no Supabase, no identity) so it works during onboarding before an
   account exists. Sniffs image media-type (PNG/JPEG/WebP) since the browser strips
   the data-URL mime. Tests: `tests/test_profile_extract.py`.
2. **Onboarding autofill.** New "Upload my records" card on `SetupMethodScreen`
   (between the disabled MediHub card and Guided questions) → `extractProfile()`
   (`lib/hermes.ts`) → `buildWizardPrefill` (`lib/profile.ts`) → seeds
   `GuidedSetupWizard` state; user reviews (emerald "Autofilled — review" badge).
   Killed the fake stubs: `TagList` scan + `MedList.onFile` now call the real
   endpoint (were a `setTimeout` fake OCR + catalog substring-match). Elder AI
   "Update profile" tile (`ElderlyAIScreen.onReportFile`) now extracts → merges
   (`mergeProfileDetails`, existing scalars win, arrays union) → `saveProfile` →
   redirects to Settings (was: only wrote the free-text `medical_profile` blob).
3. **Caregiver timeline proof.** Mirrored the elder `justAddedMed` highlight into
   `App.tsx` (state+6s timer) → `AskMeiScreen` (`onMedAdded`), `TimelineScreen`
   (now renders the **dose** + emerald "Just added" chip — previously omitted dose),
   `PatientScreen`. Keyed by med **name** (slotId re-hashes on refetch). Normalized
   `set_medication_reminder`'s committed action to carry `name` (parity w/ add).
4. **i18n structural fix.** `yue`/`ta`/`ms` were missing the whole `common.*`
   namespace (62 keys → silent English fallback); backfilled all three. Fixed a
   build break: `ElderlyHomeScreen` imported `localizeMedText` that didn't exist in
   `lib/language.ts` — added it (safety-conscious: falls back to the curated English
   med direction, does NOT machine-translate dosing text). Caregiver bottom-nav was
   hardcoded English → extracted `components/BottomNav.tsx` (uses `t()`, reuses
   `common.*` keys). All 6 language tables now at **182 keys, exact parity** — a
   node gate (`scratchpad/i18n-check.mjs`) asserts parity + that every `t()`-literal
   key is defined. **Still hardcoded (next batch):** GuidedSetupWizard body (~45),
   AskMeiScreen/ElderlyAIScreen (~40), and secondary sheets — these don't use `t()`
   yet, so they stay English regardless of toggle.

**ngrok architecture (corrects an earlier misread):** the fixed domain
`neomi-unimprinted-shelton.ngrok-free.dev` → **`:5010` is the hermes-demo BACKEND**
(that's why `GET /` returns 404 — it has no root route; that is NOT "down"). The
frontend has a **separate** tunnel → `:5173`. Do **not** repoint the fixed domain to
5173 — it would break `VITE_HERMES_URL`. Use `scripts/post.sh` to manage services
(see CLAUDE.md POST policy). Local verification server: `TELEGRAM_BOT_TOKEN=
HERMES_PORT=8901 uv run hermes-serve` (empty token = no 409 poller).

## 2026-07-07 — `isabel-tried` merged into `main`; web app becomes primary demo surface

`main` was fast-forwarded through the `assistant-fixes` branch (rate limiting,
RLS hardening, service-client guard) and then merged with `origin/isabel-tried`,
which wired `apps/web` to Supabase and Hermes (login, medication CRUD, profile,
travel mode, setup wizard, and both AI chat screens calling `agentTurn()`).
`origin/main` at the time was already an ancestor of `isabel-tried`, so no
separate "heera7 changes" merge was needed. Not pushed to `origin/main` at
merge time — confirm before pushing.

**Consequence:** the demo surface shifted from Telegram-only to the web app,
with Telegram kept as a testbed (see `CONTEXT.md`).

## 2026-07-07 — Wired the Hermes AI assistant live in the web app

The `agentTurn()` ↔ `/agent/turn` code wiring existed from the isabel-tried
merge but **did not actually work**. Fixed, in order of how they'd bite:

1. **No CORS on Hermes** — the browser was refused at preflight before ever
   reaching the agent. Added `CORSMiddleware` gated by `HERMES_CORS_ORIGINS`
   (`services/hermes/src/hermes/main.py`, `config.py`).
2. **PDF ingest missing on `/agent/turn`** — the endpoint only took
   `image_base64`; report uploads are often PDFs. Added `pdf_base64`, reusing
   `channels/pdf.py::extract_pdf_text` the same way `telegram.py` does
   (`api/routes.py`).
3. **Prompt not app-aware** — `agent/soul.md` was Telegram-flavored (referenced
   tap-buttons that don't exist on web). Made it channel-neutral and added a
   section describing the app's actual screens/features.
4. **Photo prescription, report upload, and voice were UI theater** — all
   three were `setTimeout`/hardcoded mocks in `apps/web`. Replaced with real
   `agentTurn()` calls (photo/report) and the browser Web Speech API (voice —
   client-side only, not routed through Hermes).

Decisions locked in via `AskUserQuestion` (not re-litigate without a reason to):
add real CORS to Hermes (not just a Vite dev proxy); wire all four gaps in one
pass; voice via Web Speech API, not a new Hermes voice endpoint.

Crossed `apps/web/CLAUDE.md`'s "never edit services/hermes" boundary — done
only because the user explicitly directed this specific cross-cutting task.

**Test-suite fallout:** the `isabel-tried` merge had silently dropped the
`use_anthropic()` pin from several tests in `test_agent_loop.py` /
`test_telegram.py`, which then routed `FakeAnthropic` into the real OpenAI code
path and failed. Restored the helper in `tests/fakes.py` and the call sites —
unrelated to this task's own changes, but blocked getting a green baseline.

## 2026-07-08 — Agent UX pass: language, per-user chat, mode persistence, commit→redirect

Four fixes across web + hermes (user-directed cross-cutting work):

1. **`tools_used` can't tell propose from commit.** `add_prescription` (and
   `update_medical_profile`, `set_medication_reminder`) are called with
   `confirmed=false` **and** `confirmed=true`, and `loop.py` appends the tool name
   to `tools_used` in *both* — so `tools_used.includes("add_prescription")` is true
   on the propose turn where nothing was written. Added `ToolContext.committed_actions`
   (`tools/base.py`), appended **only** in each write tool's commit branch, returned
   as `actions` on `/agent/turn`. This is the reliable "a write happened" signal;
   the web chat keys its confirm+redirect on it. Don't revert web code to sniffing
   `tools_used` for writes.
2. **`reply_language` was already supported but never wired.** `run_agent_turn`
   accepted it (→ `prompts.system_prompt_for`), but `/agent/turn` didn't. Now the
   route forwards it; `lib/hermes.ts::agentTurn` resolves it from a per-user
   localStorage language setting (`lib/preferences.ts`) so every call honors it with
   no call-site threading. It's *reply_language*, not `profiles.dialect` (different
   prompt semantics: "reply in X" vs "mirror their words").
3. **Elderly chat was shared across all accounts** — keyed `mei-chat:${patient.id}`
   where `patient.id` is the constant mock id `1`. Now keyed by the Supabase `elderId`.
4. **"Always loads elderly on reopen"** was NOT a role-write bug (the wizard writes
   role correctly for both paths). `appMode` was derived only from the DB role, and
   "Switch mode" is an ephemeral preview. Fix: persist last-active mode per user in
   localStorage (`lib/preferences.ts`), preferred over the role default on load.

**Env gotcha (unchanged, reconfirmed):** the pm2 `hermes` (id 0, prod :8000) process
is in a chronic restart loop (16k+ restarts) independent of any change here — don't
mistake its "waiting restart" churn for something you broke. `hermes-demo` also
long-polls the **same Telegram bot token**, so a local `hermes-serve` (even on :8901)
will start a second poller — kill it promptly after verifying to avoid getUpdates
409s. Kill by the exact PID bound to your test port, never a broad `pkill hermes-serve`.

## 2026-07-08 — Four-issue fix pass: timeline sync, voice, language, fallback

User-directed cross-cutting pass (web + hermes; explicit go-ahead to cross
`apps/web/CLAUDE.md`'s no-hermes rule). Fixes:

1. **Timeline stale after an agent-added prescription.** Root cause: `TimelineScreen`
   has no store — it renders prop-drilled `patient.medications`, refreshed only by
   `onMedsChanged`, which was single-gated on a *routable* `actions`, unawaited, and
   uncaught. Now the chat `send()` refetches on **any** non-empty `actions`, awaited
   + `try/catch` (both chat screens). Added a **safety-net refetch** on screen focus:
   `App.tsx` effect refetches when caregiver `screen` ∈ {timeline,patient,dashboard};
   `ElderlyApp.tsx` effect when elder `tab` ∈ {home,prescriptions} — covers the
   `actions`-empty case. Elder has **no timeline tab** — the "timeline" is the
   caregiver screen; the elder equivalent is the Home schedule. Also fixed a latent
   clobber: `ElderlyApp.refreshMeds` spread a closed-over `patient`; now uses a
   functional update (elder `onUpdatePatient` widened to accept `prev => next`).
2. **AI voice output dead.** The "Read Aloud" toggles in both Settings screens were
   inert local `useState` (never persisted/read); the real gate was a separate
   ephemeral per-chat `voiceOutput`. Now there's **one persisted source of truth**:
   `voiceOutput` lives on `AccessibilityProvider` (`accessibility.tsx`, key
   `dosewise:accessibility`, DEFAULTS-merge = backward-compatible). Both Settings
   toggles + both chats + the in-chat "Language & voice" switch read/write it.
   Extracted `lib/speech.ts` with the shared `speak()`: fixes the cancel()→speak()
   race (defer to next tick) and picks an installed voice via `voiceschanged`.
3. **Reply language drift.** apps/web wiring was already correct (same
   `dosewise-language` key → `reply_language` → prompt). Firmed the directive in
   `prompts.py` ("Write your ENTIRE reply in {lang}…, do not fall back to English
   unless the patient switches"). Test: `test_medical_profile.py`.
4. **"Ask a person" fallback.** (a) `hermes.ts` collapsed no-session/401/429/5xx/
   network into one opaque English string with no logging — now distinguishes the
   four classes, `console.warn`s each, returns a class-specific message. (b)
   `routes.py` `/agent/turn` now wraps `run_agent_turn` in try/except + `log.exception`
   and returns a friendly 200 (not a bare 500 the client hides). (c) `loop.py`
   iteration-cap / empty-reply now `log.warning` + recover with a gentle **retry**
   line (`_RETRY_REPLY`), not the old "let me get a person" handoff — a cap-hit is a
   stuck tool loop, not a safety event. Applied across all 3 provider branches. (d)
   `soul.md` rail #5 tightened against over-escalation (answer ordinary label
   questions; escalate only for real safety) — other safety rails untouched.

Note: `config.py` `anthropic_model = "claude-sonnet-5"` is a **valid** id — an
explore agent flagged it as suspect; it is not. Don't "fix" it.

Verification: full hermes suite green (`uv run pytest`, 177 passed / 5 integration
skipped) incl. rewritten iteration-cap tests (assert `_RETRY_REPLY`), new
reply_language-injection tests, and a route-error test (raise mid-turn → friendly
200, not 500). Web `npm run build` clean. **Not** live-driven through a browser this
pass (no test-user password on hand; a real drive also spawns a Telegram poller +
needs LLM keys) — the in-app timeline refresh and actual TTS still want a manual
click-through on the 5173/ngrok dev server.

## 2026-07-08 — Live UI↔agent test found two more real bugs

Asked to verify the chatbot is actually reachable from the UI, not just that
the code compiles. Signed in a real test Supabase user
(`ui-test-elder@dosewise.test`) and drove `/agent/turn` exactly as the browser
would (session JWT + `Origin` header), including a full
propose→confirm→read-back prescription write. Found:

1. **`apps/web/.env` didn't exist** — created it (git-ignored), mirroring
   `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`/`VITE_HERMES_URL` from the
   deployed root `.env`. Without it `agentTurn()` has nowhere to call.
2. **Real Supabase user JWTs are ES256, not HS256** — `db/auth.py::verify_jwt`
   only checked the legacy HS256 shared-secret path (which is how
   Hermes-*minted* Telegram/CLI tokens are signed). Every real browser login
   was getting a silent 401 → the chat's `FALLBACK_REPLY`, with no visible
   error. Fixed by verifying ES256/RS256 against the project's JWKS
   (`PyJWKClient`), added `pyjwt[crypto]` dependency, kept HS256 for the
   minted-token path. Regression test added in `tests/test_hermes.py`.

Both were invisible from a code read or from the existing test suite — only
surfaced by actually driving the real HTTP+auth path end-to-end. **Lesson:
"the code path exists and unit tests pass" is not the same as "a real login
can talk to it."**

Also confirmed during this pass: `Settings.supabase_project_url` (added
2026-07-07 for the doubled `/rest/v1/` bug) is the single place both
`db/supabase.py` and `db/auth.py`'s JWKS URL now derive the base Supabase URL
from — don't reintroduce a second ad-hoc `.rstrip("/")` elsewhere.

**Environment gotcha:** this box runs a pm2-managed production Hermes on port
8000 (`pm2 list`), auto-deployed via `deploy/pm2/watch-and-pull.sh`. Local
verification servers should bind a different port
(`HERMES_PORT=8901 uv run hermes-serve`) to avoid fighting it for the port —
killing pm2-managed processes needs explicit permission, it's not something to
do reflexively when a port is "stuck."
