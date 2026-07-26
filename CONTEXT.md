# Dosewise — Project Context

Read this before doing any non-trivial work in this repo. It's a snapshot of
**what exists and how it fits together**, not a changelog — see `MEMORY.md` for
the chronological log of decisions and gotchas.

## What this is

Dosewise is a university HCI & AI competition build: an agent-first medication
app for elderly patients and their caregivers. The elder talks (types or speaks)
to an AI agent, **Hermes**, which understands intent, grounds every drug fact in
OpenFDA, and acts through a constrained, human-in-the-loop tool belt. A caregiver
is linked to each patient as the safety/retention layer. Full pitch: `README.md`.

## Repository layout

```
Dosewise/
├── apps/web/            # Vite + React + Tailwind + shadcn/ui frontend — the
│                         # primary demo surface (phone-frame mockup)
├── services/hermes/      # Python 3.12 + FastAPI agent orchestrator — the
│                         # security boundary; holds all external API keys
├── supabase/              # Postgres schema + RLS policies + seed data
└── docs/architecture.md  # deeper architecture reference
```

`apps/mobile/` (Expo/React Native) is referenced in the root README but is
**deferred** — do not write code there.

## The two channels, one agent core

Hermes exposes one shared turn function, `run_agent_turn` (`services/hermes/src/
hermes/agent/loop.py`), reached by two independent channels:

- **`POST /agent/turn`** (`services/hermes/src/hermes/api/routes.py`) — called
  directly from the browser by `apps/web/src/app/lib/hermes.ts::agentTurn()`.
  This is the **primary demo surface**. Auth: the client forwards its Supabase
  session JWT (`{message, jwt, image_base64?, pdf_base64?, reply_language?}` →
  `{reply, tools_used, actions}`). `reply_language` (the app's Voice&Language
  setting) is threaded into the system prompt so Mei replies in it. `actions` is
  the list of writes the agent **actually committed** this turn (`{tool, summary}`),
  populated from `ToolContext.committed_actions` — the reliable "a write really
  happened" signal (a tool name in `tools_used` is *not* enough: propose and
  commit both call e.g. `add_prescription`). The web chat uses `actions` to
  confirm + redirect to the page that shows the change. CORS is env-gated via
  `HERMES_CORS_ORIGINS`.
- **Telegram bot** (`services/hermes/src/hermes/channels/telegram.py`) — the
  **testbed channel**, kept working for informal testing and demoing voice/PDF
  features Telegram has that the web app doesn't yet (native voice notes,
  inline confirm buttons). Any backend change must stay additive to both.

Both channels persist conversation history to `conversation_turns` and act
through Supabase Postgres **RLS as the user** (Hermes mints/verifies JWTs — see
`services/hermes/src/hermes/db/auth.py`), never a service-role bypass except for
`drug_cache`, cron reads, and pill-photo uploads.

## Frontend (`apps/web`)

Vite/React app with two top-level modes selected at onboarding: **elderly**
(large-text, simplified, voice-first) and **caregiver** (fuller control view).
Gates: `npm run build` (transpile-only), `npm run typecheck` (`tsc --noEmit` —
a pragmatic non-strict `tsconfig.json`, added as a refactor safety net since the
build doesn't type-check), `npm test` (vitest), `npm run e2e` (Playwright).
Both have an AI assistant chat screen wired to Hermes:

- `screens/AskMeiScreen.tsx` — caregiver chat ("Ask Mei").
- `screens/elderly/ElderlyAIScreen.tsx` — elder chat, plus Quick-help tiles
  (add prescription by photo, update profile from a report, ask about a
  medication, language & voice, travel mode).

Real backend wiring (Supabase + Hermes) exists for: login/signup, medication
CRUD, profile save, dose logging, travel plan, and the full chat/photo/report
agent flows. `apps/web/CLAUDE.md` has this app's own ownership rules — **it
normally forbids touching `services/hermes/` or `supabase/`**; cross-cutting
work across that boundary needs explicit user sign-off (as happened for the
Hermes wiring — see MEMORY.md).

Mei can also run a **Guided Walkthrough**: a scripted, spotlight-and-narrate
overlay (`components/Walkthrough.tsx`) that highlights one screen element at a
time, but never fills/taps/submits on the user's behalf — every step ends
only when the real user performs the real action (native DOM listener, or an
app-emitted event via `lib/walkthrough/steps/` + `lib/walkthrough/bus.ts` for
actions no generic listener can tell apart, e.g. an async write's real
success). Started by Hermes's `start_walkthrough` tool (task name only — step
content stays client-side); see MEMORY.md's 2026-07-22 entry for the full
architecture and known gaps.

