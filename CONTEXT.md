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
└── docs/                 # dated review docs (scenario catalog, gap analysis,
                          # security verification) — no architecture.md exists
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

Mei can also run a **Guided Walkthrough**: a scripted overlay
(`components/Walkthrough.tsx`) that spotlights one screen element at a time.
A step is either **user-driven** (`waitFor` — a native DOM listener or an
app-emitted `lib/walkthrough/bus.ts` event; the real user performs the real
action, Mei never fills/taps/submits) or **autonomous** (`act` — Mei performs
the fill/tap/upload/submit herself, visibly animated via `lib/walkthrough/
actor.ts`, then `verify`/`reveal` phases orchestrated by `lib/walkthrough/
orchestrate.ts::runActStep`; a failed Verify STOPS and never implies success).
`start_walkthrough` (Hermes) takes a task name plus an optional `params` object
(VALUES only — selectors/step content always stay client-side); the resolver
is `lib/walkthrough/steps/index.ts::resolveWalkthroughSteps(task, role,
params)` over `steps/*.ts`, one file per task, 15 task names total (static
step files and `*_auto` param-builders alike). The overlay root is
`pointer-events-none` so a real user tap always reaches the spotlighted
element underneath (the consent flows — `accept_caregiver_link` — depend on
this: Mei navigates, the human taps).

