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
  `{reply, tools_used, actions, walkthrough?, choices?}`). `choices` (2026-07-28,
  from `offer_choices`) is `[{label,value}]` the chat renders as tappable answer
  buttons; a tap sends the `value` as the next turn. **`awaiting_confirmation`
  (2026-08-02) is the DETERMINISTIC companion**: every propose→confirm tool
  already sets `session.awaiting_confirmation` (Telegram's ✅/✖ keyboard rides
  the same flag), so when the model didn't call `offer_choices` the web client
  synthesizes its own **localized** Yes/No pair — the client owns that text
  because a tapped value becomes the person's own chat bubble and their next
  message, and Hermes holds no translation table. It is reset **per turn** in
  `_build_context` (the flag is otherwise sticky across the persistent
  `http_sessions` state and would paint confirm buttons under unrelated replies).
  `lib/chatChoices.ts::buttonsFor`/`lastInteractiveIndex` is the shared decision:
  anchoring on "the last message that HAS buttons" rather than
  `messages.length-1` is what lets a turn both commit and ask a follow-up. `reply_language` (the app's Voice&Language
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

**Design system (2026-07-29 revamp).** All colour lives in `styles/theme.css` as
CSS variables — screens use `bg-primary`/`text-muted-foreground`/etc., never a
raw Tailwind palette class. Brand ramp: `#357266` pine `--primary` (nav, buttons,
the current-dose card), `#0E3B43` `--accent`, `#85B690` tints, `#E2DBBE`
`--muted`, `#F5F2E7` `--background`. **Dose status has its own tokens** —
`--taken-*` (palest green, recessive), `--upcoming-*` (saturated pine, leads),
`--missed-*` (orange, deliberately outside the brand ramp), `--warn-*`. Adding a
status colour means adding a token, not a class. `accessibility.tsx` layers
`contrast: normal|high|max` and `colourVision: off|deuteranopia|protanopia|
tritanopia` classes onto `<html>`, each overriding those same variables — which
is why hardcoded palette classes break accessibility, not just consistency. The
elder header is app-name-centred (help left, profile right) and the bottom nav
is oversized (26px icons, 13px bold labels) in both modes.
**`lib/language.ts` has a key-parity test — keep all six maps identical.**
`t()` falls back to English on a missing key, so a gap is invisible at runtime:
it simply renders English to someone who chose Tamil. 174 keys had drifted out of
all five non-English maps that way, including the ENTIRE `walk.*` corpus — which
is why every guided walkthrough ran in English regardless of the setting.
`language.test.ts` now asserts identical key sets, no duplicates, and identical
`{placeholders}` per key. Chat history persistence is per shell
(`mei-chat:{id}` / `mei-chat-cg:{id}`) with an **idle** 30-min TTL refreshed on
every message, and the elder chat restores its view mode from the restored
thread — returning to Ask Mei lands you back in the conversation, not the tiles.

**Stored medical vocabulary is English; DISPLAY is localized.**
`data/medications.ts::localizeCatalogValue(value, translate)` maps a stored
canonical value (conditions, allergies, drug allergies, and medication purposes —
one map, since `MEDICATION_CATALOG.purposeKey` shares the `catalog.condition.*`
vocabulary) to its translated label, falling back to the raw string for anything
free-text. Use it at every render site; the type-ahead's `withCatalogLabels` only
covers the dropdown. Real medical facts have **no mock fallback** — an elder with
an empty profile shows an empty list, never `data/patients.ts`'s demo conditions.

Gates: `npm run build` (transpile-only), `npm run typecheck` (`tsc --noEmit` —
a pragmatic non-strict `tsconfig.json`, added as a refactor safety net since the
build doesn't type-check), `npm test` (vitest), `npm run e2e` (Playwright).
Both have an AI assistant chat screen wired to Hermes:

- `screens/AskMeiScreen.tsx` — caregiver chat ("Ask Mei").
- `screens/elderly/ElderlyAIScreen.tsx` — **not a chat screen**: a grouped list
  of what Mei can do ("I can do this for you" — photo/report scan, travel sheet,
  doctor question; "I can show you how" — 10 narrated walkthroughs), with the
  chat itself as a full sheet behind one prominent card. The sheet auto-closes
  whenever a walkthrough starts, a ChangeHighlight fires, or a routed action
  navigates — otherwise it would cover the thing being shown.
- `screens/elderly/ElderlyNotificationsScreen.tsx` — the **Reminders** tab
  (renamed from Notifications): caregiver link requests, caregiver messages with
  Dismiss + Reply, and the elder's **questions for their doctor** (moved here
  from the AI screen, and now persisted to `doctor_questions` for real via
  `lib/doctor.ts::createDoctorQuestion`).
- `screens/elderly/ElderlySettingsScreen.tsx` — **one page, every setting on
  it**: search box at the top (a hit scrolls to the section that owns it),
  profile card (Edit button on the card), collapsible caregiver QR, then one
  card per area holding its controls in full. No "More settings". Two things
  open as their own screen, both because they aren't settings about this
  person's care: Edit profile (long form, own Save) and About Dosewise (about
  text + Switch to Caregiver Mode + Sign out).

