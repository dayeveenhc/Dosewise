# Dosewise — Session Memory

A chronological log of decisions, gotchas, and non-obvious fixes — the "why"
behind things that aren't derivable from reading the code alone. For the
current-state architecture snapshot, read `CONTEXT.md` first.

Keep entries short and dated. Prune/consolidate stale entries rather than
letting this grow forever — it's a memory aid, not an audit log.

---

## 2026-07-21 — Caregiver↔elder QR linking (real care_links, no migration)

New feature, **frontend-only** (stayed inside `apps/web`; read `supabase/` for
contracts, edited nothing there). Elder shows a QR in Settings → caregiver scans
it under "Add care recipient" → a **pending** `care_links` row is created → the
elder accepts/declines from their Notifications tab.

Why no schema/RLS change was needed (the non-obvious part): `care_link_status`
already has `pending`, and 0002/0004 RLS already allow exactly this handshake —
caregiver INSERT (`with check caregiver_id = auth.uid()`), **either party** UPDATE
the status, select by either party, and delete is blocked (reject = status →
`revoked`, not a delete). So the whole flow rides existing policies.

Key decisions / gotchas:
- **Elder can't read the caregiver's `profiles` row** (profiles RLS is self-or-
  *linked* caregiver, and the link isn't active yet), so the caregiver's display
  name + relationship are stashed in the link's `permissions` jsonb at insert
  time — the elder is allowed to read the `care_links` row itself. Don't try to
  join `profiles` for the pending-request name; read it from `permissions`.
- **Demo-grade caregiver side** (user's explicit choice): after a successful
  scan the caregiver just gets a local pending patient card (reuses
  `handleAddPatient`); no deep fetch of the elder's real meds/profile. Revisit
  if we want the accepted patient to load real linked data.
- **No live push** (consistent with the rest of the app): the elder sees the
  request when they open Notifications (`fetchPendingLinkRequests` on mount), not
  in real time.
- New files: `apps/web/src/app/lib/careLinks.ts` (payload encode/parse +
  create/fetch/respond), `components/ScanLinkSheet.tsx` (html5-qrcode camera).
  QR generated with `qrcode.react`. **Two new deps** (`qrcode.react`,
  `html5-qrcode`) — user-approved (apps/web forbids new deps otherwise).
- QR payload is `{app:"dosewise",kind:"care-link",v:1,elderId,name}` (JSON);
  `parseCareLinkPayload` validates the marker + uuid so the scanner ignores
  non-Dosewise codes. `createLinkRequest` is idempotent against the
  `unique(elder_id, caregiver_id)` constraint (re-arms a pending/revoked link).
- i18n: added ~28 `link.*` + `patientSwitcher.scanQr` keys to all 6 languages
  (parity gate: **372 keys × 6**, verified).

## 2026-07-19 — ⚠️ OPEN BUG: `t` is shadowed in ElderlyAIScreen's `send()`

**Found, not fixed — flagged to the user.** In
`apps/web/src/app/screens/elderly/ElderlyAIScreen.tsx`, `send()` opens with
`const t = text.trim()`, which shadows the imported `t()` translation function
for the whole body. Three calls near the end of that function
(`t(language, routed.target.doneKey)` and friends) therefore try to *call a
string*. Any agent turn that commits a routable action — add prescription, log
dose — throws `t is not a function` in the elder's chat, killing the
confirm-and-redirect flow that CONTEXT.md lists as a headline feature.

Fix is a rename (`const trimmed = text.trim()`). Untouched so far only because
it's outside the scope of the UI pass it surfaced during. **This is invisible to
`npm run build`** — see the typecheck note below.

## 2026-07-19 — Elderly UI pass: grouped prescriptions, quick-help popup

`fetchElderMedications` deliberately emits **one `Medication` per (medication,
time-slot)** — correct for the schedule, wrong for any "list of prescriptions"
view, where a twice-daily pill was rendering as two identical cards.
`ElderlyPrescriptionScreen` now regroups by `medicationId` (falling back to
`name` for seed data) and shows the times as an indicator. **Any new list-style
view of medications needs the same regrouping** — the caregiver's `PatientScreen`
has not been checked for this.

Quick help in the elder chat is a popup, not an inline expander, so it no longer
pushes the conversation off-screen; `quickOpen` is therefore no longer persisted
to sessionStorage (restoring a modal open on remount is wrong).

## 2026-07-19 — One shared time picker; killed a silent "schedules at 8am" bug

Medication timing was per-screen and one variant was actively wrong. Unified on
`apps/web/src/app/components/TimesPicker.tsx` (`TimesPicker` for a med's dose
times, `TimeField` for a single meal/bedtime).

**The bug worth remembering:** `AddPrescriptionSheet` had a "Custom" free-text
time box (`"e.g. 10:30 AM"`) whose value went straight to
`lib/medications.ts::to24h`. That function returns `"08:00"` for anything not
matching exactly `H:MM AM/PM` — so `10:30`, `10.30am` or `22:00` silently
scheduled the medication at 8am, with no error anywhere. **`to24h` fails soft;
never feed it unvalidated text.** The picker now only emits well-formed times.

Two deliberate choices, so they don't get "fixed" back:

- **No `<input type="time">` anywhere.** It renders as the big OS wheel only on
  a real phone; in a desktop browser (how the phone-frame demo is actually
  viewed and judged) it collapses to a cramped `--:-- --` spinner. Replaced with
  a tap-only `∧`/`∨` stepper — also better than a slider/scroll-wheel for the
  elderly target user, since there's nothing to drag onto a target.
- **Wizard step order: `routine` before `current-meds`.** Meal/bedtime answers
  are the frame people describe doses against — and the med step's quick chips
  now show those answers back, which only works because routine is asked first.

The chips (and a new med's default time) read the elder's own routine, falling
back to `MEAL_TIMES` only when there's no profile. The wizard passes its live
step state; `AddPrescriptionSheet` takes a `routine` prop that both `App.tsx`
and `ElderlyApp.tsx` fill from `Patient` — **no extra fetch needed, `Patient`
already carries `mealTimes` + `sleepTime`**, and `ElderlySettingsScreen`'s
`onUpdatePatient` keeps them live after an edit. Note `sleepTime` sits *beside*
`mealTimes` on `ProfileDetails`, not inside it — hence the
`{ ...patient.mealTimes, sleepTime: patient.sleepTime }` spread at both sites.

`PRESET_TIMES` in `data/medications.ts` is now unused (left in place). Note
`apps/web` has no `typescript` installed and `vite build` uses esbuild, which
strips types without checking — **`npm run build` passing is not a typecheck.**

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