A **Guided Auto-Navigation** mode is layered on top (2026-07-23): a step can
instead carry an `act` (Mei performs the fill/tap/upload/submit herself, visibly
animated — `lib/walkthrough/actor.ts`) plus `verify`/`reveal` phases (orchestrated
by `lib/walkthrough/orchestrate.ts::runActStep` — a failed Verify STOPS and never
implies success), so `waitFor` is now optional on a step. **Four autonomous scenarios** are built and live-validated end-to-end
(Playwright, real Supabase, incl. write-fail paths): `add_prescription_auto`,
`travel_mode_auto`, `edit_profile_auto`, and `accept_caregiver_link` (the
consent flow — Mei navigates but the elder taps Accept themselves, then Verify
confirms the link is active). Verify is a real re-query: client `onVerify` (host,
e.g. `ElderlyApp`) mirrors the Hermes read-only `verify_medication_exists` tool
(`tools/verify.py`); `onReveal` pulse-highlights where the change landed. The
overlay is `pointer-events-none` so a real user tap reaches the spotlighted
element (the consent flows depend on this). **In real chat Mei fulfills a
request by triggering the matching `*_auto` walkthrough with the patient's real
values** — `start_walkthrough` takes an optional `params` object (VALUES only;
step content/selectors stay client-side), the autonomous step files are param
builders, and soul.md prefers this over a silent direct write (prescriptions
still propose first for the interaction check). Adds land where the UI reads
them (e.g. `add_condition_auto` writes structured `conditions[]`, not the
free-text `medical_profile` blob). Full detail + scope/safety decisions:
MEMORY.md's 2026-07-23 entries.

**Add-prescription is a hybrid (2026-07-24):** `add_prescription_auto` runs the
animated walkthrough in the **elder** shell and now reveals on **Home**
(`tab:"home"`, `[data-tour="elder-schedule"]` — the Home timeline self-highlights
the new dose via `justAddedMed`); `ACTION_TARGETS.add_prescription.elderly` is
`"home"` too. The **caregiver** shell can't run the elder-mode steps, so its
`handleWalkthroughStart` intercepts `add_prescription_auto` and does a **direct
save** from params → Patient med-list. A verify-failure in the elder walkthrough
now calls the new `Walkthrough` prop `onVerifyFailed`, and `ElderlyApp` falls
back to a direct save **only if the med is genuinely absent** (re-query guards
against a double-save when Verify merely raced); a real write failure keeps the
honest `walk.verifyFailed`. The elder sheet's `onAdded` tab-switch is gated on
`!walkthroughTask` so it doesn't fight the Home reveal. MEMORY.md's 2026-07-24
entry has the why.