Real backend wiring (Supabase + Hermes) exists for: login/signup, medication
CRUD, profile save, dose logging, travel plan, and the full chat/photo/report
agent flows. `apps/web/CLAUDE.md` has this app's own ownership rules — **it
normally forbids touching `services/hermes/` or `supabase/`**; cross-cutting
work across that boundary needs explicit user sign-off (as happened for the
Hermes wiring — see MEMORY.md).

**Every step shows the same action row.** Autonomous steps render Next (Done on
the last); user-driven `waitFor` steps render `components/WalkthroughWaitPill.tsx`
in the same slot — a NON-interactive indicator naming the real control ("Waiting
for you: Add Lisinopril"), derived from the target's own accessible name so it
can't drift from the UI. It is a `<div>` on purpose: `getByRole("button")`
matches disabled buttons too, and the consent specs prove their invariant by
asserting no advance control exists. Mei still cannot advance a consent step.

**The overlay's callout is rendered UNCONDITIONALLY — never gate it on the
spotlight having been measured.** It is the only host of the Exit button, so
gating it (as it was until 2026-08-02) strands the user on an opaque scrim with
no way out whenever a target is missing, renamed, or slow to mount. The measure
retry is a 4000ms budget matching `actor.ts::waitForEl`, the `waitFor` DOM
listener polls until its anchor exists, a step's `timeoutMs` is honoured, and an
act that could not be performed at all (target absent / wrong element type / a
select value matching no option) STOPS the run rather than advancing past it.

Mei can also run a **Guided Walkthrough**: a scripted, spotlight-and-narrate
overlay (`components/Walkthrough.tsx`) that highlights one screen element at a
time, but never fills/taps/submits on the user's behalf — every step ends
only when the real user performs the real action (native DOM listener, or an
app-emitted event via `lib/walkthrough/steps/` + `lib/walkthrough/bus.ts` for
actions no generic listener can tell apart, e.g. an async write's real
success). Started by Hermes's `start_walkthrough` tool (task name only — step
content stays client-side); see MEMORY.md's 2026-07-22 entry for the full
architecture and known gaps.

**An `*_auto` walkthrough is NOT a one-time introduction (2026-08-02).** It is
*how the write is performed* — Mei fills the real form and the patient taps Save.
`walkthrough.py::AUTONOMOUS_TASKS` is subtracted from `completed_walkthroughs`
in `prompts.py`, so those tasks stay offerable forever and neither shell writes
them via `markWalkthroughCompleted`. The "already shown" prompt block limits what
Mei may *volunteer*, never what she may *do* on a direct request. Getting this
wrong made adding a SECOND medicine skip the walkthrough entirely and become a
silent direct write.

**A wrong-shell walkthrough is refused at DISPATCH, not just client-side.**
`ToolContext.app_role` (set from the request in `_build_context`) lets
`start_walkthrough` return a recoverable refusal via `tasks_for_role`, instead of
queuing a task the client then declines to `console.warn` — which is what made
"what's my weekly summary?" land on the chat page with Mei promising a
walkthrough that never appeared. `app_role` is client-supplied and used ONLY for
this UI affordance, never for authorization. Both shells'
`handleWalkthroughStart` now also **return a refusal reason** the chat renders.

