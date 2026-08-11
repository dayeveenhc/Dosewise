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
  session JWT (`{message, jwt, images_base64?, image_base64?, pdf_base64?,
  reply_language?}` → `{reply, tools_used, actions, walkthrough?, choices?}`).
  **`images_base64` (2026-08-10)** is the list form — the web composer can stage
  up to 5 photos on one turn, and every one becomes its own vision block in all
  three provider paths (`agent/loop.py`). The scalar `image_base64` is still
  accepted and is what Telegram sends; when both arrive the list wins, and the
  server caps the turn at 6. Only the FIRST image is staged as
  `session.pending_image`, because that slot exists solely so `add_prescription`
  can store one pill photo against the medication that gets confirmed.
  `choices` (2026-07-28,
  from `offer_choices`) is `[{label,value}]` the chat renders as tappable answer
  buttons; a tap sends the `value` as the next turn. **`alert` (2026-08-08, from
  `raise_alert`)** is `{severity,title,body,medication_name}` — something Mei
  judged must be acted on TODAY, surfaced by the HOST (not the chat screen) as a
  full-screen popup, so it still reaches someone who has navigated away. It is
  set on all THREE response shapes in `routes.py` (the non-stream body and BOTH
  `final` SSE dicts — that pair already drifted once on `choices`, and
  `test_final_event_key_set_matches_the_response_model` is what holds them
  together). Telegram ignores it: the tool's own return string is what the model
  speaks there, so a Telegram user still hears the warning as prose. **`awaiting_confirmation`
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
status colour means adding a token, not a class. The **caregiver shell now follows the same idiom** (2026-08-02): round header
controls, `dw-surface`/`dw-press`/`dw-display` everywhere, elder-style icon
rows (`w-9 h-9 rounded-xl bg-secondary` + `text-primary` glyph), at caregiver
text sizes rather than the elder's oversized type. `accessibility.tsx` layers
`contrast: normal|high|max` and `colourVision: off|deuteranopia|protanopia|
tritanopia` classes onto `<html>`, each overriding those same variables — which
is why hardcoded palette classes break accessibility, not just consistency. The
elder header is app-name-centred (help left, profile right) and the bottom nav
is oversized (26px icons, 13px bold labels) in both modes.
**A component ABOVE `LanguageProvider` must use `useStoredLanguage()`, never a
bare `readStoredLanguage()`.** `App.tsx` renders the provider, so it sits above
it and `setLanguage` can never re-render it — its caregiver header, confirm
dialogs and product tour all held a snapshot and stayed in the previous language
after a switch. `languageContext.tsx` now dispatches a `dosewise-language-changed`
event and exports `useStoredLanguage()` which subscribes to it (plus `storage`
for a second tab). The caregiver tour is additionally built by a
`<CaregiverTour>` wrapper rendered INSIDE the provider — once its strings are
handed to `<GuidedTour>` they live for the tour's whole lifetime — mirroring the
`ZoomContent` / `WalkthroughWithTrustMode` pattern. Everything inside the
provider should still use `useLanguage()`; this is the escape hatch, not the
pattern.