**Proof-of-change is now the `ChangeHighlight` layer (2026-07-23 rebuild)**, which
supersedes the old selector-pulse / name-string highlight for the flows it covers.
Its keystone: every write tool's `committed_actions` entry carries **what** changed
—`{tool, summary, entity_type, entity_id, changed_fields}` (built via
`services/hermes/tools/base.py::record_action`; `changed_fields` is
`{field:{before,after}}`). The web `components/ChangeHighlight.tsx` (logic in
`lib/changeHighlight.ts`) navigates to that entity's screen, finds the exact record
by `data-testid="{entity_type}-{entity_id}"` (with a suffix `-{id}` fallback so a
`schedule_entry`/`refill_request` change to a med resolves the `medication-<uuid>`
card), pulses `.change-highlight` around it, and shows a caption **derived from
changed_fields** (e.g. "Updated: dose time 18:00 → 20:00") — never a generic toast;
it `console.error`s loudly if the element is genuinely absent. Only ~10 of the 20
target flows persist a re-queryable entity; the rest (localStorage/mock/view-only,
or non-existent tables) get navigation only and must not fabricate an entity_id.
Covered elder flows now include **dose-taken** (`log_dose` → Home timeline card,
caption "Taken: …"; `entity_id` is the **medication** id so the suffix fallback
resolves — the UI renders meds, not dose rows) and **dosage-update**
(`update_medication_dosage` → Prescriptions card, "Updated: 500mg → 1000mg"). The
other 8 requested scenarios are triaged as greenfield gaps (new table/tool/screen,
or caregiver-side `ChangeHighlight` which is **not mounted** today) — see
`docs/change-highlight-gap-analysis-2026-07-25.md`.

All clock-time entry goes through one component, `components/TimesPicker.tsx`:
`TimesPicker` (a medication's one-or-more dose times) and `TimeField` (a single
time — meal times, bedtime). Both set times with the same tap-only stepper; no
screen should reintroduce a raw `<input type="time">` (see MEMORY.md for why).
Used by the guided setup wizard's routine + medication steps, the caregiver's
`AddPrescriptionSheet`, and `ElderlySettingsScreen`. `TimesPicker` speaks the
app's 12h display strings (`Medication.times`); `TimeField` speaks 24h `HH:MM`
(what `ProfileDetails.mealTimes` stores). `TimesPicker`'s quick chips take an
optional `routine` prop so they offer the elder's own meal/bed times rather than
generic defaults.