**All pacing flows through one module, `lib/walkthrough/pacing.ts`** (2026-07-27)
— nine constants (navigate/field-prehighlight/fill-per-char/field-floor/
between-fields/pre-click/verify-min/reveal-pulse/highlight-dwell-min),
enforced as **minimums** via `lib/walkthrough/pace.ts::createPaceController().
paced()`, the only timed-wait path in the whole system (auto-logs every phase
to a DEV-only `window.__dwPhaseLog` so e2e specs measure real elapsed time).
The overlay has a **Next** control (autonomous steps only — gated on
`step.act || (!waitFor && (verify||reveal))`, disabled until the current
phase's minimum has elapsed, never appears on a `waitFor`/consent step) and a
**Replay** control (reveal phase only, re-fires the same reveal + restarts its
dwell). `lib/walkthrough/verify.ts` (`pollVerify` + `buildVerifyRunner`) is
the one generic "re-query real state, never trust the write's own return"
mechanism — hosts (`ElderlyApp`, the caregiver shell) inject their real data
fetchers; it must never itself import anything Supabase-backed (breaks the
vitest import graph — same reason `lib/changeHighlight.ts` keeps a local
`hhmmTo12h`).

**Proof-of-change is the `ChangeHighlight` layer.** Its keystone: every write
tool's `committed_actions` entry carries **what** changed —
`{tool, summary, entity_type, entity_id, changed_fields}` (single writes via
`tools/base.py::record_action`; multi-entity writes — e.g. resolving every
missed dose at once — via `record_bulk_action`'s `{tool, summary, entities:[
...]}`, rung simultaneously with one batch caption). `changed_fields` is
`{field:{before,after}}`. `components/ChangeHighlight.tsx` (logic in
`lib/changeHighlight.ts`) navigates to the entity's screen, finds the exact
record by `data-testid="{entity_type}-{entity_id}"` (suffix `-{id}` fallback
so e.g. a `schedule_entry` change to a med resolves the `medication-<uuid>`
card), pulses `.change-highlight` (or the non-emerald `.change-highlight-
stopped` variant when `changed_fields.status.after==="discontinued"`), and
shows a caption derived from `changed_fields` — never a generic toast; loudly
`console.error`s if the element is genuinely absent rather than fabricating a
target. **Mounted in both shells** — `ElderlyApp.tsx` and (2026-07-27)
`App.tsx`'s caregiver branch, each with its own DEV-only `window.
__dwHighlightChange`/`__dwStartWalkthrough` registration (gated on
`appMode==="caregiver"` in `App.tsx`'s case — it never unmounts, so an
unconditional registration would race `ElderlyApp`'s own one for the same two
window properties the instant an elder session mounts; MEMORY.md's
2026-07-27 entry has the story). Not every scenario has a re-queryable
backing entity — genuinely mock/view-only flows (caregiver weekly summary,
notifications, emergency contacts) stay honest-navigation-only.

Every requested scenario now has its own independently-runnable e2e module —
`apps/web/e2e/scenarios/sNN-slug.spec.ts` (32 of them; `manifest.ts` + a
`coverage.spec.ts` guard keep the set exactly 32, wired, no orphans), each:
real `:8901` turn with a verbatim trigger phrase → independent Supabase
re-check → UI drive with phase-log timing asserted against `PACING` →
screenshot. `README.md` in that directory has the template + the shared-file
ownership rules. A pytest (`services/hermes/tests/test_walkthrough.py`)
enforces TASK_NAMES/labels/TS-union/resolver stay in 4-way agreement — this
pass found and would otherwise have reintroduced that exact drift.

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
- `tools/` — one file per tool (medications, profile, symptoms, drug_info,
  interactions, schedule, doses, refills, caregiver, doctor, escalation,
  videos, walkthrough, verify), registered via `tools/base.py`. **25 tools.**
  `medications` registers five: `add_prescription`, `set_medication_reminder`,
  `update_medication_dosage` (propose→confirm dose EDIT), **`discontinue_medication`**
  (2026-07-27, propose→confirm, sets `archived=true` — never deletes), `list_medications`.
  `doses` registers five: `log_dose` (single — takes optional `medication_name` AND
  `slot`; the selection engine `_dose_plan` picks earliest-first among today's
  pending doses, asks when genuinely ambiguous and writes nothing until answered,
  proceeds silently when only one dose is plausible — the 2026-07-27 root-cause fix
  for "marking one named medication taken" unreliability, see MEMORY.md),
  `resolve_missed_doses` (the "all" bulk resolver, server-side missed-slot
  computation), **`log_doses`** (2026-07-27, EXPLICIT-list bulk — "I took my X and
  my Y", distinct from the "all" filter — propose→confirm via the generic
  `pending_bulk` slot), **`undo_dose`** (flips a mistaken tick back), **`snooze_dose`**
  (today-only reminder move into `accessibility.dose_snoozes`, never touches the
  recurring schedule). `profile` registers **`set_allergy_severity`** (2026-07-27,
  propose→confirm — promotes the WHOLE `accessibility.allergies` array from legacy
  plain strings to `{name,severity}` objects on first grade, not just the target
  entry) alongside `update_medical_profile`. `symptoms.py` (new) registers
  **`add_symptom`** (immediate, empathetic, never diagnoses, `entity_id` is the
  symptom's own id not the medication's). `caregiver.py` gained **`add_care_note`**
  (immediate, writes the caregiver's OWN `conversation_turns` row — no
  act-on-behalf-of exists). Bulk commits emit ONE committed action via
  `base.py::record_bulk_action` (`{tool, summary, entities:[{entity_type,
  entity_id, changed_fields, ...}, ...]}`, the generic multi-entity contract
  alongside single `record_action`); `ChangeHighlight` is bulk-aware and rings ALL
  resolved entities simultaneously with one batch caption. `verify.py` is the
  read-only "re-query real state → pass/fail" pattern for Guided Auto-Navigation.
  `base.py` also holds the shared tool helpers: `find_medications` (exact `ilike`
  first, then dosage-suffix-stripped, then wildcard fallback — the exact-only form
  used to false-"not found" on a label-echoed "Metformin 500mg"), `first_id`
  (new-row id from an insert), `match_pending`/`match_pending_bulk` (the
  propose→confirm commit guards — read the session's `pending_*`/`pending_bulk`
  slot, so the Telegram deterministic-confirm contract is preserved), and
  `record_action`/`record_bulk_action`. Weekday constants (`WEEKDAYS`,
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