**`lib/language.ts` has a key-parity test — keep all six maps identical.**
`t()` falls back to English on a missing key, so a gap is invisible at runtime:
it simply renders English to someone who chose Tamil. 174 keys had drifted out of
all five non-English maps that way, including the ENTIRE `walk.*` corpus — which
is why every guided walkthrough ran in English regardless of the setting.
`language.test.ts` now asserts identical key sets, no duplicates, and identical
`{placeholders}` per key. Chat history persistence is per shell
(`mei-chat:{id}` / `mei-chat-cg:{id}`) with an **idle** 30-min TTL refreshed on
every message, and both chats restore their view mode from the restored
thread — returning to Ask Mei lands you back in the conversation, not the tiles.
**`openChatView` + `onOpenChatViewConsumed` (2026-08-07) force the conversation
view when the host is deliberately sending someone there to TALK** (the idle
popup's "Talk to Mei"), which the restored-thread seed cannot do on its own:
someone who launched the walkthrough from the help tiles has no thread to
restore, so that handoff deterministically showed the tiles. It is a nullable
value the child consumes and the parent clears — the exact
`autoMessage`/`onAutoMessageConsumed` shape, and **deliberately NOT a monotonic
counter**, which is the `screenResetSignal` bug MEMORY.md documents. The
caregiver `AskMeiScreen` also gained the two things it was missing against the
elder screen: a **bidirectional** `ai.backToChat` pill (its switch used to
render only in chat mode and only go chat→help, and every `setMode("chat")`
there is a side effect of sending — so the help list was a one-way door out of a
live thread), and the 60s idle-TTL sweeper.

**Stored medical vocabulary is English; DISPLAY is localized.**
`data/medications.ts::localizeCatalogValue(value, translate)` maps a stored
canonical value (conditions, allergies, drug allergies, and medication purposes —
one map, since `MEDICATION_CATALOG.purposeKey` shares the `catalog.condition.*`
vocabulary) to its translated label, falling back to the raw string for anything
free-text. Use it at every render site; the type-ahead's `withCatalogLabels` only
covers the dropdown. **The lookup is alias-backed (2026-08-07).** It was an
exact lowercase match, and what is STORED did not match what the catalog KEYS —
`Type 2 Diabetes` vs `Diabetes`, `Hypertension` vs `Blood Pressure`,
`Osteoarthritis` vs `Joint Pain`, `Atrial Fibrillation` with no entry at all —
so 5 of 6 fixture conditions rendered raw English **on screens that called the
localizer correctly**. `CATALOG_ALIASES` (~200 synonyms, added AFTER the
canonical loops since `add()` is first-wins, so a synonym can never displace a
real value) plus `catalogKeyOf()` normalisation (trim/lowercase/collapse
whitespace/strip a trailing parenthetical) closes it. Free text still falls
through unchanged — that is the design, not a gap.

**Post-write captions are localized at the PRODUCER.** `lib/changeHighlight.ts`
takes an optional `CaptionOptions {language, timeFormat}` threaded through
`describeChange`/`describeBatch`/`humanizeField`/`hhmmTo12h`; omitting it yields
English/12h, so older call sites are unchanged. `HighlightCaption` receives
finished text, which is why the keying cannot live in the component.
`hhmmTo12h` now honours `timeFormat: "24h"` and moves AM/PM per language
(`caption.clock12h`). `orchestrate.ts::captionFromVerify` uses a `readerCaption()`
export that resolves language + time format from the same localStorage the
providers write, because that module is deliberately React-free.
**Known remaining gap:** `describeChange` still prefers the backend's
`a.summary`, which Hermes composes in English — so a real action can render a
localized verb with an English detail. Closing that belongs in Hermes. Real medical facts have **no mock fallback** — an elder with
an empty profile shows an empty list, never `data/patients.ts`'s demo conditions.

Gates: `npm run build` (transpile-only), `npm run typecheck` (`tsc --noEmit` —
a pragmatic non-strict `tsconfig.json`, added as a refactor safety net since the
build doesn't type-check), `npm test` (vitest), `npm run e2e` (Playwright).
Both have an AI assistant chat screen wired to Hermes:

- `screens/AskMeiScreen.tsx` — caregiver "Ask Mei". **Rebuilt on the elder
  screen's shape (2026-08-02):** one title row carrying a help↔chat switch, a
  permanent composer (camera + mic *inside* the field), and a searchable help
  view. Unlike the elder screen it uses **two flat labelled sections**
  (`ai.sectionDoIt` / `ai.sectionShowHow`) rather than category tiles — a
  caregiver's list is shorter at smaller text, and, decisively, it keeps
  **Weekly Summary a top-level row**, which is the anchor
  `weekly_summary_tour` (and e2e s29) spotlights. The "show you how" section
  launches the four caregiver-shell walkthroughs (`patient_schedule_tour`,
  `weekly_summary_tour`, `link_caregiver`, `caregiver_view_toggle_tour`).
  Selectors `data-tour="cg-askmei"` (the title row, which contains the "Quick
  help" switch) and `data-walk="cg-weeklysummary-tile"` are load-bearing —
  don't rename them without updating those steps + s29.
- `screens/setup/SetupMethodScreen.tsx` — the "How would you like to set up?"
  screen reached from the "For a loved one" / "For myself" picker. HealthHub
  (disabled placeholder), Upload records, Guided questions, and — **caregiver
  mode only** — "Scan a loved one's QR code" (`data-walk="setup-method-scan-qr"`),
  which opens `ScanLinkSheet` in its **deferred** mode. There is no session yet at
  that point and RLS 0005 requires `caregiver_id = auth.uid()`, so the scan only
  decodes: `App.tsx` holds the payload in `pendingCareLink` across the wizard's
  account step and `GuidedSetupWizard.finish()` calls `createLinkRequest` after
  `saveProfile`. Covered end-to-end by `e2e/caregiver-onboarding-link.spec.ts`.
- `components/ScanLinkSheet.tsx` — the one QR scanner, used from both the
  caregiver dashboard's `PatientSwitcher` (writes the `care_links` row itself)
  and onboarding (defers, via `onScanned`). Besides the live camera it accepts an
  **uploaded photo** of the code through `html5-qrcode`'s `scanFile` — the only
  way through when the camera is denied, which is also why the upload button
  renders in the error phase and not just while scanning.
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

**Autonomous steps render Next (Done on the last) in the action row;
user-driven `waitFor` steps render NO control there at all (2026-08-09).** The
"tap THIS" cue for a waitFor step is the spotlight itself: the main-rect glow
overlay gains `.dw-spotlight-glow-wait` (theme.css — one `.dw-gate-ready`-style
arrival beat, then a much stronger resting ring; never a looping pulse). This
replaced `WalkthroughWaitPill.tsx` (DELETED, with its `walk.waitingFor.*` keys
×6) — the pill named the control in words while the control itself stayed
quietly lit, and its copy collided with step instructions that already said
"Tap X". The consent invariant is unchanged and simpler: a glow overlay is
`pointer-events-none` by construction, and `Walkthrough.test.tsx` still proves
no advance-shaped control exists on a waitFor step. Mei still cannot advance a
consent step.

**The overlay's callout is rendered UNCONDITIONALLY — never gate it on the
spotlight having been measured.** It is the only host of the Exit button, so
gating it (as it was until 2026-08-02) strands the user on an opaque scrim with
no way out whenever a target is missing, renamed, or slow to mount. The measure
retry is a 4000ms budget matching `actor.ts::waitForEl`, the `waitFor` DOM
listener polls until its anchor exists, a step's `timeoutMs` is honoured, and an
act that could not be performed at all (target absent / wrong element type / a
select value matching no option) STOPS the run rather than advancing past it.

**The cutout is kept on its target by a per-frame RECT DIFF, not by listening
for the things that move it (2026-08-06).** `Walkthrough.tsx`'s measure effect
runs one `getBoundingClientRect` per frame for the life of the step and pushes
state only when the box actually changed (0.5px epsilon); scroll/resize
listeners remain, but they are no longer the mechanism. `GuidedTour.tsx` (the
passive product tour) runs the same watcher since 2026-08-09 — it had been
measure-once-per-step, which drifted on Supabase-fetch mounts and on the
font-size step's own invited reflow. `.walk-field-prehighlight` animates the
individual `translate` property (2026-08-09), never `transform` — a filled
animation on `transform` overrides the inline `translateY` lift. Enumerating movers does
not work here — the target is translated by `.walk-field-prehighlight` (-3px,
`both` fill), by `targetLiftPx`'s repositioning (up to ~330px, applied to the
nearest `[data-walk]` ANCESTOR, so neither an attribute observer nor a bubbling
`transitionend` on the target itself sees it), and by ordinary container
expand/collapse. Before this, the cutout was measured on step entry and left
there: every field step sat 3px off and the Save step of `edit_profile_auto` /
`travel_mode_auto` drew its highlight ~300px above the button the callout was
naming. The step-change cleanup also clears `transition` BEFORE `transform`, so
undoing a lift is instant rather than a 320ms animation the next step's first
measurement lands inside. `targetLiftPx` is re-derived (no longer one-shot) from
the UN-LIFTED position — current rect minus the transform the browser is
*currently rendering* — which is what makes re-deriving stable instead of
oscillating. There is **no** CSS-`zoom` coordinate bug: the overlay is a sibling
of each shell's zoomed content div, verified clean at zoom 1.25 and 0.85 —
in **both** shells as of 2026-08-07 (the caregiver `<ZoomContent>` boundary was
the standing gap; its case now measures `zooms=[1,1,1.25]`, i.e. the boundary is
genuinely crossed, with zero findings).

**All THREE cutouts are watched, and the callout LANDS on a new step rather than
gliding to it (2026-08-07).** `changeRect` (the hole opened by the review card's
"Change" button) was a one-shot measured in `focusFirstReviewField` and never
re-measured — though tapping Change is exactly what reflows the sheet; it is now
a selector in a ref that the same per-frame `recompute()` measures, and it
finally has the `.dw-spotlight-glow` the other two always had.
`SpotlightCallout`'s `transition-[top] duration-300` is right WITHIN a step
(following a moving target) and wrong across one — the cutout jumps next frame
while the card travels, so for 33-186ms it sat across the target it describes;
the new `animateTop` prop is false for two frames after `stepIndex` changes.
`actor.ts::pressPulse` now COMPOSES its `scale(0.94)` onto the live inline
transform with `translateY` first, instead of replacing it: step selectors *are*
`[data-walk]` nodes, so `closest("[data-walk]")` usually returns the target
itself and the old code threw the lift away for ~460ms mid-click.
**`placement.ts` exposes `calloutPlacement() → {top, cleared}`** (`calloutTop`
is now just `.top`, so `GuidedTour` is untouched). Its third branch evaluates
both clamped candidates and keeps whichever covers LESS of the target — "take
the roomier side" is wrong, because the roomier side can still be shorter than
the callout and the clamp then drags it back across. `cleared:false` means no
placement could clear the target at all (it is taller than the usable band); it
is surfaced as `data-walk-callout-cleared` on the overlay root and is a
**step-content signal** — shorter copy or a smaller selector — not something
geometry can fix.

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

**Autonomous steps do NOT auto-advance (2026-08-02), UNLESS the person has
earned TrustMode (2026-08-04).** Mei performs each step's action at the
`PACING` minimums, then the step HOLDS at a terminal commit gate
(`pace.ts::awaitNext`, a timer-less waiter) until the person taps Next — "Done"
on the last step. Within a phase, a Next after that phase's minimum still only
shortens the dwell; `nextRequested` keeps the two meanings separate so one tap
can never do both. `PACING` was retuned ~1.4x slower across the board
(2026-08-09) — the gate still does the anti-rush job.
`orchestrate.ts::runActStep`'s terminal gate now branches on a
`requireExplicitAdvance` signal computed by the host from
`accessibility.tsx`'s `walkthroughManualMode || walkthroughCompletionCount <
TRUST_MODE_THRESHOLD` (3, `lib/walkthrough/pacing.ts`) — a first-timer or
manual-mode user keeps the tap gate unchanged; a veteran instead auto-advances
after `READY_AUTO_MS` (1250ms) with zero taps. **The LAST step AUTO-CLOSES
(2026-08-09, later the same day):** `isFinalStep` routes the terminal gate to
`pace.awaitNextOrTimeout("ready", PACING.FINAL_AUTOCLOSE_MS)` (4000ms) — Done
still closes immediately, Replay re-runs the reveal (opening a fresh window),
and once the window elapses the walkthrough returns to the app on its own, for
EVERY trust level. This deliberately reversed the same-morning "final Done is
always the person's" hold at the user's explicit request ("whenever a
walkthrough is done, it goes back to the normal app"). An ERRORED final step
(verify-failed / stalled) now renders a primary Done that calls **`onExit`,
never `onAdvance`** — a failed run must not record a completion or earn
TrustMode credit — so the lone grey "Exit walkthrough" dead-end is gone. The
10 tours whose last step is a real `waitFor` action still end on the person's
own action, untouched. `walkthroughCompletionCount` is
device-local and counts **any** completed walkthrough (incremented at the same
`handleWalkthroughAdvance` call site as `markWalkthroughCompleted`, but
deliberately NOT gated on `AUTONOMOUS_TASKS` the way that call is — it's a
different "completed" concept, see the field's own doc comment) — distinct
from `lib/profile.ts`'s server-synced `ProfileDetails.completedWalkthroughs`
set, which only suppresses Mei's proactive re-offers. The same
`requireExplicitAdvance` signal, ORed with its own `risk.flagged`
(RiskClassifier, `services/hermes/tools/risk.py`, threaded onto the `*_auto`
family's `start_walkthrough` response), separately gates a Confirm phase
`orchestrate.ts` runs between Act/Verify and the real Submit step — a
risk-flagged instance always forces its own tap there regardless of trust
level, but the terminal gate itself never re-checks risk (by the time a step
reaches it, either it had no Confirm phase, or Confirm already forced and
consumed the one tap the risk warranted). `App.tsx` (caregiver) can't call
`useAccessibility()` from its own body — it owns `AccessibilityProvider`
itself, the same structural problem `App.tsx`'s own `ZoomContent` (a small
component that resolves the Text-size content zoom from inside the provider)
already exists to solve — so a sibling wrapper, `WalkthroughWithTrustMode`,
computes the trust signal from inside the provider and stashes
`incrementWalkthroughCompletionCount` on a ref that `handleWalkthroughAdvance`
(a plain closure, not a hook) reads.
Settings toggle: "Guide me through each step manually"
(`ElderlySettingsScreen`'s voice/language card,
`data-walk="elder-walkthroughmanual-toggle"`; `SettingsScreen`'s matching
Switch row).

**AutoNav is one fast-forward toggle pinned to the OVERLAY's top right
(2026-08-07, `data-walk="walk-autonav"`)** — not the "Auto | Step by step"
segmented row that used to sit in `SpotlightCallout`'s (now removed) `aside`
slot below the review card, where it was easy to miss. Pinned to the overlay
rather than the callout because `placement.ts` moves the callout every step.
Per-mount state seeded from `autoNavDefault={!walkthroughManualMode}`;
`rounded-full` + a `data-walk` carve-out so `Walkthrough.test.tsx`'s consent
invariant (which now excludes by `data-walk`, not by class name) still reads
"the only advance-shaped control is Exit". Three behaviours are load-bearing:
- It feeds **`computeHoldGate(steps, index, autoNav)`**. That function collapses
  two shapes; only the first is a convenience and only the first is suppressed
  when Auto is off — a run of consecutive field fills. The second (a `click`
  that opens the surface the next step fills) is a CORRECTNESS fix, since
  holding there leaves the spotlight on a control the new sheet just buried, and
  applies in both modes. Before this split the toggle was a lie: measured live,
  a run with Auto OFF still walked Step 1 → Step 4 on its own.
- Turning Auto ON **releases the gate the run is parked at**, gated on a
  `readyIsTapGatedRef` recorded at step start. Without that ref it also fires on
  an already-auto-elapsing gate and silently cuts `READY_AUTO_MS`'s beat to zero
  on every auto run. Terminal `ready` only — that phase is post-act, so
  resolving it re-runs nothing; never Confirm (risk/trust/blank decide that),
  and `waitFor` steps never reach `ready`. The LAST step's timed
  `FINAL_AUTOCLOSE_MS` gate is never tap-gated, so the ref alone keeps the
  toggle from cutting the finale short.
- `e2e/helpers.ts::useStepByStepNav` locates it **by `data-walk`, never by
  accessible name** (the name is localized and changes with its own state), and
  the sense is inverted for a single toggle: press it when it reads pressed.

**IdleTimeout (2026-08-04) watches ONE computed signal, never a phase-name
allowlist.** `Walkthrough.tsx` derives `waitingOnUser` from the same
TrustMode/ConfirmBack-Phase state everything else above already reads
(`step.waitFor`, `paceState.phase`, `requireExplicitAdvance`,
`confirmTapRequiredRef`, `confirmBlocked`) — true only during a `waitFor`
step, a tap-gated terminal "ready", a tap-gated Confirm, or a blocked
clarifying question; false whenever the equivalent phase is auto-elapsing
for a veteran, or the step is stalled/errored. A window-level effect (armed
only while `waitingOnUser` is true) fires a "still there?" popup
(`WalkthroughIdlePrompt.tsx`) after `IDLE_TIMEOUT_MS` (20s,
`lib/walkthrough/pacing.ts`, a sibling export next to `PACING` — a ceiling,
not a floor) of zero interaction; any `pointerdown`/`keydown`/`scroll`
anywhere on the page (capture-phase, since the real spotlighted target lives
outside this component's own `pointer-events-none` subtree) resets it, as
does `requestNext()`'s two call sites and the review card's "Change" tap.
When a `waitFor` step also carries its own `timeoutMs` (the "give up, show
`walk.timedOut`" budget — two steps use exactly 20000, the same as
`IDLE_TIMEOUT_MS`), the popup's arm delay is pulled ≥1s ahead of it so the
popup always reaches a stuck person before the honest dead-end, never racing
it on effect-registration order.
Popup actions (2026-08-07): **Talk to Mei · End the walkthrough · I'm still
here, continue.** "Skip this step" and "Explain this step again" were both
DELETED, not renamed. Skip called `paceRef.requestNext()`, which on a Confirm
phase resolves that phase's gate rather than skipping the step — the label
described something it did not do — and it was correctly absent on `waitFor`
steps, i.e. missing exactly where a stuck person wanted it. Explain was the only
consumer `WalkthroughStep.voiceKey` ever had, so **`voiceKey` is deleted from
`types.ts` too** rather than left declared-and-unused (the `skippable` /
`WALKTHROUGH_TASK_LABELS` anti-pattern this repo has paid for twice), and the
`voiceOutput` prop went with it — no walkthrough narration reaches TTS any more.
"Talk to Mei" hands off to the chat surface (host-owned: exits the walkthrough,
then `openAI()`/`setScreen("ai")`) **and now sets `openChatView` so it lands in
the CONVERSATION** — see the chat-restore note below.

**The autonomous `*_auto` walkthroughs (2026-07-28) also END with a manual
user-tapped Save**, not an autonomous submit: the fill steps stay animated/auto,
but the terminal step is a `waitFor` on the real Save button (skippable:false, no
Next), followed by an act-less verify/reveal tail — nothing commits on autopilot
(mirrors `accept_caregiver_link.ts`). **That Save step waits on the WRITE, not
the click (2026-08-10, `add_prescription_auto`):**
`{type:"write-committed", source:"app-event", event:"medication-saved"}`, emitted
by `AddPrescriptionSheet::handleAdd` after `await onAdd(...)` resolves. A `click`
wait ended the step while the insert was still in flight, so the next step's
Verify re-queried an empty table and the run stopped at "I couldn't confirm that
saved" (and its recovery path then wrote the medicine a SECOND time) — and it
never fired at all when the dose-safety dialog made `handleAdd` return early,
stranding the run on a step that is neither autonomous nor stalled, i.e. a
callout with NO Done at all. The step carries `timeoutMs: 60000` because a bus
signal that never arrives (a save that threw emits nothing) is the one way this
shape can still hang — deliberately NOT the 20000 the QR-decode/agent-commit
steps use, since `armTimeout` never resets and `IDLE_TIMEOUT_MS` is 20000 too, so
that budget would time out a person who was merely reading. The errored/stalled Done in `Walkthrough.tsx` is no
longer gated on `isLastStep` — a stalled step at ANY index offers a real way
back. `Walkthrough.tsx`'s `failedRef` also feeds `shouldCancel`, so a stalled
final step can't sail through its timed gate and bank a completion. That confirm step now also carries a
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

**Prescriptions can carry a fixed COURSE (2026-08-08).** "Take this for 2
weeks" is stored as `end_date` inside the existing `medications.schedule` jsonb
— no migration, since `schedule` is already in every select list that matters.
The date is the LAST day a dose is due, **inclusive**, and that is pinned on
both sides: `lib/medications.ts::isDueOn` and `dosing.py::scheduled_today`
implement the same rule, so the app and the reminder scheduler cannot disagree.
The course gate is checked FIRST, beating every cadence below it, and every
parse failure FAILS OPEN — a medicine that silently stops reminding is worse
than one that reminds a day too long. Auto-cancel is **derived at read time**:
no cron, no write-on-render. `courseDaysLeft()` is the one helper behind the
countdown chip, the finished-card state and the alert tier. Past its last day a
medicine stays `archived=false` and produces no doses, showing a "Course
finished" card whose one-tap "Move to past medicines" calls the existing
`archiveMedication` — deliberately a human tap, since archiving is the same
state `discontinue_medication` writes. **`updateMedication` now MERGES the
schedule** (read → spread → explicit deletes for the cadence not chosen) rather
than writing `buildSchedule()` wholesale, which silently destroyed any key the
sheet didn't know about; `set_medication_reminder` had always merged, and that
asymmetry is what made this a latent data-loss bug. `add_prescription` takes an
optional integer `duration_days` (inclusive, recomputed at COMMIT so a proposal
held overnight isn't off by one), and `add_prescription_auto` gains two
conditional `act:click` steps driving real preset buttons — including a
dynamic exact-value preset, so a 5-day course is never snapped to 7.
**`add_prescription_auto`'s params also carry `times` (2026-08-10)** — the dose
times as ONE comma-separated 24h string (`"12:00"`, `"08:00,20:00"`), since
`walkthrough.py` `str()`-coerces every param and a real list would arrive as the
literal `"['12:00']"`. Before this the params were `{name, dose, purpose,
duration_days?}` only: on web Mei commits through the walkthrough, never
`add_prescription(confirmed=true)`, so the `times` she had just read back died at
the handoff and the sheet used `defaultDoseTime(routine)` — someone who said "one
at 12 pm" got an 8am reminder. `parseTimesParam` (exported from the step file,
returns canonical `HH:MM` and DROPS junk loudly — unlike `to24h`, which answers
`"08:00"` for anything it can't parse) feeds `AddPrescriptionSheet`'s new
`initialTimes` prop, the Confirm recap's time row (`data-walk="rx-time-value"`),
and both direct-save fallbacks (`App.tsx`'s caregiver branch,
`handleWalkthroughVerifyFailed`). The sheet SEEDS the picker rather than a step
clicking a quick chip: the chips toggle, so clicking "noon" would leave the 8am
default selected beside it and schedule two doses.
**The same pass closed the `interval_days` divergence** `lib/medications.ts` had
documented since 2026-07: `scheduled_today` now understands it, so an
every-other-day medicine is no longer reminded daily and reported missed on its
off days.

**Urgent alerts are one evaluation feeding three surfaces (2026-08-08).**
`lib/alerts.ts::buildAlerts` is pure and React-free: it returns an `Alert[]`
sorted `critical → urgent → notice`, and the Reminders tab, the bottom-nav badge
and the proactive popup all read the SAME array — so they cannot disagree, and
one acknowledgement clears all three. Severity is derived from signals that
already existed rather than a new field nobody writes: `medications.priority`
(the `med_priority` enum `channels/scheduler.py` already escalates on, now
selected by `fetchElderMedications`), real `refills.pills_remaining` data, and
the FOUR `NotificationPrefs` toggles — which map one-to-one onto the four
trigger classes, so the popup's per-class gate was already built, persisted and
localized. `CRITICAL_SUPPLY_DAYS = 3` sits under the existing
`LOW_SUPPLY_DAYS`/`REFILL_PROMPT_DAYS` scale rather than adding a fourth.
**Ordinary missed doses alert too (2026-08-09, `missed_dose`):** a
non-critical medicine past its slot by `MISSED_DOSE_GRACE_MIN` (60 — matches
Home's `DUE_WINDOW_MIN`, so the timeline's "due now" and the alert can't
contradict) raises severity `urgent` — bell-tier popup once a day, Reminders
card, badge — behind the same `missedDoseAlerts` toggle; critical keeps zero
grace and the `critical` tier. Vague slots ("after breakfast") are SKIPPED for
the ordinary tier (`to24h`'s 08:00 fallback would nag at a fictional time),
and `buildAlerts` now takes `doseSnoozes` — a `snooze_dose` entry shifts the
due time to its `until` for BOTH tiers. Underneath this,
`fetchElderMedications` attributes taken doses PER SLOT via
`assignTakenSlots` (exact local-HH:MM `scheduled_at` match first, then
earliest-first for leftovers — `doses.py`'s rule): one taken row no longer
marks every slot of a multi-time medicine taken, which had hidden exactly the
missed evening slot this feature exists for.
**The elder Reminders low-stock card was a hardcoded `"Metformin"`/`4 days`
literal and is now real data** — which means it can be ABSENT, so
`notifications_tour` is refused at dispatch when nothing is outstanding
(`walk.refused.nothingToShow`, the same shape as `request_refill`'s existing
`nothingLow` gate) and its `notif-refill-row`/`notif-ack-btn` anchors ride the
first supply alert rather than a fixed medicine. `e2e/scenarios/s19` therefore
seeds a real `refills` row now.
**Where an alert SENDS you is decided only in `destinationFor` (2026-08-09).**
`lib/alerts.ts::destinationFor(alert) → {tab, focusMedicationId?, focusMedName?}`
is a table in `lib/` beside `changeHighlight.ts`'s `ENTITY_TARGETS` and
`agentActions.ts`'s `ACTION_TARGETS`; supply/course → Medications, missed →
Home, everything else → Reminders. It replaced an inline ternary inside
`ElderlyApp`'s popup, which is why only the popup could route and the Reminders
cards were inert. Routing is DEEP: `ElderlyApp::goToAlert` sets the tab and a
nullable `focusMed` (the `pendingPrefill` idiom — carries id AND name, since a
demo/local row has no uuid) that `ElderlyPrescriptionScreen` consumes to open
the medicine's detail PAGE and `ElderlyHomeScreen` consumes to scroll the dose
into view. (That consumption is guarded on `!highlightIds?.length`: a highlight
CLOSES the detail page, because the ring needs the list, so an alert route
arriving in the same commit would re-open it and swallow the proof.) Its two derived predicates, `canViewAlert` (there is somewhere else
to go) and `canTellCaregiver` (the alert is about a *medicine*), gate the CTAs
identically on both surfaces: the popup's `onView` is now passed
CONDITIONALLY, which is what finally makes `UrgentAlertPopup`'s documented
"absent when there is nowhere to go" contract real rather than dead code, and
each Reminders card carries the same pair above its Dismiss/Request-refill row
(a 2×2 grid — never a container `onClick`, since `notifications_tour` documents
that row as click-less and auto-clicks `notif-ack-btn` inside it).
"Tell my caregiver" hands the alert to Mei as a prefilled, unsent message — on
the Reminders CARDS only. **The popup dropped that button (2026-08-11)**, and
that is a removal rather than a narrowing: the only kinds `canTellCaregiver` is
true for are the medicine-backed ones (missed dose, low/out of supply), which
are exactly the ones a person answers themselves one tap away; every other kind
that can interrupt already got `false`, having no focusMedication.
**Whether an alert may INTERRUPT is decided only in `pickPopupGroup`** — tier,
preference toggle, once-per-day dedupe, cooldown, quiet hours, and suppression
behind any other modal — so every anti-nag rule is in one testable place.
`pickPopupAlert` survives as a thin wrapper (`pickPopupGroup(groupForPopup(a))?.
lead`) purely so its eight-case suite keeps guarding all of those rules.
**Alerts are GROUPED for the popup (2026-08-11)**: `groupForPopup` folds
missed-critical + missed-dose into one interruption and out-of-supply +
low-supply into another, so three missed doses are one popup that says "three"
rather than three identical ones. `care_link_request` must NEVER aggregate (a
consent prompt that hides who is asking), nor `agent` (its title/body are model
prose there is nothing to summarise into). Dismissing acknowledges EVERY member,
so the badge can't keep shouting behind a popup just answered.
**Two coupled ladders** replace the flat 30-minute cooldown: the interval
stretches (urgent 30m→2h→done; critical 20m→45m→90m→3h→6h) while a meter in the
popup fills and its tier copy escalates. The ladder's LENGTH is the anti-nag
guarantee — past its end the group never interrupts again that day and lives on
the Reminders tab and the badge. "One sitting" needs no new concept: the state
is already sessionStorage. `alertState.ts::poppedIdsFor` is the day-filtered
bridge between the store's `{id}|{date}` keys and the bare ids the pure
functions compare — they disagreed until 2026-08-11, so the once-per-day dedupe
had never actually fired.
`components/UrgentAlertPopup.tsx` reuses `WalkthroughIdlePrompt`'s shape but
carries its OWN `z-[120]`: above the Add-prescription sheet (`z-50`) and the nav
(`z-40`), below the walkthrough overlay (`z-[200]`, whose callout is the only
host of Exit) and the toasts (`z-[300]`). Dedupe is **sessionStorage**
(`lib/alertState.ts`, keyed `{shell}:{userId}` like `walkthroughState.ts`)
because every elder screen unmounts on a tab switch — an in-memory Set would
re-pop on every round trip. `inQuietHours` is a direct transcription of
`dosing.py::in_quiet_hours`, wrap-around branch included, and only a `critical`
alert overrides it. The alert evaluation rides the EXISTING 30s poller in
`ElderlyApp.tsx`, deliberately ABOVE that poller's `Notification.permission`
early-return: an in-app popup has no dependency on the OS prompt and must not
inherit that gate.

**A screen that hides content behind a collapsed section must reveal it for a
highlight.** `ChangeHighlight` polls ~5s for `data-testid="{entity_type}-{id}"`
and then gives up; a collapsed accordion means the row isn't in the DOM at all,
so a discontinued medicine got the write with no ring and no caption. The screen
owns the fix (`ElderlyPrescriptionScreen` takes `highlightIds` and opens its own
"Past medications" list), not the highlight layer.

**The medicine detail page (2026-08-11)** is a SUB-VIEW of the prescriptions
tab, reached by tapping a card, not a new `ElderlyTab`: widening that union
would touch `alerts.ts::destinationFor`, `changeHighlight`'s ENTITY_TARGETS and
every walkthrough step's `screen.tab`. It uses ElderlyApp's `headerOverride`
(the `ElderlySettingsScreen` profile/about idiom — the owning screen sets the
title + back and clears it on unmount), and the nav stays visible.
`screens/elderly/ElderlyMedicationDetail.tsx` shows the medicine in full and
offers Edit (the existing `AddPrescriptionSheet editing=` path), **I've refilled
it** (`components/AddRefillSheet.tsx` → `lib/medications.ts::logRefill`, the
supply on hand — NOT the same as Request refill, which asks the doctor via
chat), and **Remove from my list** (archive behind ConfirmDialog, available on
ANY medicine here rather than only a finished course; DELETE is denied by
migration 0004, so `archived = true` remains the only removal). Two rules bind
it: it must carry **`data-testid="med-detail"` + `data-med-id`, never a testid
ending in the uuid** (`findEntityElement` falls back to `[data-testid$="-{id}"]`
and takes the first match in DOCUMENT order, and four e2e specs assert exact
counts of `[data-testid^="medication-"]`), and it must **consume
`screenResetSignal`** — `request_refill`'s step carries
`onEnter: {tab:"prescriptions"}`, a no-op when already there, so a detail page
left open hides `med-request-refill-btn` and a `waitFor` step has no Next.

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

**Some top-level `e2e/*.spec.ts` files are STALE and fail for reasons that have
nothing to do with current work.** Check their `git log -1` date before
diagnosing: five walkthrough specs never tap the manual Save the 2026-07-28
contract requires (`travel-mode-auto`, `edit-profile-auto`, `add-condition-auto`,
`add-prescription-auto`, `reveal-caption`) — **their last commit is 2026-08-08
(`21681aa`), not 2026-07-24 as this file long claimed, but that commit only
renamed `startWalkthrough`→`startWalkthroughAuto`; no Save tap was added, so the
staleness stands** (`travel-mode-auto` additionally asserts hard-coded dates that
are now in the past); three more are frozen at 2026-07-26 and assert on
`.border-stone-800`, a raw Tailwind class the 2026-07-29 design revamp deleted
(`bugfix-highlight`, `scenario1-dose-taken`, `scenario6-dosage-update`). All are
superseded by the governed `e2e/scenarios/sNN` modules below, which do handle
both and do pass. `e2e/helpers.ts` offers **`startWalkthroughAuto`** (Auto, for
specs that watch a flow reach its outcome without tapping) alongside
`startWalkthrough` (step-by-step, for specs that assert gate by gate).

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

Voice INPUT is client-side (browser Web Speech `SpeechRecognition`), not routed
through Hermes; it degrades gracefully where unsupported.

Voice OUTPUT has **two paths behind `lib/speech.ts`**, and the chat screens +
the walkthrough's "explain this step again" all call the first:
- `speakReply()` — asks Hermes `POST /voice/tts` for a real neural voice
  (OpenAI `gpt-4o-mini-tts`, `agent/tts.py`) and plays the mp3 via `Audio()`.
  This is the only path with any prosody control: the model takes a free-text
  delivery *instruction* (`OPENAI_TTS_INSTRUCTIONS`, warm/unhurried/expressive),
  which Web Speech has no equivalent of at all. **Falls back to `speak()` on any
  failure** — 503 (no key configured), offline, signed out, autoplay blocked —
  so spoken replies never go silent, they just get plainer.
- `speak()` — the browser `speechSynthesis` path, unchanged and still the whole
  story on a deploy with no OpenAI key.
One `speakGeneration` counter guards BOTH, so a newer call always supersedes an
in-flight clip or utterance.

The `speak()` path goes through the shared `lib/speech.ts::speak`
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
- `api/routes.py` — `/health`, `/agent/turn`, `/telegram/webhook`,
  `/profile/extract` (the structured "pull" API: reads an uploaded PDF/photo and
  returns `{fields}` for onboarding autofill; API-key gated but **jwt-free** since
  it's stateless — no Supabase/identity; impl in `agent/extract.py`),
  **`/prescription/extract`** (2026-08-11 — the same "pull" shape for a
  medication LABEL: `{fields}` = name/dose/purpose/times/frequency/duration_days/
  instructions plus `inferred[]`, the fields the model derived rather than read.
  This is what replaced the chat loop in the add-prescription sheet's scan tab,
  which used to answer a label photo by asking what the dose and frequency were.
  The dose rail is preserved by construction: the schema instructs the model to
  OMIT a dose it can't read rather than list it in `inferred`, so no number can
  be invented server-side; the app fills such blanks from MEDICATION_CATALOG and
  badges them "Please check". jwt OPTIONAL — when present it buys a per-user
  `extract:` bucket on top of main.py's per-IP limiter. Shares the three
  provider helpers with the profile extractor, which are parameterised on
  (tool, schema, system) — `test_profile_extract.py` passing unchanged is the
  proof that refactor was behaviour-preserving), and
  **`/voice/tts`** (2026-08-07 — speaks a reply as mp3 for the web chat; impl in
  `agent/tts.py`. API-key + JWT gated like `/agent/turn`, but rate-limited on its
  OWN `tts:` bucket so reading replies aloud can't eat the allowance for asking
  the next question. Answers **503, never a 200 with an empty body**, when no
  OpenAI key is configured — that status IS the client's fallback signal).
- `agent/loop.py` — the provider-agnostic tool-calling loop (OpenAI default,
  Gemini/Anthropic alternatives; Anthropic is the automatic silent-key fallback).
- `agent/soul.md` + `agent/prompts.py` — the Dosewise persona/system prompt.
  Kept **channel-neutral** (describes app screens generically, not
  Telegram-specific button taps) so both channels get accurate answers.
- `tools/` — one file per tool (medications, profile, symptoms, drug_info,
  interactions, schedule, doses, refills, caregiver, doctor, escalation,
  videos, walkthrough, verify, choices, alerts), registered via `tools/base.py`. **29 tools.**
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
  **Widened to EVERY yes/no (2026-08-07), including purely conversational ones.**
  Buttons render only from `choices` or `awaiting_confirmation` (which only a
  tool's propose branch sets), so "Shall I look that up for you?" produced
  neither and typing was the only way to answer. `prompts.py` now appends an
  unconditional ANSWER BUTTONS block and `choices.py`'s schema description says
  the same — unconditional is safe because `offer_choices` is a documented no-op
  on Telegram, though not free (it costs an agent-loop iteration there).
  `soul.md` was also made channel-neutral: it told Mei to have people "tap ✅"
  in six places with no guard, on a web app that has no ✅ control. ✅ survives
  only as a STATUS anchor in Mei's own prose and in the one guarded sentence
  about Telegram's keyboard. Note the ✅ tap does *not* always bypass the model —
  `telegram.py`'s unmapped slots deliberately route it through as literal
  `"yes"`, which is why "after they clearly say yes" fits both channels.
  **But prompting alone does NOT work, and `agent/answers.py` is the actual
  fix.** Measured live with both rails in place: **0 of 6** conversational
  yes/no turns carried answers. A model that has committed to a text reply
  routinely skips a tool whose only effect is a side effect — that is a
  mechanism problem, not a wording one. So `run_agent_turn` no longer asks: when
  the reply ends in a question mark (`?` or the full-width `？`) and no options
  are attached, it spends ONE extra completion with a **forced**
  `suggest_answers` tool call — `extract.py`'s trick, so a structured answer is
  guaranteed. The model both judges whether the question is pickable and writes
  the labels **in the person's own language**, which is exactly what a
  server-side heuristic could never do (Hermes holds no translation table — that
  is *why* the client owns the synthesized Yes/No pair for the confirm case).
  The earlier regex/English-only backstop was deleted, not disabled. Verified
  live 2/6 on the same prompts, with the model correctly returning **no** options
  for the open "What would you like to ask them?" and three for "Would you like
  me to do that?". `Settings.answer_buttons` (default **on**) trades it back for
  the extra latency; it fails open on every error. Lives in `agent/loop.py`, one
  place for all channels — never `routes.py`, whose two `final`-shaped call
  sites already drifted once on `choices`. **Note for test authors:**
  `tests/conftest.py` turns it OFF by default, because the extra call otherwise
  eats the next scripted response of any fake-client test whose reply ends in a
  question.
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
pytest` (fully offline/mocked — 434 pass with no keys and no network; CI runs
exactly this plus `ruff check .`, and gates **nothing** in `apps/web`). The RLS
integration tests are `tests/test_rls_integration.py` + `tests/test_storage_rls.py`
(27 tests, marked `integration`, also self-skipping without `RUN_INTEGRATION=1`) —
they live **here, not in `supabase/scripts/`**, which holds only
`provision_hosted.py`; `supabase/` has no test suite of its own, it supplies the
local CLI stack + `seed/seed.sql` those tests run against.

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