**A walkthrough resets the screens it needs.** `screenResetSignal` (mirroring
`openQuestionsSignal`) is bumped on start; Ask Mei returns to its help tiles,
Settings to its hub, Reminders restores the demo alert. A step's `onEnter` can
only switch bottom-nav tabs, so a screen already mounted in another internal
state never reset — and chat is exactly where a walkthrough is launched from.

**Autonomous steps do NOT auto-advance (2026-08-02).** Mei performs each step's
action at the `PACING` minimums, then the step HOLDS at a terminal commit gate
(`pace.ts::awaitNext`, a timer-less waiter) until the person taps Next — "Done"
on the last step. Within a phase, a Next after that phase's minimum still only
shortens the dwell; `nextRequested` keeps the two meanings separate so one tap
can never do both. `PACING` itself is unchanged — the gate does the anti-rush job.

**The autonomous `*_auto` walkthroughs (2026-07-28) also END with a manual
user-tapped Save**, not an autonomous submit: the fill steps stay animated/auto,
but the terminal step is a `waitFor` on the real Save button (skippable:false, no
Next), followed by an act-less verify/reveal tail — nothing commits on autopilot
(mirrors `accept_caregiver_link.ts`). That confirm step now also carries a
`review` list, rendering the live field values in the callout with a Change
button (`components/WalkthroughReview.tsx`) so the person can actually check what
Mei typed before committing it. The former spotlight-only tours
(language_voice/notifications/emergency/weekly_summary/patient_schedule/
caregiver_view_toggle) are now **AI-driven** (their `waitFor` steps became
`act:click`, except where the target is a handler-less container, which is an
act-less `reveal` instead — a tour must never claim an interaction that didn't
happen) — except consent steps (emergency Call, caregiver-link accept) which stay
user-tapped, and `onboarding` (real signup) which stays manual. **All six now
have real in-app launchers** (elder: Ask Mei category rows; caregiver: the Ask
Mei Quick-help sheet) — until 2026-08-02 they had NO entry point anywhere, which
is why the weekly-summary walkthrough looked like it simply didn't exist. The
resolver —
`lib/walkthrough/steps/index.ts::resolveWalkthroughSteps(task, role, params)`
over `steps/*.ts`, one file per task, 21 task names total (static step files and
`*_auto` param-builders alike) — accepts `role` but uses it only for
`link_caregiver` (a pure `switch(taskName)` otherwise). The cross-shell guard is
`walkthroughShellFor(task, role)` in the same file, which **derives** the shell
from the resolved steps' own first `screen.mode` rather than declaring it
separately (so it cannot drift from the step files); both shells'
`handleWalkthroughStart` refuse a wrong-shell task instead of mounting an overlay
that can only spotlight elements which don't exist. Hermes filters the same way
at source via `tools/walkthrough.py::tasks_for_role`, driven by the `app_role`
the client sends on `/agent/turn`.

In-progress walkthrough position (`lib/walkthroughState.ts`, sessionStorage,
30-min TTL) is keyed by **`{shell}:{userId}`** (`shell: "elder"|"caregiver"`,
2026-08-02) — required because a caregiver previewing their own elder view
(`caregiver_view_toggle_tour`) uses the SAME userId in both shells; keying by
userId alone let a caregiver-shell session leak into `ElderlyApp`'s
restore-on-mount, whose completion handler then re-wrote `profiles.role` to
`"elder"` on that same account (see MEMORY.md). `App.tsx` always passes
`"caregiver"`, `ElderlyApp.tsx` always passes `"elder"`.

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