The elderly wizard's step order is `account → profile → conditions → allergies →
routine → current-meds → med-history → done`. **`routine` comes before the
medication steps deliberately** — meal/bedtime answers are the frame people
describe doses against ("one after breakfast").

Voice input/output is client-side (browser Web Speech API — `SpeechRecognition`
+ `speechSynthesis`), not routed through Hermes; it degrades gracefully where
unsupported. Text-to-speech goes through the shared `lib/speech.ts::speak`
(cancel→speak race fix + `voiceschanged` voice selection). `pickVoice` **prefers a
softer female voice** per language (exported `isFemaleVoice` heuristic; falls back to
first-available where the OS ships no female voice, e.g. Tamil/Hokkien). Whether Mei reads
replies aloud is one persisted setting — `voiceOutput` on `AccessibilityProvider`
(`accessibility.tsx`, key `dosewise:accessibility`) — read/written by both
Settings "Read Aloud" toggles, both chats, and the in-chat "Language & voice"
switch (don't reintroduce a separate per-chat voice `useState`).

## Backend (`services/hermes`)

FastAPI service, `uv`-managed. Key files:
- `main.py` — app factory, lifespan (wires LLM client, Supabase, Telegram,
  rate limiter, CORS), `hermes-serve` entry point.
- `api/routes.py` — `/health`, `/agent/turn`, `/telegram/webhook`, and
  `/profile/extract` (the structured "pull" API: reads an uploaded PDF/photo and
  returns `{fields}` for onboarding autofill; API-key gated but **jwt-free** since
  it's stateless — no Supabase/identity; impl in `agent/extract.py`).
- `agent/loop.py` — the provider-agnostic tool-calling loop (OpenAI default,
  Gemini/Anthropic alternatives; Anthropic is the automatic silent-key fallback).
- `agent/soul.md` + `agent/prompts.py` — the Dosewise persona/system prompt.
  Kept **channel-neutral** (describes app screens generically, not
  Telegram-specific button taps) so both channels get accurate answers.
- `tools/` — one file per tool (medications, profile, drug_info, interactions,
  schedule, doses, refills, caregiver, doctor, escalation, videos, walkthrough,
  verify), registered via `tools/base.py`. **18 tools** — `medications` registers
  four (`add_prescription`, `set_medication_reminder`, `update_medication_dosage`,
  `list_medications`); `update_medication_dosage` is the propose→confirm dose EDIT
  on an existing med (2026-07-25). `doses` registers two: `log_dose` (single) and
  **`resolve_missed_doses`** (2026-07-26) — the BULK propose→confirm resolver that
  computes today's past-due-untaken slots **server-side** (no name param, no LLM
  fan-out), back-dates each inserted dose to its slot time, and emits ONE bulk
  committed action `{tool, summary, entities:[{entity_type, entity_id,
  changed_fields, dose_id, slot, name}, ...]}` via `base.py::record_bulk_action`
  (the generic multi-entity contract alongside single `record_action`).
  `ChangeHighlight` is bulk-aware: it rings ALL resolved entities simultaneously
  with one batch caption ("Taken: 3 missed doses marked taken"). `verify.py` is the read-only
  "re-query real state → pass/fail" pattern for Guided Auto-Navigation.
  `base.py` also holds the shared tool helpers: `find_medications` (the
  `name ilike` + `archived=false` lookup), `first_id` (new-row id from an insert),
  `match_pending` (the propose→confirm commit guard — reads the session's
  `pending_*` slot by name, so the Telegram deterministic-confirm contract is
  preserved), and `record_action`. Weekday constants (`WEEKDAYS`,
  `WEEKDAY_NAMES`) live in `dosing.py`.
- `db/auth.py` — mints Hermes-internal JWTs (HS256) for Telegram/CLI, and
  verifies client-supplied Supabase JWTs. Supabase user tokens are **ES256**
  (asymmetric, verified via the project's JWKS) — HS256 is only for
  Hermes-minted tokens.
- `channels/` — telegram.py, voice.py (HF STT/TTS), pdf.py (text extraction),
  lang.py (dialect/language detection), scheduler.py (reminders).
- `config.py` — `pydantic-settings`, reads the **repo-root `.env`** (not a
  per-service one). `Settings.supabase_project_url` normalizes `SUPABASE_URL`
  (deployed value may carry a trailing `/rest/v1/`).

Run: `cd services/hermes && uv sync --extra dev && uv run hermes-serve` (port
8000 by default) or `uv run hermes-chat` for the CLI harness. Tests: `uv run
pytest` (fully offline/mocked; a `supabase/scripts` RLS integration test needs a
live local Supabase and is marked `integration`).

## Deployment note

This box also runs a **pm2-managed production Hermes** (`pm2 list` shows
`hermes` + `hermes-git-sync`) bound to port 8000, auto-deployed from git via
`services/hermes/deploy/pm2/watch-and-pull.sh`. When testing locally, prefer a
different port (e.g. `HERMES_PORT=8901 uv run hermes-serve`) to avoid fighting
the pm2 instance for the port, and never kill pm2-managed processes without
being certain that's what's intended — ask first if unsure.

## Safety rails (do not weaken without explicit ask)

Grounded facts only (drug info always from `get_drug_info`/OpenFDA, never
memory) · explain-never-diagnose · scan/reminder/profile changes always
propose→confirm before writing · human-in-the-loop · RLS + audit trail ·
bridge-to-people escalation path. Encoded in `agent/soul.md` **and** enforced
server-side (e.g. the `add_prescription` confirm guard) — don't rely on the
prompt alone.

**One sanctioned exception to propose→confirm** (2026-07-23): an *autonomous*
Guided Auto-Navigation walkthrough may fill+submit a write on the patient's
behalf — but only after their explicit yes to the offer (the yes IS the
confirm), and it must re-query real state to **Verify** the write landed before
confirming, stopping honestly if it can't. Consent-bearing actions
(caregiver-link, emergency contact) are excluded and always need the patient's
own tap. The server-side `add_prescription` confirm guard still holds: an
autonomous walkthrough drives the app's own client write path (which the elder
authored by agreeing), not a `confirmed=true` chat call without a proposal.