**A screen that hides content behind a collapsed section must reveal it for a
highlight.** `ChangeHighlight` polls ~5s for `data-testid="{entity_type}-{id}"`
and then gives up; a collapsed accordion means the row isn't in the DOM at all,
so a discontinued medicine got the write with no ring and no caption. The screen
owns the fix (`ElderlyPrescriptionScreen` takes `highlightIds` and opens its own
"Past medications" list), not the highlight layer.

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
first-available where the OS ships no female voice, e.g. Tamil/Hokkien), then breaks
ties toward a **higher-quality voice** (`HIGH_QUALITY_VOICE_TOKENS` —
Enhanced/Premium/Natural/Neural — deprioritizing known-robotic "compact" voices;
quality never overrides the gender preference). `speak()` sets `utter.rate = 0.9`
(calmer pacing for the elderly audience) and runs replies through
`cleanTextForSpeech` first — strips markdown bold, and for English-only replies
expands `mg`/`mL`/`Dr.` (gated on the lang tag so non-English utterances never get
English words injected). A periodic `pause()`/`resume()` nudge every 12s while
speaking works around Chromium's crbug.com/335907 (long utterances silently stop
mid-sentence), cleared on `onend`/`onerror`. Whether Mei reads
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
  videos, walkthrough, verify, choices), registered via `tools/base.py`. **28 tools.**
  `caregiver` registers three: `message_caregiver`, `add_care_note`, and
  **`list_caregivers`** (2026-08-02 — read-only "who is my emergency contact?").
  The elder CANNOT read their caregiver's `profiles` row (RLS is
  caregiver→elder, not the reverse), so the name comes from
  `care_links.permissions.requested_by_name`; seeded/provisioned links carry no
  such key, so the unnamed fallback is a normal path. **No phone number exists
  anywhere in the schema** — the tool says so rather than inventing one, and
  `ElderlySettingsScreen`'s emergency card now reads the same `care_links` data
  (it used to render `data/patients.ts`'s fixture contact + phone on every real
  account, contradicting Mei).
  `refills` registers three: `check_refills`, `log_refill` (updates the pill
  COUNT), and **`request_refill`** (2026-07-28 — a refill REQUEST; inserts a
  `doctor_questions` row so it lands in the Ask-a-Doctor thread the caregiver
  also sees, `entity_type="doctor_message"`; distinct from `log_refill`).
  `choices` registers **`offer_choices`** (2026-07-28 — NOT a write; sets
  `ctx.choices=[{label,value}]`, surfaced on the agent-turn response so the web
  chat renders tappable answer buttons under Mei's reply, and prompts guide the
  agent to use it for yes/no confirms + guided clarifying questions).
  `medications` registers five: `add_prescription`, `set_medication_reminder`,
  `update_medication_dosage` (propose→confirm dose EDIT), **`discontinue_medication`**
  (2026-07-27, propose→confirm, sets `archived=true` — never deletes), `list_medications`.
  `add_prescription`/`update_medication_dosage` both run **`_dosage_warning`**
  (2026-07-28, `medications.py`) at propose time — a non-blocking ⚠ caveat, same
  tone as `_interaction_warning`, when a new dose is ≥2x the medication's own old
  dose (parsed via `base.py::parse_dosage`, mg/mcg/g-normalized, fails open on
  unparseable/incomparable values); `add_prescription` also runs it against a
  same-name medication already on file at a different dose (a disguised
  duplicate-as-dose-change), via `_existing_medication` (reuses `find_medications`,
  not a new query).
  `doses` registers five: `log_dose` (single — takes optional `medication_name` AND
  `slot`; the selection engine `_dose_plan` picks earliest-first among today's
  pending doses, asks when genuinely ambiguous and writes nothing until answered,
  proceeds silently when only one dose is plausible — the 2026-07-27 root-cause fix
  for "marking one named medication taken" unreliability, see MEMORY.md),
  `resolve_missed_doses` (the "all" bulk resolver, server-side missed-slot
  computation; optional **`slot`** filter, 2026-07-28 — `HH:MM` exact match or a
  day-part word within a bounded ±60min window, `_parse_slot_filter`/
  `_slot_filter_matches`, deliberately NOT `log_dose`'s unbounded nearest-neighbor —
  applied as a post-pass so the earliest-first missed-slot attribution is
  unaffected; omitted `slot` resolves everything, unchanged), **`log_doses`**
  (2026-07-27, EXPLICIT-list bulk — "I took my X and
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
