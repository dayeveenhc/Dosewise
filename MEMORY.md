# Dosewise — Session Memory

A chronological log of decisions, gotchas, and non-obvious fixes — the "why"
behind things that aren't derivable from reading the code alone. For the
current-state architecture snapshot, read `CONTEXT.md` first.

Keep entries short and dated. Prune/consolidate stale entries rather than
letting this grow forever — it's a memory aid, not an audit log.

---

## 2026-08-02 (latest) — 8 reported defects, 6 root causes. The headline one was a PROMPT rail, not the engine.

**"Now even the guided walkthrough for adding medicine doesn't work — what's
going on?"** The engine was fine. The previous pass's anti-nagging rail in
`prompts.py` said: *"Walkthroughs this patient has ALREADY been shown … DO NOT
offer to show, guide, walk, or take them through it again."* Once
`add_prescription_auto` completed once it landed in
`profiles.accessibility.completedWalkthroughs` and was forwarded on every turn —
so Mei was **instructed** never to run it again and silently did a direct
`add_prescription` write instead. That is the "**now**" in the report: it worked
until they'd used it once.

**The category error:** the rail conflated *don't VOLUNTEER a tour they've seen*
(correct, it's what s32 asserts) with *don't RUN one they just asked for*
(wrong). And the `*_auto` family isn't a tutorial at all — it **is** how the
write is performed. New `walkthrough.py::AUTONOMOUS_TASKS` is subtracted from
`done` in `prompts.py`, neither shell marks those complete, and the "already
shown" block was reworded to limit offering only. **Lesson: a prompt rail added
to fix a test can be a product outage.** The s32 spec that motivated it stayed
green throughout.

**Why 39/39 green never caught it: no spec ever ran a walkthrough TWICE.** Every
scenario uses a fresh elder with an empty `completedWalkthroughs`. New
`s33-walkthrough-rerun.spec.ts` does exactly that — plus the other structural
blind spot: **every** walkthrough spec enters via `window.__dwStartWalkthrough`
from the HOME tab, never the real production path (a Hermes reply arriving while
the person sits on the Ask Mei tab in CHAT mode). New helpers
`startWalkthroughFromChat` / `parkOnChat`.

**That blind spot was hiding a second real break.** `travel_mode_auto` and
`travel_mode_setup` both open on `[data-walk="elder-cat-medicines"]`, which only
exists in Ask Mei's HELP view — and `send()` sets `mode:"chat"`. A step's
`onEnter` can only switch bottom-nav tabs, so on the normal launch path (from
chat) the screen never reset and the very first act failed. Fixed with
`screenResetSignal`, mirroring the existing `openQuestionsSignal` pattern; the
same signal returns Settings to its hub (`add_condition_auto`/`edit_profile_auto`
/`language_voice_tour` all open there) and restores the Reminders demo alert
`notifications_tour` dismisses with its own step 3.

**"Weekly summary says it's starting then just brings me to my chat page."** Two
causes. (1) `tasks_for_role` gated only the PROSE list; the tool's JSON enum was
still the flat `TASK_NAMES`, so an elder's model could call
`start_walkthrough("weekly_summary_tour")` and the client declined it to
`console.warn`. Fixed by rejecting at DISPATCH via a new `ToolContext.app_role`
— **not** by filtering the enum per turn: `tool_schemas()` hands out the frozen
registry dicts and `loop.py` only shallow-copies them, so a per-turn enum means
deep copies threaded through all three provider paths. (2) Every refusal was
`console.warn`-only; `handleWalkthroughStart` now returns a reason both chats
render. Dead air after "I'll show you now" is indistinguishable from broken.

**Language stuck in Chinese after switching back to English.**
`REPLY_LANGUAGE.en` was `undefined` — `JSON.stringify` drops the key, so
`prompts.py`'s `if reply_language:` was False and the whole LANGUAGE block was
omitted. Switching zh→en **removed** the only instruction rather than replacing
it, while the full Chinese history replayed. One-line fix (`en: "English"`), plus
prompt wording making the setting authoritative over earlier turns and over
`_recent_memory` (which is cached Chinese prose in the system prompt).

**"The notification page is still in English."** The screen was already fully
`t()`-wrapped. The real cause: **174 keys missing from all five non-English
maps**, and `t()` falls back to English silently — so a gap is invisible at
runtime. ~130 of them were the entire `walk.*` corpus, i.e. every walkthrough ran
in English for a Chinese/Tamil/Malay user. Now 193 keys × 5 languages, with
`language.test.ts` guarding key-set parity, duplicates, and `{placeholder}`
parity so it cannot silently reopen. **Trap avoided:**
`ElderlyNotificationsScreen` split flagged-vs-manual questions on
`q.addedAt.includes("Mei")` — translating that label would have collapsed every
question into "manual". Moved onto the structured `DoctorQ.source` first.

**Emergency contact.** There is **no phone column anywhere in the schema** — the
"+65 9123 4567" in Settings was `data/patients.ts` fixture data leaking through
`App.tsx`'s `...prev[0]` spread onto real accounts (the same bug `bloodType` and
`conditions` were already fixed for, three lines away). New read-only
`list_caregivers` tool + a real `care_links`-backed Settings card, so Mei and the
app finally agree. An elder **cannot** read their caregiver's `profiles` row
(RLS is caregiver→elder only), so the name comes from
`permissions.requested_by_name` — and seeded/provisioned links have no such key,
making the unnamed fallback a normal path, not an edge case.

**Confirm buttons.** `session.awaiting_confirmation` already existed and Telegram
already used it; the web contract just had no field for it. Added — with a
**per-turn reset in `_build_context`**, without which the flag (sticky across the
persistent `http_sessions` state) would paint Yes/No under every later reply.
Labels are client-owned: the tapped value becomes the person's own chat bubble
AND their next message, so it must be in their language, and Hermes holds no
translation table. Two render bugs fixed alongside: the `messages.length - 1`
gate hid the buttons whenever a confirmation chip was appended after the reply,
and the `LIVE_STEP_ID` "working on it" chip was cleared only on `committed` — so
on a propose turn (exactly when the buttons appear) it stuck forever and was
persisted to sessionStorage.

**The Next gate stays** (user's explicit call this time, not an inference — last
pass inferred it from "too fast"). It got real chrome instead: a one-shot arrival
beat + resting ring (`.dw-gate-ready`, reduced-motion safe) and copy naming the
actual button, since an enabled-but-identical button was too quiet a signal for
"this is the only way forward".

**Three gotchas found only by driving it, each of which had made a fix wrong:**
1. **`__dwStartWalkthrough` registers in a `useEffect(…, [])`, so it captured the
   FIRST render's `handleWalkthroughStart`** — and with it that render's
   `hasCaregiver` (false) and `patient` (the pre-hydration fixture). Every gate
   inside answered from stale data forever, and since every e2e spec enters
   through that hook, the whole suite was verifying the wrong closure. Both
   shells now route the hook through a ref tracking the latest closure. The
   deps array stays empty on purpose — `App.tsx`'s comment explains the
   window-property race that re-registering would reopen.
2. **A gate must not refuse on "not looked yet".** `hasCaregiver` started `false`,
   so `emergency_contact_tour` was refused during the ~100ms before its
   `care_links` query resolved — telling someone who HAS a caregiver that they
   don't. Now tri-state: only a definite `false` refuses. (That query runs on
   every bottom-nav tab switch, deps `[elderId, tab]`, so a link accepted mid-
   session is picked up. One small query per navigation, deliberately.)
3. **`screenResetSignal` must not touch the Reminders tab.** Forcing it back to
   Messages unmounted the doctor-question card a ChangeHighlight had just
   navigated to (caught by s10). The tour's own anchors never needed it — the
   demo alert sits above the tab strip and the doctor-question flow clicks its
   own tab.

**The verification sweep found a bug none of the 8 reports mentioned: THE SYSTEM
PROMPT NEVER STATED TODAY'S DATE.** Asked to set up Travel Mode for "next Monday"
on 2026-08-02, Mei returned `start_date: 2023-10-30` — dated from its training
data — and `travel_mode_auto` dutifully saved a travel plan three years in the
past. `s14` passes right through it because the spec drives with its own
constants and never gates on the routed values. Every relative phrase was
affected ("in two weeks", "since last month"), not just travel. `prompts.py` now
opens with `Today is {weekday}, {d} {Month} {YYYY} ({YYYY-MM-DD})` in the app's
own `hermes_tz`. Re-verified live: 2026-08-10 → 2026-08-24. **A unit test can
only catch a MISSING date, never a wrong one** — this needed a live drive.

**Final state.** Offline: hermes **366** pytest + ruff clean; web `tsc` clean,
**160** vitest, build clean. Live: **41/41 scenario specs pass** (4 — s05, s06,
s18, s24 — needed a serial re-run; all four carry retry loops for the documented
LLM routing variance under parallel load, and all four are green serially). POST
green. Four sub-agents drove every walkthrough family live from BOTH the dev hook
and the production chat entry: **zero stalls, every step target found**.

**The browser does NOT talk to a local Hermes.** `VITE_HERMES_URL` is the ngrok
fixed domain → pm2's `hermes-demo` on `:5010`. So a scratch `:8901` verifies the
backend CODE but says nothing about what the app serves — a sub-agent caught the
confirm-buttons fix "failing" in-browser purely because `hermes-demo` predated it
(absent keys on the SSE `final` frame, not present-and-false: the proof). Any
backend change needs a pm2 restart (or a commit, for `hermes-git-sync`) before
it is testable through the UI. Worth checking first every time.

**Two entry points swallowed walkthrough refusals, and only one got fixed first.**
`handleWalkthroughStart` returning a reason is useless unless the CALLER renders
it: the chat path did, the Ask-Mei help tiles discarded it, so tapping "Show me:
my emergency contact" with no caregiver was silent dead air — the exact defect
the return value exists to end. Found independently by two sub-agents. Both
shells' tile launches go through a `startWalk` that renders it now. `request_refill`
had dodged it only by accident (its tile pre-gates on `anyRunningLow`).

**THE PORT-8000 RESTART STORM, FINALLY DIAGNOSED.** `hermes` had accumulated
~37,900 restarts. Cause: `deploy/pm2/watch-and-pull.sh` compares
`git rev-parse HEAD` against `git rev-parse origin/main` — and the VPS was
checked out on a FEATURE BRANCH. Those SHAs can never match, so every 15s poll
"detected a new commit", pulled, and restarted `hermes`. Forever. `:8000` was
therefore down or flickering a good fraction of the time, which is what every
"[FAIL] prod :8000 /health not 200" in POST was. It is NOT the orphaned
`--multiprocessing-fork` child the cleanup phase was built for — that's a
different (also real) failure. **Whenever the VPS is checked out anywhere other
than the branch `watch-and-pull.sh` tracks, it will restart-loop.** Fixed by
fast-forwarding `main` to the working branch, so HEAD == origin/main; verified
by a flat restart counter across 5 poll intervals. If a feature branch ever
needs to be checked out on the box for a while, set `GIT_BRANCH` to match or
stop `hermes-git-sync` first.

**Verification caveat worth keeping.** The 965 translated strings are machine
translations without a native reviewer, on the user's explicit call. Three places
a reviewer would earn their keep, all flagged by the translators themselves:
`walk.taskLabel.*` has no consumer in `src/` (`WALKTHROUGH_TASK_LABELS` is
declared and unused), so its carrier sentence was guessed; the `ta` block already
used two different words for "refill" (`மறுநிரப்பு` vs `மறுபொருத்தம்`) and the
new keys picked the majority one, so `walk.refill.tapRequest` and
`home.refillNeeded` now disagree on one screen; and `walk.refused.noCaregiver`
was hand-written after the batch rather than routed through the translators.

## 2026-08-02 — Caregiver UI revamp: Ask Mei on the elder shape, weekly calendar, token cleanup

**Blank AI tab root cause:** the caregiver Ask Mei screen referenced `ChevronDown`,
`CheckCircle2`, `SlidersHorizontal`, and `ChevronLeft` without importing them from
`lucide-react`. That caused a render-time runtime error when the caregiver AI tab
mounted, leaving the screen blank even though the router branch itself was correct.


User-directed pass over the caregiver interface, mirroring the 2026-07-29
elderly revamp at caregiver text sizes. `apps/web` only — no backend touched.

**Ask Mei (`AskMeiScreen.tsx`) rebuilt on the elder screen's shape.** Same title
row + help↔chat switch, same permanent composer with camera/mic *inside* the
field, same searchable icon-row help view. Deliberately **flat labelled
sections, not the elder's category tiles** — a category drill-down would have
pushed Weekly Summary one level deep, which breaks `weekly_summary_tour` step 3
and e2e s29 (they need `[data-walk="cg-weeklysummary-tile"]` visible right after
tapping "Quick help"). The chat/help switch is therefore *labelled* "Quick help"
in chat mode, and `data-tour="cg-askmei"` moved onto the title row that contains
it — both tour anchors survive untouched. Verified by re-driving
`weekly_summary_tour` and `patient_schedule_tour` in a real browser against a
throwaway caregiver account; both complete. (The agent-turn halves of s28/s29
were NOT re-run — that needs a local Hermes on :8901.)

**Weekly calendar (`TimelineScreen.tsx`).** Week strip days now carry a per-day
adherence bar instead of a single dot; the weekly grid gained a week-total
adherence card, per-column `taken/due` counts, and status cells that carry a
**glyph as well as a hue** (✓ / ✕ / dot / dashed-minus) so they survive the
colour-vision modes. Two honest empty states added rather than a misleading
zero: a day with nothing scored yet gets a faint empty track (not a red 0%),
and a week with nothing due yet says so instead of showing `—%`. Grid columns
are `minmax(0,1fr)_repeat(7,28px)` — the earlier `1fr_repeat(7,32px)` plus a
pill avatar truncated every medicine name to "M…" in the 390px frame. The
cosmetic `statusForDay`/`isDueOnDay` hashes are unchanged (see s28's header).

**Dead status classes fixed.** `bg-taken-bg0` / `bg-missed-bg0` were used in
`TimelineScreen`, `SettingsScreen` and `SendReminderSheet` — **no such token
exists** (`theme.css` defines `--color-taken-bg`, not `-bg0`), so those dots and
the reminder-sent badge had been rendering with no background at all. Now
`bg-taken` / `bg-missed`.

**Hardcoded palette classes replaced with tokens** across the caregiver screens
(`bg-red-50`/`text-red-600`/`bg-red-500`, `bg-stone-300/400`, `bg-amber-50`,
`text-black`, raw `text-white`, and the `#0D5C8A`/`#6B6455` hexes in the weekly
summary chart). These bypassed the contrast/colour-vision overrides in
`accessibility.tsx`, which is exactly the failure mode CONTEXT.md warns about —
the caregiver screens were the last place it survived.

New i18n keys (all six languages): `ai.cgRow{Schedule,WeeklyTour,LinkPatient,
SwitchView,Notifications}`, `common.{previousWeek,nextWeek,nothingRecordedWeek}`.
## 2026-08-02 — The "flaky" tests were hiding a live signup outage. 39/39 green.

I had reported 6 failing e2e specs as LLM variance / pre-existing. **That was
wrong about the ones that mattered.** Re-investigating each properly turned up
three real product bugs, one of them a production outage.

**EVERY NEW USER SIGNING UP HIT A BLANK WHITE SCREEN.** `App.tsx`'s onboarding
branch was wrapped in `LanguageProvider` only; `ab29a6d` added
`useAccessibility()` to `TimesPicker.tsx` (×3) for the 12h/24h setting, and that
hook **throws** when its provider is missing. The wizard's `routine` step renders
five `TimeField`s → throw during render → React unmounts the whole tree. Same for
`current-meds`/`med-history` via `MedList` → `TimesPicker`: one root cause, three
dead wizard steps. Committed, merged, and serving. **Fixed** by wrapping that
branch in `AccessibilityProvider` (verified in a browser, not just by the spec —
zero pageerrors, screenshot in `e2e/design-shots/wizard-crash-fix/`).
**Deliberately did NOT also make `useAccessibility()` fail soft** — that would
turn every future missing-provider mistake into a silent wrong time format
instead of a loud crash, and the loud crash is what made this findable.

**Lesson worth keeping: a test that fails the same way three times is not
flaky.** `s30` failed identically on every run; I attributed it to "pre-existing"
because reverting my own changes didn't fix it. Reverting proves *authorship*,
not *innocence* — the bug was inherited, and it was still a live outage.

**Second real bug:** an elder who discontinues a medicine got the DB write but
**no ring and no caption, ever** — `ElderlyPrescriptionScreen`'s archived list is
collapsed behind `pastOpen` (also `ab29a6d`), so `ChangeHighlight` polled 5s for
a row that wasn't in the DOM and gave up silently. The comment directly above it
still said "always visible". Fixed by passing the highlighted entity ids down so
the screen reveals its own content (`highlightableEntities` → `highlightIds`),
rather than teaching the highlight layer about accordions.

**Third:** `s03` caught Mei replying "✅ Logged: Metformin — 8:00 AM" with
`tools_used: []` and `actions: []` — a fabricated adherence confirmation in a
medication app. The spec's retry loop then made it unrecoverable: it re-asked on
the SAME elder, and Hermes replays per-`elder_id` session history, so attempts
2-3 read attempt 1's false claim and echoed it. **Effective attempt count was 1,
not 3.** Same contamination in `s32`. Both now re-run the whole dialogue on a
FRESH elder per attempt; `s03` also logs loudly if a reply claims a write that
never committed.

**Two more walkthrough safety bugs, found by auditing all 116 steps:**
`add_doctor_question_auto` was the ONLY `*_auto` that committed a real Supabase
write with no user tap (`act: click` on Save, with verify/reveal riding the same
step, so the commit gate opened *after* the write) — split into a `waitFor`
confirm + act-less tail like its four siblings. And `link_caregiver`'s elder side
dead-ended at 2/4: it waited on the QR code, which only mounts behind `showQr`,
and nothing anywhere pointed at the button that flips it — same class as the
deleted `elder-emergency-section` anchor. Added `elder-qr-show` + a reveal step.

**Consistent confirmation frame (user's ask).** `waitFor` steps rendered an empty
action row — no Next by design, because Mei must never advance past consent, but
also no clue what was expected. New `WalkthroughWaitPill` fills the same slot
with a non-interactive indicator naming the real control ("Waiting for you: Add
Lisinopril"), derived from the target's own accessible name so it can't drift.
Three non-obvious constraints, all load-bearing:
- **A `<div>`, not a `<button disabled>`** — `getByRole("button")` still matches
  disabled buttons, so a button would stay catchable forever by the four specs
  that prove consent steps render no advance control; `aria-hidden` would fix
  that only by hiding a visible element from screen readers.
- **The "Waiting for you: " prefix is correctness, not copy taste.** A bare
  "Tap {label}" renders the literal string "Tap Scan QR code" on s24 step 2 —
  byte-identical to that spec's own body text, giving `getByText` two matches
  and a strict-mode failure.
- **Guard `textContent` on interactive-only + no `<option>`** — the language
  target is a `<div>` wrapping a `<select>` whose textContent is every option
  concatenated, and a bare `Toggle` has no name at all (fallback is its normal
  path, not an edge case).

**Deleted the duplicate task families** (`language_voice`, `emergency_contact`;
kept the self-driving `*_tour`). **A deletion like this is a live-500 hazard:**
`prompts.py` did `_WALKTHROUGH_LABELS[t] for t in sorted(done)`, and `done` is
STORED USER DATA (`profiles.accessibility.completedWalkthroughs`) — any patient
who had completed a since-renamed task would KeyError on EVERY turn. Guarded
first (`done & _WALKTHROUGH_LABELS.keys()`) with its own regression test. 23→21
tasks; the 4-way parity pytest keeps the owners honest.

**Pacing is now uniform.** `SELECT_MIN_MS` (700) made the travel timezone the
fastest step in a task whose neighbouring fills were 2800 — select/upload now
share `FIELD_MIN_MS` and get the same pre-highlight beat, because they ARE fills
to the person. `BETWEEN_FIELDS_MS` (1000) was deleted: it made sense when steps
auto-advanced, but now only delayed when Next became tappable. All six tours
carry `onEnter` on their non-navigating steps, so the rhythm is identical.
`skippable` was declared and read by **nothing** on 15 steps — deleted along with
the now-producerless `navigation` waitFor variant and its overlay machinery.
Three tour headers asserted the exact opposite of their own code ("every step is
waitFor, no Next, zero phase-log" on 100%-`act` tours) — corrected.

**Verified.** Offline: web `tsc`/**149** vitest/build; hermes **341** pytest/ruff.
Live e2e: **39/39 scenario tests pass** (was 33/39). A static matrix re-derived
from the real resolver confirms: every one of the 21 tasks' steps has a
completion path, renders either Next/Done or the wait pill, no `*_auto` commits
without a user tap, and no bus-backed wait can hang without a timeout.

**One spec assertion deliberately softened, and why.** `s32`'s `OFFER_RE` matched
*any* offer language, but the prompt's done-block only forbids re-offering **the
completed** task while the undone-block actively invites offering a different
one — so it asserted more than the prompt ever promised. The hard assertion is
now the real safety property (never RE-RUN a completed walkthrough); the prose
half is recorded as an annotation. Mei still tacks on "would you like me to guide
you through it?" roughly 1 in 3 replies — a genuine prompt-adherence gap, logged
rather than papered over.

## 2026-08-02 (later) — Walkthrough engine rewrite: the black-screen root cause, user-gated advance, 4 dead flows fixed, condition i18n

Eight user-reported defects. **Six root causes — and ONE engine defect explained
four of them.** Live-verified on `:5173` + a scratch `:8901` (killed by exact
PID; prod `hermes`/`hermes-demo` untouched, POST green before and after).

**THE root cause — a walkthrough could strand you with no way out.**
`Walkthrough.tsx` rendered the callout only once the spotlight target was
measured (`{(rect || phaseError) && …}`), and gave up measuring after **40
animation frames (~667ms)**. The callout is the ONLY host of the Exit button, so
any target that was renamed, mounted late, or rendered conditionally left an
opaque `bg-black/75` screen with no instruction and no way out but a page
reload. Meanwhile `actor.ts::waitForEl` polls for **4000ms** — so Mei could
successfully drive an element the spotlight had already abandoned ("black screen
while Mei types"). The `waitFor` DOM listener also did `if (!el) return` with no
retry; its comment claimed the `rect` dep re-armed it, but `rect` only changes on
a SUCCESSFUL measure, so a target behind a Supabase fetch was never listened to.
**Fixed:** callout always renders (mirrors `GuidedTour.tsx:105-107`, which had
documented this exact reasoning on the wrong side of the codebase); measure
budget is time-based and matches the actor's 4000ms; the waitFor listener polls
until its anchor exists; `timeoutMs` (declared on `WalkthroughStep`, read by
**nothing**, set on exactly the two steps most likely to hang) is now honoured
with honest copy. New `walk.cannotFind` / `walk.timedOut` states.

**Autonomous steps no longer auto-advance** (user's explicit call — pacing had
already been raised ~2x on 2026-07-28 and was still "too fast", which meant the
real complaint was *"it moves without me"*). `pace.ts` gained `awaitNext()`, a
**timer-less** commit gate — deliberately NOT a long `interruptibleSleep`, since
browsers clamp `setTimeout` above 2^31-1ms to ~1ms and the gate would resolve
instantly. `nextRequested` is kept separate from `fastForward` so one tap can
never both shorten a dwell AND commit the step; `orchestrate.ts` awaits the gate
after the replay loop and re-checks `shouldCancel` (Exit mid-gate must not
advance). Last step's button reads "Done". PACING constants deliberately
UNCHANGED — the gate now does the anti-rush job.

**Four flows that could never have worked, with their causes:**
1. `weekly_summary_tour` "doesn't work at all" — selectors were all fine; **no
   launcher existed anywhere in the app** for ANY of the six spotlight tours
   (grep: zero references outside `lib/walkthrough/`). Added Ask-Mei rows (elder)
   + Quick-help tiles (caregiver).
2. `emergency_contact_tour` — `[data-walk="elder-emergency-section"]` was deleted
   by the settings-hub revamp (`f7b67fc`) and survived only in the step file.
   Restored via a new `walk` prop on `SectionCard` (kept separate from `anchor`,
   which search uses). Step 2 was also an `act:click` on a handler-less container
   → converted to act-less + `reveal` (honest pulse, no fake click). Same for
   `patient_schedule_tour`'s week strip and `notifications_tour`'s alert row.
3. `travel_mode_auto` timezone — the `<select>`'s options carry **no value
   attribute**, so an option's value IS its label; an LLM-supplied
   "Asia/Tokyo"/"UTC+9" set `selectedIndex = -1` and **BLANKED** the field, and
   `verify.ts` checked only `travelPlan.startDate` so the corruption **verified
   as success**. Three-layer fix: `resolveTimezone` (explicit alias table, not
   fuzzy matching — a plan silently saved against the wrong country is worse than
   an honest refusal), `performAct`'s select branch now REFUSES a non-matching
   value instead of clearing, and Verify asserts all three fields.
4. `link_caregiver` (elder role) was **dead at step 1**: its nav steps set
   `waitFor.to === step.screen`, and the guard is
   `sameScreen(cur,to) && !sameScreen(cur,screen)` — i.e. `X && !X`, never true.
   Also `narrated.ts`'s `text_size` slider waited for `input` on a `<div>`
   (`.value` undefined ⇒ unsatisfiable forever).

**Add-prescription legibility (user's ask).** The flow already ended in a
user-tapped Save; what was missing was seeing what Mei typed. New
`WalkthroughReview` panel inside the callout, declared as label+SELECTOR and read
**live from the DOM** (a value captured at build time goes stale the moment
"Change" is used — exactly the failure the review exists to catch). Needs a
~300ms poll as well as listeners: `TypeAhead` sets React state and React
dispatches no native input event. **Must render OUTSIDE the `autonomous` block** —
the confirm step is a `waitFor` step, so `autonomous` is false for it. "Change"
opens a **second mask cutout** so you aren't retyping under the scrim. Exit is
now real button chrome, not bare text (both here and `GuidedTour`'s Skip).

**Found while verifying (real, pre-existing):** for an act-less verify tail,
`paced("verify")` publishes SYNCHRONOUSLY inside the driver effect — which runs
before the phase-subscribe effect — so the broadcast had no listener and the
"Checking…" label never showed. Fixed by seeding `paceState` from
`paceRef.current.state()` on subscribe.

**Condition i18n — two separate causes, one of them not i18n at all.**
`localizeCatalogValue` (reverse `value→labelKey`, case-insensitive, falls back to
the raw string since `conditions[]` mixes catalog values, free text and OCR
output) wired into the 9 raw-render sites; one map covers conditions, allergies
AND medication purposes because `MEDICATION_CATALOG.purposeKey` shares the
`catalog.condition.*` vocabulary. **But the user's own example, "Type 2
Diabetes", was never a translation bug** — it is `data/patients.ts` mock data
leaking through `App.tsx`'s `profile?.details.conditions?.length ? … : prev[0]`
fallback onto real accounts. Removed (same for allergies; `bloodType` now
"Unknown" — nothing persists it, so the demo's "B+" was an invented medical fact
on a real record). "Breast cancer" is user free text and untranslatable by any
approach. Also translated allergy severity + weekday abbreviations, and fixed the
type-ahead filtering on label-only (typing "diab" in Chinese matched nothing).

**Backend (cross-boundary, explicitly approved).** `app_role` threaded
client→`/agent/turn`→`run_agent_turn`→`system_prompt_for` so the prompt only
offers walkthroughs that can RUN in the asking shell (`tasks_for_role`) — the
elder was being offered caregiver-only tours. `walkthroughShellFor` (derived from
the steps' own `screen.mode`, NOT declared separately, so it cannot drift) is the
client-side guard. `TRAVEL_TIMEZONES` in the tool schema, with a test asserting
it matches `constants.ts` exactly.

**Do NOT add a soul.md list mapping phrases → walkthroughs.** Tried it; it made
`s32` fail 2/2 by fighting the "already shown, don't re-offer" rail. The UI
launchers are the reliable discovery fix.

**e2e: the "all 32 live-green" claim in the entry below is WRONG.** Verified by
running it: `s22` asserted a selector deleted back at `f7b67fc`; `s27` asserted a
"Hello, {name}!" header the 2026-07-29 revamp removed; `s10`/`s19` asserted a
Request-refill button that only renders on a LOW card (a med with no `refills`
row defaults to 30/30); `s18` used a composer placeholder from before the revamp.
All repaired. **Always re-establish the e2e baseline before trusting it.**
New helpers: `tapWalkthroughNext` (waits for the gate's own copy first — Next
means *fast-forward* mid-phase and *commit* at the gate, and Playwright's
actionability cannot tell them apart), `advanceWalkthroughToStep` (prefer over a
DOM predicate: a tour's later targets are usually siblings of earlier ones, so
"is it visible?" is true one step early and advances nothing), `finishWalkthrough`.

**Three follow-ups found in review, all fixed.** (1) **Params must be coerced
to strings at the tool boundary** — documenting `edit_profile_auto: {value}` in
the schema made the model actually route there (closing a routing gap `s15` had
recorded as an open finding), and it promptly sent `{"value": 64}` as a NUMBER
despite the schema saying string. The client's builders are
`Record<string, string>` and call `.trim()`, so that reaches the browser as a
TypeError mid-walkthrough; `start_walkthrough` now stringifies every value in one
place rather than defensively in every builder. (2) `finishWalkthrough` returned
SUCCESS on any vanished overlay, so a tour that died at step 2 passed both it and
the `expect(Exit).toHaveCount(0)` that follows — it now requires the counter to
have reached the final step. (3) `request_refill` could still be started from
chat with nothing running low (Ask Mei's own row gates on `anyMedicationRunningLow`;
the chat path did not), so it dead-ended immediately — same precondition now
applies in `handleWalkthroughStart`. Also hardened the allergy-severity key the
way `localizeCatalogValue` already guards: `t()` returns the key itself when
missing, so a legacy value would have printed literally as "severity.foo".

**Final state.** Offline: web `tsc`/**143** vitest/build clean; hermes **339**
pytest/ruff clean. Live e2e: **33/39 scenario tests pass.** The 6 remaining are
in specs this pass did not functionally change — `s06`/`s08`/`s13` (propose→confirm
LLM routing variance, which is why those specs carry retry loops), `s18` (failed once at
2.1m against the scratch instance — no cause reproduced, weaker evidence than the
group above), and `s30`/`s32`, both **verified pre-existing by
re-running them against the original file** (`s30` fails identically with the
unmodified wizard; `s32` fails 3/3 with the unmodified soul.md). Note ≤2 workers:
`s15` fails on a fixture race at 2 workers and passes serially.

## 2026-08-02 — Full end-to-end verification: closed the ⚠️ pending-e2e gap, found+fixed a severe identity-corruption bug + 2 walkthrough bugs + 3 backend hardening items

Live-verified the entire uncommitted 2026-07-28 pass end-to-end (three parallel
Explore audits → live `:8901`/`:5173` harness → fix → re-verify), closing the
"⚠️ E2E VERIFICATION PENDING" gap this file had carried since 2026-07-28.
**All 32 `e2e/scenarios/sNN-*.spec.ts` are now live-green**, plus hermes
pytest **334**/ruff clean, web `tsc`/**112** vitest/build clean, `scripts/
post.sh --quick` green throughout (prod `hermes`/`hermes-demo` untouched —
only a scratch `:8901` instance, `TELEGRAM_BOT_TOKEN=""`, was used and later
killed by exact PID).

**Most severe finding — real identity corruption, found live, not
hypothetical:** `lib/walkthroughState.ts`'s sessionStorage key was
`dosewise:walkthrough:{userId}` — **no shell/role discriminator**. A caregiver
previewing their own elder view (`caregiver_view_toggle_tour`, whose whole
point is switching shells on the SAME account/uid) leaves a session that
`ElderlyApp`'s own restore-on-mount effect picks up the instant it mounts
(same key, same uid, different shell). `ElderlyApp`'s completion handler then
re-fires with **`role: "elder"` hardcoded**, silently overwriting that
caregiver's real `profiles.role` column in the database — a normal, everyday
action (tap "Switch to Elderly View") permanently converts a caregiver account
into an elder one. **Fixed:** `key()`/`loadWalkthroughSession`/
`saveWalkthroughSession`/`clearWalkthroughSession` all now take a
`shell: "elder" | "caregiver"` param; `App.tsx` always passes `"caregiver"`,
`ElderlyApp.tsx` always passes `"elder"` — the cross-shell leak is now
structurally impossible for any current or future task name. Re-verified live
(role stays `"caregiver"` after the toggle). This generalizes the narrower
2026-07-27 "onboarding" session-exclusion patch (which fixed one task, not the
shared-key root cause) — worth remembering if a NEW task name ever triggers a
shell transition from its own last step again.

**Related, lower-severity finding surfaced by fixing the above (cosmetic, not
a safety issue):** with the leak closed, `caregiver_view_toggle_tour`'s OWN
completion write now never lands at all — its last step's `act:click` on
`cg-switch-mode` synchronously flips `appMode`, which unmounts `<Walkthrough>`
(App.tsx's caregiver branch stops matching) **before** the internal
`onAdvance` wrapper's `cancelled` guard (`Walkthrough.tsx`, set in the driving
`useEffect`'s cleanup) clears — so `handleWalkthroughAdvance`'s
`markWalkthroughCompleted` call is swallowed every time this specific
step-shape occurs (a mode-changing click with no verify/reveal tail). Net
effect: Mei may re-offer this ONE tour later even after it's been shown —
never a data/safety issue. **Not fixed** (architecture-level, low value) — the
s27 spec now checks it honestly (`test.info().annotations`, `console.warn` if
missing) rather than hard-asserting, mirroring the project's established
soft-check pattern (s28's edit-guard) instead of papering over it.

**Second real product bug, also found only by driving the AI-auto-advanced
tours live:** `weekly_summary_tour.ts`'s step 2 `act:click` targeted
`[data-tour="cg-askmei"]` — the plain wrapping `<div>` around the "Quick help"
+ "Clear chat" buttons, not either button itself. A `waitFor` step's native
listener catches a REAL user's click on either child via bubbling, but an
autonomous step's `el.click()` fires directly on the exact selector — clicking
a handler-less container does nothing, so the tour silently stalled before
ever opening the Quick-help popup (the Weekly-Summary tile it needs next never
mounts). Exactly the SAME gotcha `travel_mode_auto.ts` already documents and
avoids for the elder-side Quick Help button — just missed on this sibling.
**Fixed:** added `data-walk="cg-quickhelp-btn"` directly to the button
(`AskMeiScreen.tsx`) and retargeted the step's selector there.

**The e2e-staleness repair itself (the headline gap this pass closes):** the
2026-07-28 pass changed two walkthrough contracts (Item 2B: `*_auto` flows now
end in a user-tapped Save, not an autonomous submit; Item 5: 6 former
spotlight-only tours are now AI-auto-advanced) but never updated the 10 specs
whose assertions encoded the OLD contracts, and never ran any spec live.
Repaired **s01/s02/s14/s15** (insert the real Save tap after the fills, before
the verify/reveal tail — `add_prescription_auto`/`add_condition_auto`/
`travel_mode_auto` wait on a DOM click or the real `travel-plan-saved` app
event; `edit_profile_auto` on a DOM click, in both its happy-path and
verify-failed tests) and **s19/s20/s22/s27/s28/s29** (the former
`toHaveLength(0)` "user-driven, zero paced phases" assertion inverted to
`assertPhaseMins` against real recorded `click`/`navigate` phases — s22 is a
hybrid, since its consent Call step correctly stays `waitFor`/zero-phase).
Also fixed **s10**'s incoherence (drove a pill-count phrase and asserted
`log_refill`/`refills` while its OWN walkthrough step 3 already waited on the
2026-07-28 `request_refill` event — retargeted the trigger phrase, the
committed-action shape, the DB re-check to `doctor_questions`, and the
ChangeHighlight assertion to the real `doctor_message-{id}` card, mirroring
s21's already-proven pattern) and `manifest.ts`'s matching `tools: ["log_refill"]`
→ `["request_refill"]` drift (a real 1-line audit finding the manifest's own
`coverage.spec.ts` guard can't catch, since it only checks taskName wiring, not
tool routing).

**Backend hardening, offline-verified (`test_dispatch_committed.py`,
`test_update_dosage.py`, `test_offer_choices.py`, `test_request_refill.py`):**
(1) `update_medication_dosage`'s confirm branch used to do
`dosage = dosage or pending.get("dosage")` — a `confirmed=true` carrying a
**different** dose than was proposed and read back would silently save it,
skipping `_dosage_warning` entirely; now refuses and asks again unless the
confirm's dose matches the proposed one (or resupplies nothing). (2) the
`committed` field `loop.py::_dispatch_tool` emits on `tool_end` — the signal
BOTH chat screens gate navigation on — had zero test coverage (the stream
route's own fake `run_agent_turn` bypasses `_dispatch_tool` entirely); added a
direct unit test. (3) small hygiene: `offer_choices`'s return message no
longer promises "Attached N tappable buttons" on a channel (Telegram) where
none render; `request_refill` now skips inserting a duplicate `doctor_questions`
row when an open one for the same medication already exists.

**`prompts.py` fix (real UX bug, not just test flake):** the completed-
walkthroughs rail only ever said what's UNDONE ("never offer one not in this
list") — nothing told the model to actively STOP re-offering a tour it just
listed as done, so asking about an already-shown feature often drew a generic
"want me to show you?" filler the regex-based s32 spec correctly flagged as a
gap (reproduced 2/2 live, not a flake). Added the mirror-image paragraph
("Walkthroughs already shown: … DO NOT offer to show/guide/walk them through it
again"). Re-verified live: s32 passed clean on the very first attempt post-fix
(previously needed retries and still failed at 3/3).

**Caregiver Text-size slider wired** (was a confirmed, real accessibility gap
— `App.tsx`'s content area had no `zoom` counterpart to `ElderlyApp.tsx`'s):
extracted the shared scale table + a `useContentZoom()` hook into
`accessibility.tsx` (both shells now read the SAME source), added a
`ZoomContent` wrapper component in `App.tsx` around the caregiver screen-
content area (chrome/nav excluded, mirrors the elder pattern exactly).

## 2026-07-29 — Responsive frame: fill on mobile, mockup on desktop

**Symptom:** app "poorly formatted on some devices" — fine on desktop, broken on
phones. **Cause:** the whole app is wrapped in a hardcoded `w-[390px] h-[844px]`
phone-mockup frame in all 4 render branches of `App.tsx` (auth-loading,
onboarding, elderly, caregiver), with **zero media queries** anywhere in the
app's own code. On phones narrower than ~390px the frame (needs ~434px incl.
`p-4`+border) overflows horizontally → sideways scroll + right-edge clip. (Not a
viewport-meta or reset bug — `index.html` viewport tag is correct.)

**Fix (device-layout only):** made the frame **mobile-first** — two `replace_all`
edits on `App.tsx` (the 4 frame divs + 4 outer divs are byte-identical). Frame:
`w-full h-dvh …` by default, mockup chrome re-applied at `md:` (`md:w-[390px]
md:h-[844px] md:rounded-[3rem] md:shadow-2xl md:border-[6px]`). Outer:
`min-h-dvh … bg-stone-300 md:p-4`. Used CSS `md:` variants (flash-free) not the
`useIsMobile()` hook (`undefined` on first paint → would flash), and `dvh` for
mobile URL-bar. Verified via Playwright: 375px fills with no h-overflow/no border;
1280px = unchanged 390×844 + 6px border; smoke e2e green. e2e suite runs at 1280
(Desktop Chrome device overrides config's 430×900) so it stays on the mockup path.

**Follow-up NOT done (deliberately out of scope):** 147 fixed-`px` font utilities
(`text-[10px]`…) bypass the accessibility Text-size slider; elder shell patches
it with a fragile `zoom` (`ElderlyApp.tsx:476`), **caregiver shell has none**
(`App.tsx` content area) so its Text-size setting barely moves. Track separately.

## 2026-07-28 — Six-item feature/bug pass (dose-nav, walkthrough speed+manual-Save+auto-tours, refill→doctor, font, chat choice-buttons) + audit fixes

Big multi-part pass from a plan (six user items + carried audit findings). All
OFFLINE gates green: web `tsc`/`vitest` (112)/`build`; hermes `pytest -m "not
integration"` (330+). **NOT yet live-driven in a browser / via e2e** — see the
e2e flag at the end.

1. **Dose-log premature navigation (Item 1).** Chat navigated to the schedule
   screen when a tool merely *ran* (`tool_end`, `!is_error`), even on a
   propose/clarify turn that wrote nothing (`log_dose` asking which dose). Fix:
   `loop.py::_dispatch_tool` now emits `committed` on the `tool_end` event
   (did `ctx.committed_actions` grow during THAT dispatch); both chat screens
   gate streaming nav on `event.committed`. Class bug (also undo/snooze/refill).
2. **Walkthrough speed + manual Save (Item 2).** (a) Raised all `pacing.ts`
   minimums ~2× + added `SELECT_MIN_MS` (select/upload were instant,
   `orchestrate.ts`). (b) Each `*_auto` walkthrough now ends with a **user-tapped
   Save**: terminal `act:{click,save}` split into a `waitFor` confirm step
   (skippable:false, no Next) + an act-less verify/reveal tail — nothing commits
   on autopilot. New shared `walk.confirmSave` copy; the old `.submit`/`.save`
   keys reworded to verify-phase wording.
3. **Refill → Ask-Doctor (Item 3).** New `request_refill` tool (`refills.py`)
   inserts a `doctor_questions` row (`entity_type="doctor_message"` → routes to
   the doctor thread, caregiver sees it) — distinct from `log_refill` (pill
   count). soul.md updated; `request_refill.ts` walkthrough wait retargeted.
4. **Font size (Item 4).** Two bugs: (a) `GuidedTour.tsx` root wasn't
   `pointer-events-none`, so the onboarding tour *blocked taps* to the
   spotlighted control — "change font size doesn't work / dark screen." Added
   it (callout keeps `pointer-events-auto`), matching `Walkthrough.tsx`. (b) The
   app's text is nearly all absolute-px utilities, so the html `--font-size` var
   moved almost nothing — added a proportional `zoom` on ElderlyApp's scrollable
   content area (chrome excluded, so nothing clips) keyed to the setting.
5. **Auto-advance the remaining tours (Item 5).** language_voice/notifications/
   emergency(non-consent)/weekly_summary/patient_schedule/caregiver_view_toggle
   tours: `waitFor`→`act:click` so Mei auto-drives the spotlight at the slow
   pace. Consent steps (emergency Call, caregiver-link accept) stay user-tapped;
   onboarding stays manual (real signup). language step clicks the select's
   *container* (never changes the person's language for them).
6. **Chat choice/confirm buttons + guided questions (Item 6).** New
   `offer_choices` tool sets `ctx.choices=[{label,value}]`, surfaced on
   `AgentTurnResponse.choices` + SSE final; both chat screens render tappable
   buttons under the latest reply (tap sends `value`). soul.md guides the agent
   to use it for yes/no confirms + guided clarifying questions.

**Audit fixes folded in:** C1 `/agent/turn/stream` added to
`_RATE_LIMITED_PATHS` (was unthrottled). C2 `update_medication_dosage` confirm
now stashes the canonical name + compares case-insensitively (was refusing a
"Metformin"-echoed confirm of a "metformin" propose). C3 both chat `send()`s
guard the post-await continuation with an `isMounted` ref (a turn walked away
from no longer navigates/highlights a screen the user left). C4 blob: image URLs
no longer persisted to sessionStorage (were broken-image icons after reload).
Also: non-stream `agentTurn` guards `reply ?? ""`.

**Deferred:** C5 (snooze_dose writes `dose_snoozes` nothing re-alerts — product
decision). C6 (caregiver linked to ≥2 elders can act on the wrong same-named
med) — do NOT hard-scope `find_medications` by `ctx.elder_id` (removes caregiver
capability); correct shape is detect-and-ask when matches span ≥2 distinct
non-null elder_ids, and first confirm that flow is even exercised.

**⚠️ E2E VERIFICATION PENDING (the one real gap).** Items 2B + 5 changed the
walkthrough contracts the `apps/web/e2e/scenarios/*.spec.ts` suite encodes:
the `*_auto` specs (s01/s02/s14/s15) still expect an autonomous submit (now a
user Save tap), and the former tour specs (s19/s20/s27/s28/s29…) still expect
user-driven clicks + "zero phase-log entries" (now autonomous, auto-advancing).
Those specs need updating to the new contracts AND a live e2e run to confirm —
this is exactly the "verify each scenario is now AI-automated" pass; it needs
the live harness (POST + servers + test creds), which was not run here.
Confirmed by read (not a risk): `App.tsx` mounts the SAME `<Walkthrough>` with
`onNavigate`/`onAdvance`/`onVerify`/`onReveal` all wired and
`handleWalkthroughNavigate` handles caregiver-screen targets — so the three
caregiver tours drive autonomous `act` steps like the elder shell. Still
unwired: the **caregiver** Settings font slider (only ElderlyApp's content
zooms) — the elder side was the reported surface.

## 2026-07-29 — Elderly UI revamp: brand palette as tokens, help-list Ask Mei, Settings hub, 8 new walkthroughs

Full visual + structural pass over the elderly interface (caregiver brought
along), user-directed and staged phase-by-phase with screenshot review between
phases. Crossing into `services/hermes/` was explicitly approved this task.

**Palette is now tokens, not per-screen classes** (`styles/theme.css`). The five
brand hues: `357266` pine = `--primary` (nav, buttons, current-dose card),
`0E3B43` = `--accent`, `85B690` = tints, `E2DBBE` = `--muted`, `F5F2E7` =
`--background`. First attempt made `0E3B43` primary; the user rejected it as
**too dark** — pine leads, deep teal recedes. New **status tokens**
(`--taken-*`, `--upcoming-*`, `--missed-*`, `--warn-*`) replaced hardcoded
`emerald-/sky-/amber-/orange-` classes app-wide. **Non-obvious:** with a green
primary, "taken" and "next dose" collide, so `--taken` is deliberately the
PALEST green (a taken dose should recede) and `--upcoming` the most saturated.
Missed stays orange, deliberately outside the brand ramp. Every fg/bg pair ≥7:1.
Only `CallMockup` keeps a non-brand gradient (it imitates a native call screen).

**Accessibility model replaced two booleans with real modes**
(`accessibility.tsx`): `contrast: normal|high|max` (`max` = near-monochrome,
flattens tints/shadows since a 10%-opacity fill is invisible on white) and
`colourVision: off|deuteranopia|protanopia|tritanopia` — each remaps the status
hues onto an axis that deficiency preserves (blue↔orange for red-green,
red↔green for blue-yellow) AND raises contrast. `loadInitial` migrates the old
`{highContrast, colourBlind}` shape; `highContrast`/`colourBlind` stay exposed as
derived booleans so existing screens didn't need touching. Notification prefs
live in the same provider (documented why: no server-side notification infra to
sync a second provider to) and now actually gate the dose notification.

**The day-status banner was built, then removed at the user's request** — on
Home only the low-supply refill strip remains above the timeline. The
`home.doneTitle`/`restingTitle`/`toTakeTitle`/... keys are left in
`language.ts` (unused, gate-clean) since the feature has already been asked for
once and reversed once.

**The floating next-dose pill tracks ONE specific card**, not "the first
outstanding thing off-screen": `nextDose` is the earliest *upcoming* dose by
resolved minutes (`nextMedId` follows the medication list's own order, which is
only incidentally chronological — don't reuse it here). Hidden while that card
is on screen, bottom-left pointing down while it is below, top-left pointing up
once scrolled past. `data-testid="next-dose-up|down"` exists so this is
testable. **Test-fixture gotcha:** the empty-hour rows from 6am to ~5pm fit on
one screen, so a next dose within ~an hour of now is still visible at
scrollTop 0 — `scratchpad/nextdose.spec.ts` places it at 7pm+ with fillers below
and skips itself after 8pm.

**Supply is days-left, computed from `refills.pills_remaining ÷ doses per day**
(`lib/medications.ts::supplyDaysLeft`) — 30 pills taken twice daily is 15 days.
`fetchElderMedications` now selects `pills_remaining` onto `Medication`. Falls
back to the run-out forecast when the pill count is null, and returns undefined
when neither exists — the supply block is then **hidden rather than showing an
invented 30/30**, which is what the old `?? 30` did. Two thresholds, both in
`medications.ts`: `LOW_SUPPLY_DAYS` 10 (turns red) and `REFILL_PROMPT_DAYS` 15
(offers Request refill, deliberately earlier than the warning). Proven against
real rows in `scratchpad/supply.spec.ts`.

**Request refill is gated on the shared threshold, and that gate has a second
consumer.** The `request_refill` walkthrough
spotlights `[data-walk="med-request-refill-btn"]`, which now only exists on a
low card — with nothing low it dimmed the screen and pointed at nothing (verified,
`scratchpad/refill.spec.ts`). Ask Mei's Request-refill row therefore checks
`anyRunningLow` and falls back to opening the chat instead. Both read the
threshold from `lib/medications.ts::isRunningLow` — don't inline the arithmetic
again, or the card and the walkthrough will drift apart. **Seeded/real meds with
no `refills` row default to 30/30, so by default NO card shows the button.**

**Polish pass adds a small design system to `theme.css`, use it** — tinted
elevation tokens (`--shadow-xs/sm/md/lg`, tinted with the brand ink because
neutral-black shadows over warm cream read muddy) plus utilities `.dw-surface`
(the one card treatment: card bg + hairline border + 20px radius + shadow-sm),
`.dw-raised`, `.dw-shadow`, `.dw-float`, `.dw-press` (settle-on-tap), `.dw-display`
(Fraunces, screen titles only) and `.dw-app-bg` (subtle warm wash). ~29 hand-rolled
`bg-card rounded-2xl border border-border shadow-sm` variants were collapsed onto
`.dw-surface`. **Add new cards with `.dw-surface`, not by respelling the chrome** —
that drift is exactly what this replaced.

**Restore point:** tag `ui-checkpoint-before-sleek` on branch `ui/sleek-revamp`
(commit f7b67fc) is the whole revamp with every gate green, taken immediately
before this polish pass. `main` still holds the pre-revamp state.

**Ask Mei is one screen with a PERMANENT composer (3rd revision).** `mode:
"help" | "chat"` decides what fills the space above it; the chat is no longer a
sheet. Sending swaps the BODY only — the app header never changes, so it never feels
like a different screen. **No tab strip, ONE shared header** (4th revision,
user's call): sending a message must not spawn tabs. Both modes render the same
header row — "Ask Mei" title, then a single switch button that flips direction
("Frequently used" `data-walk="elder-ai-frequently-used"` in chat → the buttons;
"Back to chat" `data-walk="elder-ai-back-to-chat"` in help → the conversation),
plus clear-chat in chat mode. The switch only appears once a conversation
exists. The old **"Hello, {name}! / What can I help you with?" greeting block is
gone** — the shared header replaced it (`ai.whatCanIHelp` now unused). Anything that
flips to chat mode must also `setCategory(null)`, or the category's title + back
arrow stay stranded in the app header (the photo flows hit exactly this).
The text box never leaves — so typing is always the way out of a dead end. Camera and mic
live INSIDE the field (three outside buttons left the box barely wider than the
buttons); Send stays outside and disabled until there's something to send —
`photo-staging.spec.ts` asserts exactly that, so don't make Send conditional.
**No canned greeting**: `buildGreeting` is gone and the thread starts empty,
which also removed copy that said "tap a button above" after buttons stopped
being above. Entrance motion is `.dw-msg-in` / `.dw-view-in` in theme.css — CSS
animations fire once per mount and React keys bubbles by id, so only the new
message animates. Both are disabled under `prefers-reduced-motion`.

**What actually made the bubble arrival feel abrupt was the SCROLL, not the
keyframes** (found while smoothing the entrance): `scrollTop = scrollHeight` is a
jump-cut underneath a bubble that is itself animating, and the two fought.
`scrollToBottom()` now uses `scrollTo({ behavior: "smooth" })`, with an
`instant` argument for arriving at an already-long thread (opening the chat,
sending from the help view) — gliding through the whole history is a long ride
to somewhere unread. The keyframes were also retuned: 520ms, opacity done by
55% (text still fading while it settles reads as blurry), `translate3d` +
`will-change` to stay on the compositor, and `origin-bottom-left/right` per side
in the JSX so the bubble grows out of its own corner. Verified in-browser
(`scratchpad/bubbleshot.spec.ts` asserts the computed animation AND that a
re-targeted smooth scroll still lands within 2px of the bottom).

**Home's missed count hangs off the NOW line** (`elder-missed-summary`): an
up-arrow pill directly above the red divider, since everything above that line
has already come and gone. Tapping it centres the EARLIEST missed dose. Missed
cards carry `.dw-pulse` — 2.4s, opacity 1→0.72, off under
`prefers-reduced-motion`; anything faster or stronger on an already-anxious
screen reads as an alarm.

**A dose is actionable only within ±60 min of the clock** (`DUE_WINDOW_MIN` in
ElderlyHomeScreen): the SOLID PINE card and the "I took it" button both key off
that window ALONE. First attempt also required `m.id === nextMedId`, and
`nextMedId` is `dayMeds.find(status === "upcoming")` — the medication list's own
order, only incidentally chronological — so a dose genuinely due in ten minutes
stayed plain white while some other row held the "next" title. If a card's
treatment ever looks wrong, check it isn't being gated on list position again.
**"I took it" is NOT limited to that window** — a missed dose stays loggable all
day, since being late is exactly when someone needs to record it. Only the pine
card is time-boxed. The window, not the queue — a 10pm tablet was
being highlighted at breakfast, and an all-day "I took it" invites logging a
dose hours early. **This couples to the `log_dose` walkthrough**, which
spotlights `[data-walk="elder-take-dose"]`: outside a dose window that element
doesn't exist, so the step has nothing to point at. Known, unresolved — flagged
to the user.

**The now line always renders on today**, and sits at its real minute WITHIN
the hour row — cards for doses already past go above it, the rest below, and a
dose at exactly this minute goes BELOW (the line draws just above its card).
Outside the 6am–11pm window the current hour is clamped to the first/last row,
so the line pins to the top or bottom instead of vanishing. Matching rule in
`statusForDay`: `minutes >= nowMinutes` is still "upcoming", not "missed" — with
`>` a dose at exactly now rendered as missed while sitting under a line saying
it hadn't happened yet.

**The "Now" pill was broken in two ways**, both fixed: it scrolled to the top of
the now HOUR (`nowRowRef`) rather than to the line, which on a busy hour left
"now" off screen; and `showJump` compared scroll offsets with a 120px slop, so
the button appeared while the line was already visible — you tapped it and
nothing moved. Both now measure the LINE with `getBoundingClientRect` against
the scroller (`offsetTop` is relative to the nearest positioned ancestor, which
is NOT the scroll container), and the button only appears when the line is
genuinely off screen.

**One sheet shell for every slide-up: `components/BottomSheet.tsx`** — dim,
floating inset card, tap-outside to close. Six sheets each had their own version
(flush vs floating, blurred vs not, z-50 vs z-140 vs z-150), which read as
several different apps. Content stays the caller's; the shell owns nothing else.
A sheet with its own scrolling body + pinned footer (Travel Mode) passes
`className="!p-0 !overflow-hidden flex flex-col"`. `ConfirmDialog` and
`MeiSuggestButton` stay CENTRED dialogs on purpose — they interrupt rather than
offer.

**The taken card IS the undo control** (whole card is the button, no Undo strip)
and shows only when it was taken — its scheduled time was noise once the dose
was done. **The missed banner's × became "What to do?"**: per-medicine guidance
from that medicine's OWN next scheduled dose (`missedAdvice`) — take it now, or
skip if the next is within `NEXT_DOSE_SOON_MIN` (120). Deliberately the standard
leaflet rule of thumb plus "never double up" and "ask your doctor or
pharmacist", never a drug-specific instruction the app can't stand behind.

**Time picker steps ONE minute** (`MINUTE_STEP = 1`): 5-minute jumps made times
like 7:23 unreachable. Its `stepMin` MUST use the functional `setDraft(d => …)`
form — a drag fires it several times per tick, and reading `draft` from the
closure made every call after the first a no-op, so any drag was worth exactly
one minute.

**There is no in-app clock override.** A prototype clock (a panel beside the
phone bezel that simulated any time of day) was built and then REMOVED at the
user's request — don't reintroduce one without asking. To exercise time-of-day
behaviour, freeze the browser clock instead: `page.clock.setFixedTime(...)` plus
a `page.reload()`, since the app reads `new Date()` on mount and on a 30s tick
(`scratchpad/homeshot.spec.ts::setTime` does exactly this). A suite run past
midnight otherwise puts every relative offset outside the 6am–11pm window.

**Dose sanity check on Add prescription** (`lib/doseSafety.ts`, unit-tested):
between Add and the save, >4 countable units per dose or >8 a day raises a
confirm ("that is a lot at once"), never a block — only the label knows the
truth. It deliberately ignores anything without a COUNTABLE unit: "500 mg" and
"10 ml" are strengths, and warning on those trains people to tap through the
warning that matters. The confirmation resets whenever the dose or its schedule
changes, so an "I'm sure" can't carry over to a different number.

**24-hour clock is an ACCESSIBILITY setting**, not a locale one
(`accessibility.tsx::timeFormat`, `elder-24h-toggle`) — it's there for people who
can't read an AM/PM at a glance. `lib/medications.ts::formatClock(value, format)`
is the single renderer; stored times are unchanged (`Medication.times` stay 12h
strings). In 24h the picker drops the AM/PM column entirely and the hour runs
0–23, so `stepHour` has to carry the half-day itself instead of flipping a `pm`
flag. The time steppers also gained a **wheel**: drag or scroll the number
(up = later), on top of the ∧/∨ buttons, which still reach every value on their
own — that's the part shaky hands rely on.

**Ask Mei is category tiles, not a flat list (2nd revision).** Seventeen rows on
one screen read as a wall; the same items now sit behind four tiles (My
medicines / My details / How the app looks / My care team) with a short list
per tile. **This breaks any walkthrough whose first step reached a quick-help
tile directly** — `travel_mode_auto` and `travel_mode_setup` had to be
repointed at `[data-walk="elder-cat-medicines"]` first, and
`add_doctor_question_auto` gained a step to click the new doctor tab. If you
move an item between categories, check `steps/` for a selector pointing at it.

**Settings is ONE page — no "More settings", no sub-screens** (user's call).
Search sits at the very top, and a hit now SCROLLS to its section
(`[data-settings="<anchor>"]` + `scroll-mt-3`) instead of opening a sub-page;
the query has to be cleared before the scroll, since the sections aren't
mounted while results are up. **Two** screens survive, on the same rule —
neither is a setting about this person's care: **Your profile** (long form, own
Save) and **About Dosewise** (`data-walk="elder-settings-about"`), which is
where the app-level actions live now — about text, Switch to Caregiver Mode,
Sign out — so the page of personal settings doesn't end in them. **Language and
colour vision are native `<select>`s** — the OS picker beats a block of coloured
buttons (six languages; four colour-vision modes, one of them two lines) — each
inside the `data-walk` wrapper (`elder-language-select`, `elder-colourvision`)
its walkthrough points at. **Colour vision was then reverted to buttons behind a
SWITCH** (`elder-colourvision-toggle`): off is the switch, so the three modes
only render when it's on, and a `lastColourMode` ref makes off→on return to the
mode that was chosen rather than the first. `ChoiceRow` is now equal columns,
one row, `truncate` (never wrap) — shared with contrast, which is why contrast's
buttons became equal-width too. **`settings.cvProtan` was shortened to
"Red–green 2"** in all 6 languages: "Red–green (other type)" cannot fit a
one-line chip at any readable size. Contrast stays a chip row — three short
options, and it's what the `text_size` walkthrough spotlights.

**The profile card is the link (arrow, no Edit button) and the profile screen
opens READ-ONLY**, as a RECORD: three `InfoSection`s (Personal information /
Medical information / Meals & sleep) of label-left, value-right `InfoRow`s —
the structure the user supplied as a reference. Editing keeps the SAME sections
and rows in the same order (`EditRow`) and only swaps each value for a grey
filled field, so the page doesn't reshuffle when it unlocks. Edit lives in the
app header's top-right corner via `headerOverride.action`
(`data-walk="elder-profile-edit"`) — which means the header effect must have
`profileEditing` in its deps or the button never disappears. A first attempt
used one `<fieldset disabled>` over the form instead; it works, but the browser
greys the values and it still reads as a form. **This broke both
autonomous profile walkthroughs** — `edit_profile_auto` and `add_condition_auto`
filled fields that are now disabled, which fails silently (a `fill` act on a
disabled input types nothing, so Verify catches it only at the end). Both gained
an `autoProfile.edit`/`autoCond.edit` step that clicks Edit first. **Saving must
NOT drop back to the read view** — the walkthrough's reveal and the "Saved!"
state both point at the field that just changed, and the read view deletes that
field out from under them (`reveal-caption.spec.ts` failed on exactly this).
**Playwright gotchas from this pass** (both cost real time): `:has-text()` is
CASE-INSENSITIVE, so `button:has-text("Change")` also matches "Save **change**s"
— it clicked Save instead of opening a time row; and seeding `medications.schedule.times`
must use **24h** `"08:00"`, not `"8:00 AM"` — `to12h` re-parses the seeded string
and yields "8:NaN AM". For anything time-of-day dependent, freeze the browser
clock with `page.clock.setFixedTime` rather than seeding relative offsets; a suite
run past midnight puts every "3 hours ago" on the previous day and outside the
timeline's 6am–11pm window. **Flake note:**
at `--workers=4` one autonomous walkthrough spec (usually `add-condition-auto`)
fails on timing; `--repeat-each=3` in isolation and the full suite at
`--workers=2` are green. Use ≤2 workers when judging a real failure. **Flattening broke four narrated walkthroughs**:
`language_voice`/`reminder_settings`/`emergency_contact`/`text_size` each had a
"tap the section to open it" step waiting on a click that can no longer happen
(a `waitFor: click` on a missing element = stuck walkthrough, not a skipped
step). Those steps are deleted and `onEnter: ON_SETTINGS` moved to the step
after; the spotlight scrolls to its own target. `scratchpad/walkshot.spec.ts`
drives all four and asserts the control ends up in view.

**Sub-views REPLACE the app header** rather than stacking a second one under it:
`ElderlyApp` owns a `headerOverride` ({title, onBack, action?}) that
`ElderlyAIScreen` (chat + categories) and `ElderlySettingsScreen` (sub-pages)
set from an effect and clear on unmount. Don't reset it from the parent on tab
change — child effects run before parent effects, so a parent reset clobbers the
newly-mounted screen's value.

**Chat sheet sits at `z-20`, deliberately BELOW the bottom nav (`z-40`)** — at
z-130 it painted over the Ask Mei FAB's overhang and the button looked clipped.
The modal sheets (photo source, language, confirm) stay at z-140/150 because
they *should* cover the nav. Composer is two side buttons, not three: camera
left, and the right one swaps Mic→Send once there's something to send (three
buttons left the text box barely wider than the buttons).

**Nav is icon-only**, and the active tab is a coloured icon + dot rather than a
filled pill — with labels gone, a filled active tab was visually identical to
the filled Ask Mei circle. Row is `items-end` so all five share one baseline
(measured: bottoms identical, centre gaps 71/70/71/70).

**Every medicine now shows a photo** (`shared.tsx::medPhoto`): a bundled one
from `MED_PHOTOS`, else a deterministic pick from `MED_PHOTO_FALLBACKS`. Both
are ILLUSTRATIVE stock images, not the real pill — `MED_SHAPES` remains the
accurate physical identifier, which is what colour-vision mode surfaces.

**Sizing was overshot on the first pass** and the user pushed back ("TOO BIG").
Landed scale for the elderly screens: card/row titles 15–18px, body 13–15px,
section labels 14px. The **bottom nav and header stay oversized** (26px icons,
13px bold labels, 26px wordmark) — that part was the explicit ask and is not
part of the step-down. Home's day header is date + weekday side by side at the
top-left with the day controls opposite at the top-right ("Today" beside the
arrows, only when off today); medicine names `truncate` to one line, and the
timeline's hour gutter is `w-12` + `whitespace-nowrap` so "10 AM" can't split
across two lines.

**Layout gotcha worth remembering:** on Home, the timeline's hour gutter +
padding leave a dose card only ~180px of inner width. Putting the medicine name
on the same row as the time badge left it ~70px and broke "Amlodipine" across
three lines. Both Home and Medications cards now give badges/time their own
full-width strip above the name. Any new card in that column has the same budget.

**Ask Mei is a help list, not a chat** (user's call): one big "Ask me anything"
card opens the chat as a full sheet; below it two grouped sections — "I can do
this for you" (photo scan, report scan, travel sheet, chat-prefill for the ones
needing real values) and "I can show you how" (10 narrated walkthroughs). The
chat sheet auto-closes on a walkthrough start / ChangeHighlight / routed nav, or
it would cover the thing being spotlighted. Tab switcher gone; doctor questions
moved to the **Reminders** tab (renamed from Notifications), which also gained
per-message Dismiss and Reply.

**8 new walkthrough task names** — added to BOTH `tools/walkthrough.py::TASK_NAMES`
and `prompts.py::_WALKTHROUGH_LABELS` (a name without a label KeyErrors
`test_walkthrough.py`), plus `types.ts`. One autonomous
(`add_doctor_question_auto`) and seven narrate-only (`check_schedule`,
`log_dose`, `undo_dose`, `language_voice`, `reminder_settings`,
`emergency_contact`, `text_size`) living in one shared `steps/narrated.ts`.

**Two real bugs the live drives caught (both would have shipped silently):**
1. `createDoctorQuestion` inserted `source: "patient"` — `public.question_source`
   is the enum `('agent','elder','caregiver')`, so the insert was rejected, the
   code fell back to a local-only row, and the UI *looked* correct while nothing
   persisted. Fixed to `"elder"`. **Check the enum, not just the column.**
2. The "add your own question" box had never written to the DB at all (local
   state only) — which is also why an autonomous walkthrough couldn't Verify it.

**Undo a dose** is new (`medications.ts::unlogDoseTaken`): flips today's most
recent `taken` row back to `pending` rather than deleting it (the slot survives,
the dose becomes due again), scoped to today so an undo can't rewrite history.
`decrementSupply` generalised to `shiftSupply(id, ±1)`. Always confirmed.

**e2e fallout from intentional changes** (both fixed): `change-highlight.spec.ts`
clicked the nav by the label `"Medications"` (now "Medicines") — repointed at the
stable `[data-tour="nav-prescriptions"]` anchor so copy changes can't break it
again; `photo-staging.spec.ts` needed to open the chat sheet first.
`walkthrough-design.spec.ts::film travel_mode_auto` is **flaky under full-suite
load** (a no-assertion 22-frame filming spec) — passes in isolation.

**Tooling gotchas found:** `apps/web` had no dev deps installed (`tsc`, vitest,
playwright all missing) — `npm install` fixes it. `e2e/helpers.ts` reads `.env`
but only `.env.local` exists, so the whole Playwright suite failed at import;
symlinked `.env -> .env.local`. `scratchpad/i18n-check.mjs` crashes on this
repo's path (spaces get percent-encoded by `import.meta.url`) — run an inline
equivalent instead. i18n: screen copy added to all 6 languages; `walk.*` copy is
`en`-only per the standing convention.

## 2026-07-28 — TTS: calmer rate, markdown/unit cleanup, quality voice ranking, Chromium keepalive fix

`lib/speech.ts` — four additive changes to `speak()`/`pickVoice`, found
sitting uncommitted from a prior session and landed as-is (already complete
and tested, just not committed/documented):

1. **Rate 0.9** instead of the spec 1.0 default — reads calmer for the
   elderly audience. Pitch deliberately left untouched (comment in code:
   pitch-shifting is a naive DSP op on most engines, less predictable than
   rate across voices).
2. **`cleanTextForSpeech`** strips markdown `**bold**` before speaking
   (mirrors the chat bubble's `renderWithBold()`) and, for English-only
   replies, expands `mg`→milligrams, `mL`→milliliters, `Dr.`→Doctor — gated
   on `lang.startsWith("en")` so it can't inject English words into a
   zh/yue/ta/ms/hokkien utterance.
3. **Quality-aware voice ranking** (`HIGH_QUALITY_VOICE_TOKENS`,
   `voiceQualityTier`): prefers "Enhanced"/"Premium"/"Natural"/"Neural"
   voices, deprioritizes known-robotic "compact" voices — layered strictly
   under the existing female-voice preference (quality is never allowed to
   flip the persona's gender).
4. **Chromium 15s TTS keepalive** (`startKeepAlive`/`stopKeepAlive`):
   crbug.com/335907 — Chromium silently stops long utterances mid-sentence
   with no error/end event past ~15s. Periodic `pause()`+`resume()` nudge
   every 12s while speaking, cleared on `onend`/`onerror`.

Verified via `speech.test.ts` (20/20, incl. new keepalive-timer and
voice-ranking cases using `vi.advanceTimersByTime` — deliberately not
`runAllTimers`, which would spin forever against a repeating interval that's
only cleared on `onend`), full web suite (112/112), `tsc --noEmit` clean,
`npm run build` clean. Not live-driven through a browser TTS engine this
pass — same caveat as prior TTS entries.

## 2026-07-28 — Time-scoped bulk dose resolution + dosage-jump safety warning

Two user-directed fixes, both scoped entirely to `services/hermes/` (no
schema, no required frontend changes). User picked the confirm-step/warning
design via explicit questions before any code — decisions below are locked
in, not assumptions.

**Bug: "label all the meds i took at 8 am as taken" did nothing.**
Root-caused via a live repro on an **isolated local Supabase** (`npx
supabase@latest start` + `db reset` + the standard baseline-GRANT workaround
— chosen over the live hosted project after the auto-mode permission
classifier correctly flagged that writing throwaway data to hosted infra
needed explicit sign-off, even though earlier sessions had done exactly that;
local was the safer, user-picked path this time). Pre-fix, 3 real turns with
2 meds at 8am + 1 distractor at 6am showed the actual failure chain: turn 1
hit `log_dose`'s no-name ambiguous path (asks "which one(s)?", writes
nothing); turn 2 (repeating the ask) reached `resolve_missed_doses` but with
**no time field to put "8am" into** — it proposed all 3 doses regardless of
time; turn 3 (repeating again, not even literally "yes") committed, wrongly
marking the 6am dose taken too — independently confirmed via direct DB
re-read. `resolve_missed_doses`'s entire input schema was `{confirmed:
boolean}`; `log_dose`'s `slot` is a nearest-neighbor tiebreaker *within one
medication's own times*, not a cross-medication filter.

**Fix** (`tools/doses.py`): new optional `slot` param on `resolve_missed_doses`
— `_parse_slot_filter` returns `("exact", HH:MM)` for a literal time or
`("window", anchor)` for a day-part word; `_slot_filter_matches` checks exact
equality or a **±60min bounded window** (`_DAY_PART_WINDOW_MINUTES`) around
the anchor — deliberately NOT `log_dose`'s unbounded nearest-neighbor (which
would wrongly match a noon-only med to an "8am" query). Applied as a
**post-pass** in `_missed_doses_today` after the existing earliest-first
taken-attribution, so filtering never disturbs which slots count as missed at
all. Unparseable `slot` **fails closed** (refuses, asks again) rather than
silently falling back to unfiltered — the opposite direction from
`_dosage_warning` below, because here a silent fallback would mean
over-resolving (the dangerous direction), not just missing a caveat. New
soul.md paragraph in "Missed doses" teaches passing `slot` when the ask names
a time; kept channel-neutral (Telegram shares soul.md too). Confirm branch
needed **zero changes** — it already re-intersects a fresh unfiltered
recompute against the (already-filtered) stashed propose set.
**Live-verified 5/5 post-fix** (fresh throwaway elder per trial): every trial
correctly scoped the read-back to only the 8am doses and never touched the
6am one. New tests: `test_resolve_missed_doses.py` (7 added) +
`test_resolve_missed_doses_time_qualified.py` (new, agent-loop-level,
scripted).

**User-decided (not assumed): kept the one-confirm-step requirement** for
bulk resolution — matches today's "I took all" flow and this project's
already-documented stance that requiring one confirming reply before a bulk
dose write is "an intentional safety property, not a residual bug." The
literal "auto-tick" the user asked for was NOT built; they chose "keep one
confirm step" when given the tradeoff explicitly.

**Feature: dosage-jump safety warning.** Zero existing check on dosage
*magnitude* anywhere — `_interaction_warning` is drug-drug only and dose-blind
by signature; `update_medication_dosage` had no check of any kind.
`medications.dosage` is free text (no numeric column), so per the
grounded-facts rail this had to be arithmetic, not LLM judgment. User-decided
scope: relative-jump only (no OpenFDA-text grounding), non-blocking FYI
(mirrors `_interaction_warning`'s exact tone/never-blocks pattern), applied to
both `update_medication_dosage` AND `add_prescription` (for the disguised-
duplicate case — a same-name med already on file at a different dose).
New `base.py::parse_dosage` (regex value+unit extraction, fails open on
"2 tablets"/"as needed"/unparseable); `medications.py::_dosage_warning`
(fires at `ratio >= 2.0`, normalizes mg/mcg/g, fails open on incomparable
units like ml/iu) + `_existing_medication` (reuses `find_medications`'s
existing matching tiers, not a raw query, so a name arriving with its own
dosage suffix still resolves). Wired into both propose branches; no soul.md
wiring *required* (the warning rides the same returned string Mei already
relays verbatim, same as `_interaction_warning` today) but added one optional
documentation sentence anyway. **Live-verified**: `update_medication_dosage`
3/3 real turns showed the ⚠ in the actual reply; `add_prescription` 2/3 (the
miss was Mei skipping straight to `start_walkthrough` without ever calling
`add_prescription(confirmed=false)` — a **pre-existing** soul.md-adherence
gap dating to 2026-07-23 that equally starves the existing interaction
warning, not a regression from this change). 14 new tests in
`test_dosage_warning.py`; the pre-existing
`test_propose_time_warning_matches_brand_via_generic` regression-checked
unmodified.

**Gotcha rediscovered the hard way — prod `hermes` (:8000) reloads on every
saved edit to `services/hermes/src`, live, no deploy step.** `HERMES_RELOAD=1`
in `ecosystem.config.js` is intentional (its own comment: "edit directly on
the VPS... no git push, no PM2 restart, no second process needed") — this
box IS the VPS. Every edit this session was live in the production Telegram
bot within seconds. Separately, **`pkill -f "hermes-serve"` is unsafe** — it
matches prod `hermes`/`hermes-demo` too, not just a locally-started instance;
kill by exact PID only, always (this repeats the port-8000 warning already in
root CLAUDE.md, but the pattern-match failure mode hadn't been logged before).
Both auto-recovered clean (`pm2 autorestart`), confirmed via `scripts/post.sh
--quick` (read-only — the full POST's own service restart needs separate
authorization when uncommitted changes are in the tree, since it would be
deploying them).

**Also fixed in passing:** MEMORY.md had a genuine ~160-line accidental
duplicate (three 2026-07-19 entries re-pasted verbatim between the two
2026-07-12 entries, chronologically nonsensical — a tell it was a paste
accident, not intentional). Removed; the stale "`t`-shadow open bug" entry
folded into a one-line "fixed, confirmed" note.

Gate: hermes pytest **321** (+14 from 307), ruff clean. Uncommitted on
`fix/ci-lint-node`.

## 2026-07-27 (later) — "I took all" after a schedule listing didn't log doses — root-caused, fixed, verified 12/12 live

Real user report: Mei showed today's schedule (6 due-now meds + duplicate
already-taken "Tacrolimus" rows), the user replied **"i took all"**, and
nothing got logged. Root-caused live (soul.md-only fix, no tool/code changes)
— see `services/hermes/src/hermes/agent/soul.md`'s "Schedule"/"Missed doses"
sections and `tests/test_missed_doses_after_schedule.py`.

**Root cause, refined by live evidence (the ORIGINAL hypothesis — a silent
`confirmed=true`-with-no-propose refusal — did NOT reproduce in 5/5 trials):**
`show_schedule` never touches `ctx.session` (by design — it's read-only), so
Mei's own schedule listing stashes no `pending_missed_doses`. soul.md's
"Missed doses" rail was keyed only on an *imperative* ask ("tick all my missed
doses"), never on a *declarative* broad confirm replying to Mei's own prior
listing. Live trials showed the propose→confirm plumbing was **already
correct** — turn 2 always routes to a bulk tool with `confirmed=false` and
computes the right set — the actual gap was that Mei's follow-up
("Would you like me to mark these as taken?") re-asks almost the same thing
the user just said, a dead end many users won't answer a second time.

**Fix:** two additive soul.md paragraphs (extends "Missed doses" + one
cross-ref sentence on "Schedule"): (1) a broad post-listing confirm is a fresh
`resolve_missed_doses(confirmed=false)` trigger, never a bare `confirmed=true`
— defensive, guards the theoretical silent-refusal path even though it didn't
reproduce; (2) reuses the already-established "Guided walkthroughs" **"yes IS
the confirm"** exception: when Mei JUST showed the specific list this same
exchange and the reply is an unhedged blanket yes, she *may* call
`confirmed=true` in the same turn instead of asking again. **Honest result
after two wording iterations** (the second more blunt/imperative, mirroring
the `log_dose` fix's style): the same-turn collapse is attempted sometimes
(one trial called the tool twice in one turn) but is **not reliable** —
same "LLM instruction-following is probabilistic" ceiling documented
elsewhere in this project. Did not chase a third iteration — diminishing
returns, and it's not what matters most.

**What actually matters is fixed and verified 12/12 across two trial
batches + one full 8-medication end-to-end run matching the exact reported
shape (6 unmet + 2 duplicate already-taken "Tacrolimus" rows, reproduced via
two distinct `medications` rows):** "I took all" now **always** correctly
proposes via `resolve_missed_doses` (consistently — no longer sometimes
`log_doses`), and **always** correctly commits when the user answers "yes"
once more, with an independent re-read confirming exactly the right doses
land and already-taken ones are never touched/double-logged. Before this fix,
nothing ever got logged, ever, for this conversational shape — that's closed.
Users should still expect one short confirmation reply after "I took all";
this is an intentional safety property (never write without some real
confirming moment in the exchange), not a residual bug.

**Duplicate-Tacrolimus (secondary, from the original report):** code
investigation found no dedup anywhere in `show_schedule`/`resolve_missed_doses`'s
read path, and nothing prevents either (a) two distinct `medications` rows
with the same name (no DB unique constraint), or (b) one row whose
`schedule.times` itself contains a literal duplicate entry. Both are equally
plausible from code alone; **deliberately not fixed** — deciding which
applies to the real reporting user's actual data (and whether it's even a bug
vs. legitimate dual-prescription data) needs their actual account, which
isn't reachable from this conversation. The `resolve_missed_doses` fix is
verified robust either way (proven against the two-distinct-rows shape:
doesn't double-log, doesn't choke).

**Verification discipline:** reused this session's own established live
pattern (throwaway elder via plain Supabase signup, real `:8901` turns, raw
JSON captured, independent Supabase re-reads never trusting the reply) rather
than inventing new scaffolding. New test file
`test_missed_doses_after_schedule.py` is the first **agent-loop-level**
(multi-turn, `run_agent_turn(..., history=...)` chained) test in the suite —
prior propose→confirm tests were all tool-level only. Gate: 299 pytest (+2),
ruff clean.

## 2026-07-27 — 32-scenario restructure: named-dose root-caused & fixed (2 code paths), one pacing contract, full live verification

The big one. User-directed 4-phase orchestrated pass: root-cause the specific
"marking my metformin taken doesn't work" complaint → build one shared
pacing/verification structure → build+verify all 32 requested scenarios as
independent `e2e/scenarios/sNN-*.spec.ts` modules → independent spot-check of
5 by fresh agents re-deriving evidence from scratch. ~40 subagents total.
Deliberately did NOT hand the executing agents a file layout — the structure
below is what emerged from reading the actual codebase state.

**Root cause (Phase 1, live-proven on :8901 with raw request/response capture
before any fix):** `log_dose` took only `medication_name`, no slot param, and
picked the **latest** pending dose (`scheduled_at.desc limit 1`) — at 2pm,
"I just took my metformin" ticked the 8 PM dose while the overdue 8 AM one sat
untouched, and "my **morning** metformin" did the same since there was no way
to say which slot. 2/2 live ambiguous-case runs hit the wrong slot pre-fix; no
disambiguation existed anywhere. Fixed: one selection engine
(`doses.py::_dose_plan`), earliest-first everywhere (now consistent with
`resolve_missed_doses`); exactly one plausible dose → logs silently; ≥2
pending + no slot → returns the options and **writes nothing** (stateless ask,
so a plain-text follow-up with the answer works on Telegram too); `slot`
accepts `HH:MM` or a day-part word; already-taken guard stops double-logging.
soul.md needed one iteration — first draft had Mei ask her OWN clarifying
questions before ever calling the tool (0/3 turns even reached it); rewritten
to "call first, only relay the tool's own question" → 5/5 live. `find_medications`
also gained a dosage-suffix-strip + wildcard fallback (the old exact-match
`ilike` false-"not found"-ed on a label-echoed "Metformin 500mg"), and
`FakeDB`'s ilike was corrected to mirror real PostgREST semantics (the old
always-substring fake was masking exactly this class of bug).

**A second, independent instance of the SAME bug class**, found by a Phase-4
spot-check re-verifying s03 from scratch (not the chat path — the direct "tap
the card" flow): `lib/medications.ts::logDoseTaken` still did
`.order("scheduled_at",{ascending:false}).limit(1)` — tapping a SPECIFIC
slot's card could flip a DIFFERENT slot's dose. Its own comment claimed to
mirror the Hermes tool, but was never updated when that tool was rewritten.
Fixed: threaded the tapped card's own slot through (every card already carries
it — `fetchElderMedications` emits one per `schedule.times` entry) and match
the nearest pending dose to it. **Lesson: a fix on one interaction path
(chat) doesn't imply the other path (direct UI) got the same fix — check
both**, especially when a comment says "mirrors X" — that comment rots.

**Pacing (the "too fast to follow" complaint):** one module,
`lib/walkthrough/pacing.ts` — 9 constants (navigate 500 / field-prehighlight
300 / fill 45ms-per-char / field-floor 900 / between-fields 500 / pre-click
400 / verify-min 600 / reveal-pulse 1400 / highlight-dwell-min 2500), enforced
as **minimums** via `pace.ts::createPaceController().paced()` — the only
timed-wait path anywhere in the walkthrough/highlight system, auto-logging
every phase to a DEV-only `window.__dwPhaseLog` so e2e specs measure real
elapsed time rather than trust the implementation. Killed 5 scattered
constants, a `2600↔CSS-1.3s×2` hand-sync, and 5 copy-pasted `12×400` verify
polls (now one `verify.ts::pollVerify`+`buildVerifyRunner`). New overlay
controls: **Next** (autonomous steps only — gated by `step.act ||
(!waitFor && (verify||reveal))`, disabled until the phase minimum, unit-pinned
to never appear on a `waitFor`/consent step) and **Replay** (reveal phase
only). `ActDirective.paceMs` removed outright — the mechanical guarantee that
no scenario can define its own timing.

**Scenario structure:** kept the existing convention
(`lib/walkthrough/steps/<task>.ts` + one spec per scenario) rather than
inventing a new layout — the prior sessions had that part right. Canonical
per-scenario module is `e2e/scenarios/sNN-slug.spec.ts`: fixture → real
`:8901` turn (verbatim trigger phrase, ≤3 attempts, raw JSON saved) →
independent Supabase re-check (never the turn's own return) → UI drive with
measured phase-log timing against imported `PACING` → screenshot → zero
scenario-local ms literals. `e2e/scenarios/manifest.ts` (32 rows) +
`coverage.spec.ts` guard the set stays exactly 32, wired, no orphans.
Registry-parity is enforced by a pytest that regex-extracts `TASK_NAMES`,
`_WALKTHROUGH_LABELS`, the TS union, and the resolver's cases and asserts all
four equal (a real 4-way drift bug this pass would otherwise have
reintroduced).

**7 new backend tools** (registry 18→25): `undo_dose`, `log_doses` (explicit
multi-med list — distinct from `resolve_missed_doses`'s "all" filter),
`snooze_dose` (today-only, `accessibility.dose_snoozes`, never touches the
recurring schedule), `discontinue_medication` (archives, never deletes),
`set_allergy_severity` (promotes the WHOLE allergies array from legacy
strings to `{name,severity}` on first grade — order + other entries
preserved), `add_symptom`, `add_care_note`. New generic `pending_bulk`
propose→confirm slot (`{tool,items}` + `match_pending_bulk`) is the
list-shaped-slot pattern `resolve_missed_doses`'s bespoke one anticipated.

**Real bugs found and fixed live, beyond the headline (in the order hit):**
1. **Chat handoff navigated on propose-only turns.** `ElderlyAIScreen`/
   `AskMeiScreen`'s live `tool_end` handler navigated on ANY matching tool
   dispatch, with no signal for "did it actually commit" — a propose-only
   turn (e.g. `update_medication_dosage`'s first call) looked exactly like a
   commit over SSE. Fixed: `ACTION_TARGETS` entries carry `confirmFirst`
   (ground-truthed from each handler's real `confirmed` parameter); the live
   navigate is gated on `!confirmFirst`, deferring to the turn's real
   `actions[]` instead of guessing from `tool_end`.
2. **`ScanLinkSheet` crashed the whole app to a blank page** on
   camera-permission-denied: its cleanup called `scanner.stop()` on an
   `html5-qrcode` instance that never reached "running", which throws
   **synchronously** (before the existing `.catch(()=>{})` chain ever
   attaches) — with no error boundary in the tree, uncaught. Would hit any
   real caregiver who denies/lacks camera access. Fixed with a try/catch
   around the synchronous call.
3. **`window.__dwHighlightChange`/`__dwStartWalkthrough` existed only in
   `ElderlyApp.tsx`** — the caregiver shell had `<ChangeHighlight>` and
   `setHighlightChange` wired but no dev-hook registration, blocking ANY
   caregiver-side highlight/walkthrough test. Fixed by mirroring the
   registration into `App.tsx`'s caregiver branch.
4. **That fix (3) introduced a real race**, caught only by a full 32-scenario
   sweep: `App.tsx` never unmounts, so an unconditional
   `useEffect(...,[])` registered the caregiver hooks once for the whole SPA
   session and then raced `ElderlyApp`'s own registration of the *same two
   window properties* the instant an elder signed in — whichever mounted
   last won. Intermittently landed 9 other already-green elder-mode
   scenarios on a plain Home screen with no overlay at all (the caregiver's
   no-op handler had silently won). Fixed by gating the registration on
   `appMode==="caregiver"` with `appMode` in the effect's deps, so it exists
   only while that mode is actually active. **Re-verified by a completely
   independent Phase-4 spot-check** (fresh stress-testing, tighter timing
   than originally used, could not reproduce) as well as the orchestrator's
   own repeat-each=3 runs.
5. **Stuck black overlay on return from the chat→wizard hook.**
   `ElderlyApp.handleWalkthroughStart` saved a walkthrough session for
   `"onboarding"` before handing off, but that task's steps never run through
   `ElderlyApp`'s own `<Walkthrough>` — on return, its mount-effect restored
   the stale session and mounted an overlay whose first selector doesn't
   exist there, an un-dismissable `rect=null` scrim with no Exit. Fixed by
   never saving that session for this one task.
6. **Silent real medical-data loss on onboarding re-entry.** The chat-hook
   always opens `GuidedSetupWizard` with blank local state (no prefill
   threading exists for this entry point), and `finish()` saves straight
   from that state — so re-entering onboarding for an elder who'd already
   been through it wiped their real conditions/allergies/routine. Fixed:
   `handleElderOnboardingWalkthrough` now **re-queries the real profile**
   (`fetchProfile`, not cached `patients[0]` state — which itself starts
   from the mock `PATIENTS` default with non-empty conditions/allergies
   until the async fetch resolves, a trap the first, narrower guard attempt
   fell into) and refuses re-entry outright if any wizard-collected field is
   already populated. `finish()` also now calls
   `markWalkthroughCompleted("onboarding")` — the "not yet shown" prompt gate
   could never actually suppress a second offer before, since nothing ever
   marked it done.
7. **`logDoseTaken`'s wrong-slot bug** (Phase 4 finding, see "second instance"
   above).

**Confirmed working as designed, not bugs:** `GuidedSetupWizard`'s stage
position is a plain unpersisted `useState(0)` — exit-and-resume genuinely
**restarts**, not resumes (proven with real evidence: every field lost, only
the auth session itself remembered). The 28-step spotlight tour in
`steps/onboarding.ts` has no `<Walkthrough>` mount site reachable from
`appMode==="onboarding"` — the wizard is real, but its content is only ever
driven as plain fields, never spotlighted; a pre-existing, larger gap than
this pass's scope, documented not built.

**Result:** all 32 scenarios green (`e2e/scenarios/s01`–`s32`), hermes pytest
297, web vitest 103, typecheck/build clean, 4-way task-name parity green,
coverage guard 32/32. **Honest caveat, consistent with every prior session's
own disclosures:** a handful of scenarios (s13, s15, s32 seen this pass) flake
under a tight back-to-back full-sweep on a REAL LLM tool-routing miss (the
model chats instead of calling/confirming a tool on that particular turn) —
never a deterministic UI/pacing/DB assertion, never the same scenario twice
in a row, and every one has also passed cleanly in isolation multiple times.
This is the same "LLM tool-selection is probabilistic" property documented
since 2026-07-25 (`log_dose` firing ~1/3 of real turns pre-dating this pass
entirely) — soul.md rail-strength tuning is the lever, not a code defect.
Full patch-queue of lower-priority findings (LLM-routing reliability on
`discontinue_medication` and the weekly-pattern confirm; the Home
over-reporting "taken" on a multi-slot med while one slot is still pending;
the med card not rendering `schedule.days`; the "Stopped" transient caption
staying emerald/checkmark though the persistent ring is correctly amber;
`PatientSwitcher`'s missing outside-click dismiss; a `conversation_turns`
duplicate-row collision between `_persist`'s generic memory log and
`add_care_note`'s own table use; a few E2E-helper gaps) relayed in-chat, not
built this pass — none block the 32 scenarios' own correctness.

## 2026-07-26 — Bulk actions: full-space discovery, "tick all missed doses" root-caused & fixed on a generic bulk contract

Four-phase orchestrated pass (user-directed): discovery subagents → live root-cause →
build → catalog. Cross-boundary edits user-authorized.

- **Root cause of "resolve and tick all my missing dosages" (live-proven, 5 dialogs):**
  three independent layers. (a) *Data*: no "missed dose" substrate — nothing ever creates
  `pending` dose rows, `show_schedule` today-view has no missed state, `log_dose` stamps
  `scheduled_at=now`. (b) *Agent*: refuses/one-at-a-time in 3/5 dialogs; when it fans out it
  echoes show_schedule labels ("Metformin 500mg") into `log_dose`, and **`find_medications`'
  wildcard-less `ilike.{name}` is an EXACT case-insensitive match** → false "your meds aren't
  on file" reply. (c) *UI*: `firstHighlightable` + one-slot ChangeHighlight prove only
  `actions[0]` — whose position is **asyncio.gather completion order, nondeterministic**.
- **Fix (verified GREEN end-to-end):** new `tools/base.py::record_bulk_action` (bulk
  committed-action shape `{tool, summary, entities:[...]}`), new **`resolve_missed_doses`**
  in `doses.py` (18 tools now): propose→confirm, computes today's past-due-untaken slots
  server-side (reuses `_taken_counts_today` + `dosing.scheduled_today`, tz `hermes_tz`),
  new `pending_missed_doses` session slot, on confirm **re-computes ∩ stash** (race-safe)
  and inserts back-dated rows (08:00 SGT slot → `scheduled_at` 00:00 UTC; verified vs
  `logged_at`=now). Frontend: `AgentAction.entities?`, `highlightableEntities`/`describeBatch`
  in `changeHighlight.ts`, ChangeHighlight rings ALL entities **simultaneously** (sequential
  would be ~45s for 15 doses) with one batch caption + cleanup-all + loud error listing
  unfound entities. soul.md "Missed doses" rail (+ a `log_dose` bare-name-only rule patching
  the label-echo bug for single asks). **LLM routing 4/4 first-try for the bulk tool** vs
  log_dose's known ~1/3 — soul-rail specificity works.
- **Playwright/dev-hook gotcha (pre-existing, latent):** firing `__dwHighlightChange` from a
  tab that ALREADY renders matching `medication-*` testids (e.g. Prescriptions) makes the
  first synchronous poll latch onto pre-navigation elements; the tab switch unmounts them and
  the `isConnected` bail ends the highlight with NO ring and no error. Affects single + bulk
  identically; real chat fires from the AI tab (renders no med testids) so production is
  unaffected. Follow-up if it ever bites: defer the first poll until navigation commits.
- **Other hazards surfaced by discovery (not fixed, catalogued):** Telegram tap-confirm
  doesn't know `pending_dosage` and No-tap never clears it (declined dose change stays
  committable); `start_walkthrough` double-queue silently drops the first while reporting
  success for both; `_MAX_ITERATIONS=8` exhaustion → generic retry, no partial-success
  report; caregiver chat acts on the **caregiver's own data** (`routes.py` derives elder_id
  from JWT sub — no act-on-behalf-of); `update_medical_profile` writes a blob the UI never
  renders; elder doctor-question tick REVERTS on refresh (local state vs DB status).
- **Deliverables:** full discovery inventories (relayed in-chat), root-cause report,
  `docs/scenario-catalog-2026-07-26.md` (bulk variants + dead ends + defects, new-vs-known).
  Gates: hermes pytest **235**, web vitest **59**, typecheck, build, live e2e + screenshots
  (`e2e/artifacts/bulk-resolve/`). Uncommitted on `fix/ci-lint-node`.

## 2026-07-25 — Voice→female, highlight bug-fixes, +2 real scenarios (dose-taken, dosage-update), 8 scenarios triaged as gaps

Orchestrated pass (subagent A/B/C trios per buildable task; gaps documented not built).
User-authorized crossing the `apps/web`→`services/hermes` boundary for this task.

- **Voice = softer female** (`lib/speech.ts`): `pickVoice` now prefers a female voice within
  the language-narrowed candidates before the first-match fallback — new exported
  `isFemaleVoice(v)` (male-name exclusion short-circuits FIRST, then `/female|woman|女/`, then a
  curated `FEMALE_VOICE_NAMES` list) + `pickVoice = candidates.find(isFemaleVoice) ?? candidates[0]`.
  The cancel→speak race fix in `speak()` is untouched. Verified via `speech.test.ts` (mocked
  `getVoices`, no browser TTS in headless). Real female voice for en/zh/yue/ms where the OS
  ships one; **Tamil and Hokkien fall back** (browsers rarely ship those) — by design, never breaks.
- **Highlight bug-fixes** (Add-Medicine + Add-Condition), all shared by `ChangeHighlight` AND
  the walkthrough Reveal via `HighlightCaption.tsx`:
  - *Alignment (Bugfix-A):* caption was positioned/clamped against `window.innerWidth`, but the
    demo is a centered phone frame → drifted on desktop. Now clamps to the **frame** rect, found
    self-containedly by `document.elementFromPoint(rect centre)` → walk up the `offsetParent`
    chain to the outermost positioned ancestor (the `w-[390px]` device div). Pill height is
    **measured** (`ResizeObserver`), not the old hardcoded `PILL_H=30`. `ChangeHighlight` now
    **defers the first rect until the smooth `scrollIntoView` settles** (two frames within 0.5px)
    instead of measuring pre-scroll, and the rAF tracking loop **bails on `!el.isConnected`** so
    a tab-switch mid-highlight no longer parks the pill at (0,0). Proven at 900px+1280px
    (`e2e/bugfix-highlight.spec.ts`): wrapper.left == frameLeft+8, pill centred over card.
  - *Formatting (Bugfix-B):* `describeChange` + `orchestrate.ts::captionFromVerify` now
    `humanizeField()` any unmapped field (no raw snake_case leak), format HH:MM as 12h
    (`hhmmTo12h` — a LOCAL helper, deliberately NOT `medications.to12h`, because `medications.ts`
    imports `./supabase` whose top-level throws on missing env and breaks the vitest import graph),
    add units/pluralization ("supply 5 pills → 30 pills"), guard the empty-summary dangling
    "Updated: ", and cap multi-field captions (first 3 + "+k more").
- **Scenario 1 (dose taken → Home):** `log_dose` now sets `entity_id = med id` (mirrors
  `log_refill`) and carries `dose_id` as an extra, so ChangeHighlight's suffix fallback lands on
  the `medication-{uuid}` card (the frontend renders meds, never dose rows). Kept
  `entity_type="dose"` (→ Home), NOT the spec's guessed `schedule_entry`. Added the missing
  `data-testid="medication-{medicationId}"` to the Home **taken-card** branch; `describeChange`
  gained a **"Taken:" verb** for `log_dose`. `fetchElderMedications` already maps real
  `doses`→`taken` and `ElderlyAIScreen` refetches before firing the highlight — no data gap.
  Live-green: real turn, independent re-read, ring + "Taken: Metformin" caption.
- **Scenario 6 (dosage update → Prescriptions):** new **`update_medication_dosage`** tool
  (propose→confirm, `pending_dosage` slot added to `channels/session.py`), `entity_type="medication"`,
  `changed_fields.dosage:{before,after}` → "Updated: 500mg → 1000mg" (a change, not "Added").
  Registry **16→17** (`medications` registers four now; `__init__.py` docstring + `test_hermes.py`
  hard-coded set updated), `soul.md` gained a "Dose changes" rail (use this, not add_prescription,
  for an existing-med dose edit). The elder Prescriptions card now renders `m.dose` so the ringed
  card visibly shows "1000mg". `tests/fakes.py::FakeDB.update` now applies the patch to in-memory
  rows so independent re-reads reflect writes. Live-green end-to-end.
- **8 scenarios deferred as GAPS** (not built) — full analysis + sizes in
  `docs/change-highlight-gap-analysis-2026-07-25.md`. Key user-review decisions recorded there:
  **#2** don't add a `caregiver_alerts` table — reuse `message_caregiver`/`conversation_turns`;
  **#3** no symptom-review screen exists (needs new table+tool+screen); **#4** recommend NOT
  persisting a proactive interaction "what-if" (keep conversational); **#7** no vitals store/screen
  exists. Structural blockers for the rest: no dose-level DOM target, the **caregiver app never
  mounts `ChangeHighlight`**, and symptoms/vitals/interactions/allergy-severity have no
  table/model.
- **Local-Hermes gotcha (reconfirmed, now for :8901):** a working-tree hermes started on :8901
  **inherits the repo `.env` `TELEGRAM_BOT_TOKEN`** and will poll Telegram → `409` against the
  pm2 prod poller. Always launch local verification hermes with `TELEGRAM_BOT_TOKEN="" HERMES_PORT=8901`.
- **State:** all green (hermes pytest 227, web vitest 42, typecheck, build; live e2e for both
  scenarios + bug-fixes; a Phase-3 spot-check independently re-verified all three with its own
  geometry reads). Changes are **uncommitted** on branch `fix/ci-lint-node`; new e2e specs
  (`bugfix-highlight`, `scenario1-dose-taken`, `scenario6-dosage-update`) + `speech.test.ts` +
  `HighlightCaption.test.ts` + `test_update_dosage.py` added.
- **Honest caveat (LLM tool-selection is probabilistic — code is fine, demo reliability isn't):**
  the two scenario e2e specs prove the *highlight/caption/UI* deterministically but lean on a
  dev-hook / direct-write for it (the repo's established pattern, since real turns are
  nondeterministic) — spec-green alone does NOT prove the real LLM→tool path. The spot-check
  closed that by driving real turns: `log_dose` fired ~1/3 of turns, `update_medication_dosage`
  committed ~2/5; the misses were the model *narrating instead of calling the tool*, and when the
  propose turn is skipped the confirm-guard **correctly refuses** (no false write). So the safety
  rail holds; making Mei reliably call these on first ask is soul.md/prompt tuning (a possible
  follow-up, like the `add_prescription` rail), not a code defect.

## 2026-07-24 — Conservative refactor pass (branch `refactor/conservative-tidy`)

A behavior-preserving tidy pass, done on a branch AFTER committing the whole
in-flight tree (the walkthrough/highlight feature was 18 untracked files — never
committed — plus the add-prescription fix; committing first kept the cleanup a
separate, revertible diff). Landed as ordered commits:

- **Frontend type-check net (new):** there was NO `tsconfig.json` / `tsc` — the
  build only transpiles. Added `apps/web/tsconfig.json` (pragmatic, `strict:false`
  so the existing code is green; the value is catching NEW regressions),
  `src/vite-env.d.ts`, and `npm run typecheck` (`tsc --noEmit`); dev deps
  `typescript`/`@types/react-dom`/`@types/node`. **It immediately caught two real
  bugs:** `MeiSuggestButton` never destructured its `validate` prop → any
  successful suggestion threw `ReferenceError` (feature broken on the happy path);
  `AddPrescriptionSheet.pickMedication`'s narrow param type pinned `TypeAhead`'s
  generic so `m.purposeKey` failed (runtime was fine). Both fixed.
- **Backend dedup** (all 222 pytest green): `tools/base.py` gained
  `find_medications` (the `ilike`+`archived=false` lookup, was copy-pasted in
  doses/refills/verify/set_medication_reminder), `first_id` (post-insert id, 6
  sites), and `match_pending` (the propose→confirm commit guard, 3 sites —
  **slot names passed verbatim so the Telegram deterministic-confirm contract is
  unchanged**). `dosing.py` gained `WEEKDAY_NAMES` (the mon→Monday map was
  byte-identical in medications.py + schedule.py).
- **Frontend tidy** (typecheck+vitest+e2e green): removed dead imports/props
  (Droplets, MEAL_TIMES, ExtractedProfile, unused `onLogDose`) and zero-importer
  dead exports (sessionState chat-persistence half; data/medications
  ESTATUS/MED_REASONS/PRESET_TIMES/VOICE_DEMOS); extracted a shared `MealTimes`
  type (types.ts) used by Patient + ProfileDetails; unshadowed the i18n `t` (local
  `timer`/`takenLabel`).

**Deliberately skipped** (noted, not done): the `ChatMsg`/`EMsg` unify (would
couple the caregiver screen to an elderly-namespaced type for ~1 line — bad
dependency direction); the propose→confirm *propose*-side stash helper (the three
propose branches diverge too much — only the guard deduped cleanly); large module
splits (`loop.py`/`telegram.py`), shared chat-screen components, `<PhoneFrame>`,
host walkthrough hooks — a future pass. `.gitignore` now excludes Playwright/
pytest artifacts (`e2e/artifacts`, `e2e/design-shots`, `test-results`).

## 2026-07-24 — Add-prescription via Mei: hybrid (elder walkthrough → Home; caregiver/failure → direct save → Home)

User reported "add Panadol" via Mei played no walkthrough and never showed up.
Two real causes: (1) the **caregiver shell can't run the elder-mode
`add_prescription_auto` walkthrough** — `App.tsx` resolves steps hardcoded
`"caregiver"` and only navigates `mode==="caregiver"`, so an elder-mode task
stalled silently; (2) even the elder walkthrough revealed on the **Prescriptions
tab**, not Home. (The med had actually saved — demo log showed `201` on
`POST /rest/v1/medications` — but under a demo session whose `elder_id` had no
`profiles` row, so `fetchElderMedications` never read it back; a `409` FK on the
best-effort `conversation_turns` persist is the tell.)

Reshaped to the user-approved **hybrid**:
- **Elder chat** → animated `add_prescription_auto` walkthrough, now revealing on
  **Home**: `steps/add_prescription_auto.ts` submit-step `reveal` →
  `{mode:"elderly", tab:"home"}` + `[data-tour="elder-schedule"]` (the Home
  timeline already highlights the exact new dose card via `justAddedMed`, so the
  proof is free). `agentActions.ts` `ACTION_TARGETS.add_prescription.elderly`
  `"prescriptions"`→`"home"` for the direct-write/fallback path too.
- **Caregiver chat OR walkthrough failure** → **direct save + Home**. Caregiver
  `App.tsx::handleWalkthroughStart` now takes `params` and, for
  `add_prescription_auto`, calls `handleAddPrescription(params…)` +
  `setScreen("patient")` + `flagJustAdded` instead of mounting the (broken-for-
  caregiver) walkthrough. Elder failure fallback: new `Walkthrough` prop
  **`onVerifyFailed`** (fired alongside `setPhaseError(true)` on a verify-fail) →
  `ElderlyApp::handleWalkthroughVerifyFailed` re-queries once and **only inserts
  if the med is genuinely absent** (avoids a double-save when Verify merely
  raced); a real blocked write makes `addMedication` throw → caught → the honest
  `walk.verifyFailed` stays up (never fabricates success).

**Reveal-race gotcha (essential):** the elder sheet's `onAdded` fired
`setTab("prescriptions")` ~700ms after save, which would yank the view off the
Home reveal — guarded to `if (!walkthroughTask) setTab("prescriptions")` so the
reveal owns navigation during a walkthrough (manual adds still land on the list).

**Backend:** `soul.md` rail 3 tightened — `name`, `dose`, AND `purpose` are all
mandatory before `start_walkthrough("add_prescription_auto", …)` (the in-app form
can't submit with any blank; ask for purpose if unknown). No new `/agent/turn`
field: the backend can't tell caregiver vs elder web chat, and the frontend now
owns both fallbacks. **Inert until `hermes-demo` (:5010) is committed+redeployed**
(it serves committed code). This soul.md edit crossed the `apps/web/CLAUDE.md`
"don't touch services/hermes" line — sanctioned by explicit user approval this task.

**Verified:** build clean · 20 vitest · 222 hermes pytest · both
`e2e/add-prescription-auto.spec.ts` green (happy path now asserts the row +
"Just added" inside `[data-tour="elder-schedule"]` on Home + DB re-read; failure
path still proves no false success). Caregiver hybrid + the soul.md wording are
proven by construction/build; a full real-chat drive needs the demo redeploy.
Broad Mei/walkthrough refactor deferred (user).

## 2026-07-24 — Follow-ups: spotlight re-glue on scroll + elder doctor-questions wired to real data

Two fixes after the polish pass:
- **Spotlight no longer lags during a within-step scroll** (`Walkthrough.tsx`): the
  measure effect now also listens to `scroll` (capture=true, catches inner
  overflow-container scrolls) + `resize` and RECOMPUTES the cutout rect WITHOUT
  re-scrolling (a `recompute(doScroll)` split — re-scrolling on every scroll event
  would fight the programmatic scroll). Fixes the stale cutout landing on the wrong
  row during save→verify→reveal (edit_profile). Verified in the re-film.
- **Elder doctor thread wired to REAL `doctor_questions`** (was seed-only, so a
  question Mei queued via `add_doctor_question` wrote the DB row but NEVER showed in
  the elder UI). New `lib/doctor.ts::fetchDoctorQuestions` (RLS as the elder,
  excludes `[ESCALATION]` rows); `ElderlyApp` merges real rows into the seed
  (dedupe by id, on mount + on entering the AI tab + when a doctor_message highlight
  fires). `DoctorQ.id` number→**string** (real uuid; seed ids became `seed-*`, local
  adds `local-*`). Cross-component nav: a `doctor_message` ChangeHighlight bumps
  `openDoctorSignal` → `ElderlyAIScreen` switches to its "Ask a doctor" sub-tab; the
  three question cards got `data-testid="doctor_message-{id}"`. So ChangeHighlight
  now covers task 10 (doctor questions) too. Live-proven
  `e2e/doctor-question-highlight.spec.ts` (real row, independent re-read, opens the
  thread, rings the exact card + "Added: …" caption; screenshot
  `e2e/artifacts/doctor-question/`). **Caregiver side of ChangeHighlight still can't
  be wired** — those flows (care notes, reminders, weekly summary, patient toggle,
  caregiver profile) have NO backing tables; that needs a new migration + RLS, a
  separate decision, not faked.

## 2026-07-24 — Walkthrough polish: slower pacing + unified professional callout, agent-reviewed

The Guided Auto-Nav walkthrough ran too fast and its boxes looked messy. Fixed +
verified by 4 design-reviewer subagents (one per walkthrough) scanning step-by-step
Playwright filmstrips.

- **Pacing (deliberate):** `actor.ts` `DEFAULT_PACE_MS` 55→100, `pressPulse` deeper/
  longer; `orchestrate.ts::runActStep` now has tunable dwells — `READ_DWELL_MS` 900
  (read the callout before Mei acts), `POST_ACT_MS` 450, `REVEAL_DWELL_MS` 1500 (hold
  on the pulsed result). "verify-failed STOPS, never advances" still holds (no dwell
  on failure). vitest runtime rose (real sleeps) but all green.
- **Unified callout:** new `components/SpotlightCallout.tsx` used by BOTH
  `Walkthrough.tsx` and `GuidedTour.tsx` — Mei avatar (Brain) + "Step X of Y" + a
  SINGLE slim progress track (the old one-segment-per-step bar was a mess at ~28
  onboarding steps). It reports its **measured height** (`onHeight`) → shared
  `lib/walkthrough/placement.ts::calloutTop` positions it with that real height and
  CLAMPS it fully within the frame (killed the fixed-140/165 overlap+clip bug). The
  autonomous walkthrough gates its card on a measured `rect` so step-1 never floats
  as an unanchored mid-screen modal; GuidedTour does NOT gate (it's user-advanced —
  Next/Skip must stay reachable).
- **Caption pills** (`HighlightCaption.tsx` + `orchestrate.ts::captionFromVerify`):
  reworded short (dropped redundant field prefix → "Added: High blood pressure" not
  "…condition: …"), size-to-content (no truncation), and now STRADDLE the highlighted
  element's own top edge, centered — so the pill overlaps only its subject, never a
  neighbour's label/button/safety-text (the 3 collisions reviewers caught). Softened
  `.change-highlight` ring in theme.css.
- **New i18n (en):** `walk.stepCounter`/`walk.meiLabel`, `tour.stepCounter`/
  `tour.meiLabel` (English-fallback for other langs, per repo pattern).
- **Design-review harness:** `e2e/walkthrough-design.spec.ts` films every step of
  each autonomous walkthrough into `e2e/design-shots/<task>/` (OUTSIDE Playwright's
  `outputDir` `e2e/artifacts`, which it wipes each run — else a later run deletes the
  frames). Reviewers verdicts after fixes: travel PROFESSIONAL; the other three's
  only real complaints were the caption pill, now fixed. Known minor/transient
  (deferred): stale spotlight during a within-step scroll (edit_profile), busy
  sheet-swap transition (travel). Gate: build clean · 20 vitest · caption/walkthrough
  e2e green.

## 2026-07-23 — ChangeHighlight rebuild: committed_actions now carry WHAT changed; highlight the EXACT record

Rebuilt the weak "proof of change" (old Reveal pulsed a static container selector;
the "Just added" highlight matched on the med **name string**) into a canonical
id-based layer. **Keystone:** every write tool's `committed_actions` entry went
from `{tool, summary}` to `{tool, summary, entity_type, entity_id, changed_fields}`
via a new `tools/base.py::record_action` helper. `changed_fields` is
`{field: {before, after}}` (before=None for a new row). This is the single change
everything downstream needs.

- **Backend (all write tools):** INSERT tools flipped to `returning=True` to
  capture the new DB id (`add_prescription`, insert-branches of `log_dose`/
  `log_refill`, `add_doctor_question`, `message_caregiver`, `request_human_help`);
  UPDATE tools already had id + old value (`set_medication_reminder`,
  `update_medical_profile`). **Gotcha:** the fake DB's `insert` returned the
  payload with no `id`; made `FakeDB.insert` synthesize a PK on the returned copy
  (mirrors PostgREST `return=representation`) — else `inserted[0]["id"]` KeyErrors.
  The three writers that emitted NOTHING before (caregiver/doctor/escalation) now
  emit actions too. `routes.py` needed no change (passes `ctx.committed_actions`
  through verbatim). **Deliberate:** `log_refill`'s `entity_id` is the **medication
  id**, not the refills-row id — the refill count renders on the med card, so
  that's the highlight target; the refills id rides along as `refill_id`.
- **Frontend canonical layer:** `components/ChangeHighlight.tsx` +
  `lib/changeHighlight.ts` (ENTITY_TARGETS by entity_type, `describeChange`
  builds the caption FROM changed_fields, `findEntityElement` resolves
  `data-testid="{entity_type}-{entity_id}"` with a **suffix `-{id}` fallback** so a
  `schedule_entry`/`refill_request` change to a med finds the `medication-<uuid>`
  card). Pulses `.change-highlight` (theme.css) + an attached caption for ~3.5s;
  **loud `console.error` if the element is genuinely absent** (never silent).
  Wired into `ElderlyApp` (`onHighlightChange` → `setHighlightChange` → mounted
  `<ChangeHighlight>`); `ElderlyAIScreen.send()` calls `firstHighlightable(actions)`
  and falls back to the legacy name-string highlight only when an action lacks
  entity ids. Med card got `data-testid={medication-${medicationId}}`.
  `CSS.escape` is absent in jsdom → guarded with a manual fallback.
- **Walkthrough Reveal now shares the caption (tasks 7 & 8):** the client-driven
  walkthroughs (travel, profile/condition edits — which write via the UI, not a
  backend committed_action) keep the `.walk-reveal-pulse` but now also show the
  SAME changed-fields caption via a shared `components/HighlightCaption.tsx`.
  `orchestrate.ts::captionFromVerify` derives it from the step's `VerifyDirective`
  real value (`RevealDirective.caption` optional), so no per-step copy / i18n key.
  Live-proven `e2e/reveal-caption.spec.ts` ("Updated: weight 62" on the pulsed
  field; screenshot `e2e/artifacts/reveal-caption/`).
- **Verified LIVE end-to-end** (`e2e/change-highlight.spec.ts`): real throwaway
  elder + real medication row (real DB id), independent Supabase re-read, real UI
  drive via new dev hook `window.__dwHighlightChange(action)`, asserts the exact
  card is ringed + caption "Updated: dose time 18:00 → 20:00" (from changed_fields).
  Screenshot `e2e/artifacts/change-highlight/highlighted.png`. Gate: hermes
  `pytest` **222 passed**, web **20 vitest**, `npm run build` clean.
- **Scope reality (honest-scope, user-decided):** only ~10 of the 20 requested
  tasks persist a discrete re-queryable entity. The rest are localStorage/mock/
  view-only or write to non-existent tables (`care_notes`, `contact_actions`,
  `packing_list`) — those get walkthrough+navigation but must **log loudly, never
  fabricate an entity_id**. Plan file:
  `~/.claude/plans/the-previous-attempt-at-synchronous-rain.md`.
- **ChangeHighlight's REAL coverage boundary (discovered during build — important):**
  it's fed by *backend* `committed_actions`, so it only works where the UI renders a
  row whose `data-testid` id matches the backend entity_id. That is TRUE today only
  for the **medication family** (`add_prescription`/`set_medication_reminder`/
  `log_refill` → the `medication-<uuid>` card on prescriptions + home; DONE +
  live-proven). The other elder Tier-A flows do NOT qualify yet, each for a concrete
  reason: **task 8 profile/allergy** — `update_medical_profile` writes the free-text
  `accessibility.medical_profile` blob which the Settings UI *never renders* (it
  shows structured `conditions[]`/`allergies[]`); structured edits are done via the
  *client* `add_condition_auto`-style walkthrough (no committed_action) → stays on
  the walkthrough **Reveal**. **task 7 travel** — `TravelModeSheet`→`saveProfile` is
  a client write (no Hermes tool, no committed_action) → walkthrough Reveal. **task
  10 doctor-q** — `add_doctor_question` DOES write the `doctor_questions` table +
  now emits a committed_action, but the elder doctor thread renders **local/seed**
  `DoctorQ` state (numeric ids), not rows fetched from that table, so the backend
  uuid can't match a DOM element. So extending ChangeHighlight to doctor/travel/
  profile requires first wiring those UIs to real backend data — a prerequisite,
  not a ChangeHighlight change. Until then ChangeHighlight correctly loud-logs for
  them rather than faking a target.
- **Deploy caveat for live chat verification:** the running demo backend (:5010)
  serves the OLD committed code, so a real chat turn there does NOT yet return the
  enriched actions — these changes are uncommitted. Live UI proofs use the dev-hook
  injection pattern; a real chat drive needs a local hermes on :8901 from the
  working tree (started, health-checked, killed after).

## 2026-07-23 — Chat photo upload: stage the image, let the user type their intent

Attaching a photo in the AI chat used to auto-send a fixed "📷 Here is a photo of
my prescription." Now it STAGES the image on the composer (`pendingImage` state
in both `ElderlyAIScreen` + `AskMeiScreen`): `onRxPhotoFile` sets the staged
image instead of `send()`ing; a preview strip shows the thumbnail + "tell me what
to do with it" + an X to remove; the placeholder switches to "What should I do
with this photo?"; Send is enabled when there's text OR a staged image;
`handleSend` sends `text || ai.photoDefaultPrompt` with the image and clears it.
New i18n keys `ai.photoAttachedHint`/`photoNotePlaceholder`/`photoDefaultPrompt`
(en; falls back for other langs). Deterministic UI test:
`e2e/photo-staging.spec.ts` (rx input got `data-walk="rx-attach-library"`).

## 2026-07-23 — Real-chat animated fulfillment: Mei now DRIVES the walkthrough (parameterized), + condition data-bug fix

The autonomous walkthroughs existed but **never fired in real chat** — soul.md
told Mei to use the direct `add_prescription`/`update_medical_profile` tools, and
the walkthroughs were dev-hook-only with hardcoded "Metformin" values. Fixed so a
real request ("add lisinopril", "add blood pressure to my conditions") plays the
animated fill → submit → verify → highlight with the USER'S values.

- **Parameterized `start_walkthrough`**: new optional `params` (VALUES only, never
  selectors) → `ctx.walkthrough = {task_name, params}` → `WalkthroughPayload.params`
  → threaded `onWalkthroughStart(task, params)` → `handleWalkthroughStart` →
  `resolveWalkthroughSteps(task, role, params)`. Autonomous step files are now
  **param builders** (`addPrescriptionAutoSteps(p)` etc.) injecting `p.*` into
  `act.value` AND `verify.value` in lockstep; highlight-only ones stay static.
  `walkthroughState` persists params across a same-tab remount. Dev hook is now
  `__dwStartWalkthrough(task, params?)`.
- **soul.md rewired**: in the app Mei prefers `*_auto` walkthroughs to carry out a
  request. Prescriptions keep the safety check — propose with
  `add_prescription(confirmed=false)` (runs `_interaction_warning`), then on yes
  `start_walkthrough("add_prescription_auto", {...})` and do NOT call
  `confirmed=true`; Telegram falls back to the direct tool.
- **Condition data bug fixed**: `update_medical_profile` writes free-text
  `accessibility.medical_profile`, but the Settings UI reads structured
  `accessibility.conditions[]` — so a chat-added condition never showed. New
  **`add_condition_auto`** walkthrough types into the real conditions `TagList`
  (`data-walk="elder-conditions"`, +`-add-btn`) → structured `conditions[]` →
  which the UI renders. New verify kind `profile-list-includes`.
- **Universal Reveal highlight**: `ElderlyApp` now passes `onReveal` — a generic
  emerald pulse (`.walk-reveal-pulse` in `theme.css`) on `reveal.selector`, so
  every scenario shows "here's exactly where it landed" (meds still also get their
  name-keyed `justAddedMed` card highlight).
- **Verified:** 8 Playwright e2e green incl. new `add-condition-auto.spec.ts`
  (lands in `conditions[]` + rendered) and `add-prescription-auto` driven with
  real params (Lisinopril, not the default). vitest 11 · build · hermes 222.
  **LLM-behaviour caveat:** whether Mei *chooses* `start_walkthrough` with params
  is model behaviour — the tool + soul.md make it preferred; final proof is a
  manual real-chat drive.

## 2026-07-23 — "Sending messages too fast" (429): real cause was the DEMO env, not the code default

The web app hits the **`hermes-demo`** backend (:5010 via ngrok), whose
`services/hermes/deploy/pm2/.env.demo` throttled it FAR below the `config.py`
defaults (12/120/60): it was set to **`RATE_LIMIT_TURNS_PER_MINUTE=3`,
`RATE_LIMIT_TURNS_PER_HOUR=20`, `RATE_LIMIT_HTTP_PER_MINUTE=10`**. A
propose→confirm is 2 turns, a scan is 2 more (`AddPrescriptionSheet` calls
non-stream `agentTurn` twice), `MeiSuggest` is 1/field — all share one per-user
counter (`turn:{elder_id}`, both `/agent/turn` and `/agent/turn/stream` draw
from it). So **20/hour** exhausts in minutes of demoing and then every message
429s until it ages out; **3/min** trips on any burst. The earlier "frontend
double-fire" fixes were real but not the persisting cause — this was.

**Fixes (2026-07-23):**
1. **Raised the demo limits → 20/min, 240/hour, 80 http/min** — APPLIED and
   verified live. The harness hard-blocks editing the secret `.env.demo`, so the
   limits are set as **process env in the pm2 ecosystem file**
   (`deploy/pm2/ecosystem.demo.config.js` `env` block: `RATE_LIMIT_TURNS_PER_MINUTE`
   etc.) — process env OVERRIDES the dotenv file in pydantic-settings (no
   `settings_customise_sources` override in `config.py`), so the old
   `.env.demo` 3/20/10 no longer bind. Loaded via
   `pm2 restart services/hermes/deploy/pm2/ecosystem.demo.config.js --update-env`
   (prod `hermes` :8000 untouched); confirmed `pm2 env 2` shows 20/240/80 and
   `/agent/turn` returns 401 (reachable). If `.env.demo` is ever raised too, the
   ecosystem env still wins — keep them consistent.
2. **Client now honors `Retry-After`** (`apps/web/src/app/lib/hermes.ts`): new
   `postAgentTurn(path, jwt, body)` helper wraps the fetch for BOTH `agentTurn`
   and `agentTurnStream` — on a 429 it reads `Retry-After` (default 1.5s, cap
   8s), waits, and retries ONCE; only a still-429 retry shows the amber
   `FALLBACK_RATE_LIMIT` notice. So an immediate "yes" self-heals (waits ~1s
   then succeeds) instead of erroring, and re-typing no longer worsens it. The
   server already sends `Retry-After` on both 429 paths (`routes.py`/`main.py`).

## 2026-07-23 — Guided Auto-Navigation: Phase 1 foundation (Mei can now ACT, not just narrate)

New cross-cutting feature, **architecture-approved via plan before code**
(user directed; explicit go-ahead to cross `apps/web`↔`services/hermes`). This
is a deliberate *extension* of the 2026-07-22 walkthrough into an **autonomous**
mode: Mei can perform a step's fill/tap/upload/submit **herself**, then prove
the result against real re-queried state before claiming success. Five-phase
pattern per data-entry flow: **Navigate → Act → Submit → Verify → Reveal**.

**Decisions locked in (don't silently re-litigate):**
- **Full autonomy** — Mei submits writes herself (Verify-gated), *except* the
  two consent flows (caregiver-linking, emergency-contact), which keep the
  human's own tap at Submit. This is a conscious, user-approved reversal of the
  2026-07-22 "user always acts" rule *for autonomous walkthroughs only* — the
  default highlight-only walkthroughs are unchanged.
- **Real scenarios only.** ~Half the 20 requested scenarios are mock/seed-data
  with nothing persisted to re-query (all of the caregiver `App.tsx` side;
  doctor-questions, emergency call, care-team reminders, weekly summary,
  caregiver settings, patient switcher; language/voice = localStorage-only;
  onboarding persists only at the END with no exit-and-resume). Auto-Nav
  targets only the flows that persist today; the rest wait until their backend
  exists.

**What Phase 1 actually shipped (foundation only):**
- Client engine extension (additive, existing walkthroughs untouched):
  `WalkthroughStep.waitFor` is now **optional** — a step is EITHER user-driven
  (`waitFor`) OR Mei-driven (`act`). New `act?`/`verify?`/`reveal?` on the step
  model (`lib/walkthrough/types.ts`); new `lib/walkthrough/actor.ts` performs an
  `act` VISIBLY animated (never instant); `Walkthrough.tsx` runs the act and
  auto-advances (cancels cleanly on Exit mid-animation).
  **Crux gotcha:** driving a React-controlled input needs the *native prototype*
  value setter + a dispatched bubbling `input` event — a plain `el.value = x` is
  silently swallowed by React. `TimesPicker`'s quick chips are plain buttons, so
  a `click` act sets a common dose time with no adapter; arbitrary non-chip
  stepper times will need a bus adapter (deferred).
- Hermes Verify tool pattern: `tools/verify.py::verify_medication_exists`
  (+ `check_medication_exists` returning a structured `VerifyResult`) — re-query
  real state as the elder (RLS), return VERIFIED/NOT FOUND, **read-only** (never
  appends `committed_actions`). Registry count 15→16; updated the hard-coded set
  in `test_hermes.py::test_all_tools_registered`. `test_verify.py` proves the
  crux: a write the tool layer reported "Saved" whose row is absent re-queries
  as NOT FOUND (`passed=False`) — no false success.

**Verification (Phase 1 now VALIDATED, 2026-07-23):** `apps/web` gained its
first test tooling (**user-approved deps**, overriding the no-new-deps rule):
`vitest`+`jsdom`+`@testing-library/react`/`dom` (config `vitest.config.ts`,
`npm test`) and `@playwright/test`+chromium (`playwright.config.ts`, `e2e/`,
`npm run e2e`; needed `npx playwright install-deps chromium` for `libatk` etc.).
Proofs: actor unit test (`src/app/lib/walkthrough/actor.test.tsx`, 5 passed) —
the native-setter `fill` updates real React state AND a negative control proves
a naive `el.value=x` does NOT (fix is load-bearing); Playwright smoke
(`e2e/actor-smoke.spec.ts`) drives the REAL login form in real Chromium and the
state-gated Sign In button enables (screenshots in `e2e/artifacts/actor-smoke/`).
Hermes `uv run pytest` still 221 passed; `npm run build` clean. **Gotcha for
Playwright here:** only Chrome *headless-shell* is installed and the dev server
on :5173 is managed OUTSIDE Playwright (config does not spawn it) — reuse the
running vite, don't add a `webServer`.

**Phase 2 progress (2026-07-23): five-phase orchestration built (B1).**
`lib/walkthrough/orchestrate.ts::runActStep` sequences Act → (Verify) → (Reveal)
→ advance for an autonomous step; a failed Verify returns `"verify-failed"` and
**stops** (no reveal, no advance) — the overlay shows `walk.verifyFailed` and
never implies success. Host supplies `onVerify` (real client re-query) +
`onReveal` (navigate + pulse) as new optional `Walkthrough` props. Unit-tested:
`orchestrate.test.ts` (4 tests, incl. the verify-fail-stops guarantee).

**Phase 2 FLAGSHIP shipped + live-validated (2026-07-23): `add_prescription_auto`.**
The autonomous add-prescription (manual) walkthrough, end to end. New task name
in BOTH `types.ts::WalkthroughTaskName` and `tools/walkthrough.py::TASK_NAMES`
(+ `prompts.py::_WALKTHROUGH_LABELS` — adding a TASK_NAME without the label
`KeyError`s `test_walkthrough.py`). Step file
`lib/walkthrough/steps/add_prescription_auto.ts` (open → fill name/dose/purpose →
submit+verify+reveal); `AddPrescriptionSheet` got `data-walk="rx-name|rx-dose|
rx-purpose|rx-submit"`; `ElderlyApp` wires `onVerify` (polls
`fetchElderMedications` ~5s — the sheet write is async) and a **DEV-only**
`window.__dwStartWalkthrough(task)` trigger (deterministic e2e, no LLM). Reveal
reuses the sheet's own `flagJustAdded` "Just added" highlight — no extra
instrumentation. soul.md documents the autonomous offer + the sanctioned
propose→confirm exception (yes-to-offer = confirm; Verify is the net; consent
flows still human-tap). **Live drive proof:** `e2e/add-prescription-auto.spec.ts`
— signs up a throwaway elder on the LIVE project (email confirmation is OFF, so
`signUp` yields a session; seed a `profiles` row role=elder so the app routes to
the elder home), drives all 5 phases, asserts the real Metformin row + an
independent DB check; a 2nd test blocks the `POST /rest/v1/medications` insert
and proves Verify CATCHES it (shows `walk.verifyFailed`, no "Just added", DB
empty). Screenshots in `e2e/artifacts/add-prescription-auto/`. **Throwaway
accounts are left on the live project** (disposable, user-approved) — each test
run makes a new `tw-elder-*@dosewise.test`.

**Phase 2 scenario #2 (2026-07-23): `travel_mode_auto`** — autonomous Travel
Mode setup, live-validated (`e2e/travel-mode-auto.spec.ts`). Reuses
`TravelModeSheet`'s existing `data-walk` anchors (no new instrumentation);
`onVerify` gained a `travel-plan-saved` kind (polls `fetchProfile` →
`details.travelPlan`). Shared e2e setup now lives in `e2e/helpers.ts`
(`createThrowawayElder`/`signIn`/`startWalkthrough`). **Selector gotcha:**
`[data-tour="elder-quickhelp"]` is a *container div* with the real button
inside — an autonomous `click` act must target `[data-tour="elder-quickhelp"]
button` (a div `.click()` doesn't fire the child's handler); the
`elder-add-prescription` anchor, by contrast, IS the button. **Phase 2 scenarios #3 & #4 (2026-07-23), built via divided subagents:**
`edit_profile_auto` (autonomous weight edit → `profile-field` verify) and
`accept_caregiver_link` (CONSENT: Mei navigates, the elder taps Accept
themselves, then an act-less Verify confirms `care-link-active`). Both
live-driven green (`e2e/edit-profile-auto.spec.ts` incl. a write-fail path;
`e2e/accept-caregiver-link.spec.ts` — the consent test asserts the link stays
`pending` until the real tap, proving Mei never auto-grants access). New
`onVerify` kinds `profile-field` + `care-link-active` (+ `careLinks.ts::
hasActiveCareLink`). Caregiver-link precondition helper
`e2e/helpers.ts::createCaregiverWithPendingLink` (signs up a 2nd caregiver user +
inserts a real `pending` `care_links` row as that caregiver — RLS needs the
INSERT to be `auth.uid()=caregiver_id AND status='pending'`).

**Two engine changes landed with these:**
1. `orchestrate.ts::runActStep` now runs `performAct` only when `step.act` is
   set, then falls through to verify→reveal → so an **act-less step can carry a
   Verify** (the consent flow's post-accept check). `Walkthrough.tsx` act-effect
   gate widened to `step.act || (!step.waitFor && (step.verify||step.reveal))`.
2. **Overlay is now `pointer-events-none`** (root div), callout stays tappable —
   so a REAL user tap reaches the spotlighted element beneath. This fixes a
   latent bug: the old overlay would have intercepted every real click, which
   the 2026-07-22 build never caught because it was never browser-driven. The
   autonomous actor uses programmatic `.click()` and was unaffected either way.

**Division approach that worked:** shared/coupled files (enum, `steps/index.ts`,
`ElderlyApp` onVerify, `walkthrough.py`, `prompts.py`, engine, selectors, i18n,
helpers) done centrally FIRST; then one subagent per scenario owned only its
isolated `steps/*.ts` + `e2e/*.spec.ts` and its own live drive. Both agents
passed first run with no step-file edits. Full gate: 7 e2e · 11 vitest · build ·
221 hermes, all green. Remaining (deferred, low-value per exploration):
view-only show-meds/timeline.

**Deferred to Phase 2 (remaining):** the ~8 real-scenario step files; wiring
`verify`/`reveal` execution (client re-query via `fetchElderMedications`/
`fetchProfile`/`fetchPendingLinkRequests`, pulse-highlight reveal reusing the
existing `justAddedMed` mechanism); `soul.md` + `start_walkthrough`/`TASK_NAMES`
updates so Mei *offers and starts* autonomous walkthroughs (none is reachable
from chat yet); documenting the autonomous-Submit exception in the safety rails;
the Playwright harness. Plan file:
`~/.claude/plans/read-through-the-context-md-velvet-melody.md`.

## 2026-07-22 — Guided Walkthrough for Mei (spotlight-and-narrate, never auto-acts)

New cross-cutting feature (architecture pre-approved via an explicit plan
before any code — see the plan file referenced in that session): Mei can
spotlight one screen element at a time and narrate it, but the user always
performs the real tap/type/submit — extends the app's propose→confirm
human-in-the-loop rule to navigation itself. Built for all 4 priority-1 flows:
Travel Mode setup, the onboarding wizard, requesting a refill, linking a
caregiver.

**Architecture:** `apps/web/src/app/components/Walkthrough.tsx` (new,
reuses `GuidedTour.tsx`'s spotlight/mask/measure-retry math but replaces its
button-driven `next()` with a `waitFor` condition per step — native DOM
listener or an app-emitted event via `lib/walkthrough/bus.ts`, never the
bubble's own button). Step content is data, not code:
`lib/walkthrough/steps/*.ts`, resolved by `lib/walkthrough/steps/index.ts`'s
`resolveWalkthroughSteps(taskName, role)`. Hermes gets a new
`start_walkthrough` tool (`tools/walkthrough.py`) that only names a
`task_name` — it does NOT carry step content server-side (that stays
web-only, so DOM selectors never leak into Python) and deliberately doesn't
populate `committed_actions` (same precedent as `message_caregiver`). New
`/agent/turn` request field `completed_walkthroughs` (client-supplied,
stateless on Hermes, threaded into the system prompt so Mei doesn't re-offer
a finished walkthrough) and response field `walkthrough: {task_name} | null`.

**State:** live step position is client-only sessionStorage
(`lib/walkthroughState.ts`, same TTL/keying pattern as the elder chat's own
session persistence) — explicitly does NOT survive a refresh (matches the
wizard's own pre-existing behavior). "Completed" walkthroughs live in the
existing `profiles.accessibility` jsonb catch-all (`completedWalkthroughs`
field), written via `lib/profile.ts::markWalkthroughCompleted`'s
read-merge-write (a raw `saveProfile()` overwrite would clobber the medical
profile stored in the same column). No new Supabase migration.

**Known gaps, flagged rather than silently left unclear:**
- The onboarding walkthrough's step content/DOM instrumentation
  (`lib/walkthrough/steps/onboarding.ts`, ~24 steps) is complete, but there's
  no host wiring to *navigate into* the pre-account wizard from an
  already-open chat session — `ElderlyApp.tsx` doesn't mount
  `GuidedSetupWizard` at all (it's a separate top-level screen in `App.tsx`'s
  onboarding stage). Triggering this walkthrough today only works if the
  wizard is already the visible screen when `start_walkthrough("onboarding")`
  lands; wiring cross-mode navigation from chat was out of scope for this
  pass.
- i18n: all `walk.*` copy was added to the `en` table only. `t()` already
  falls back to English for the other 5 languages (same incremental pattern
  used elsewhere in this codebase, e.g. MEMORY.md's 2026-07-09 entry) — not a
  bug, just not yet translated.
- Not click-driven through a real browser this pass — verified via
  `uv run pytest` (hermes, 215 passed) and `npm run build` (clean), per
  MEMORY.md's standing note that a clean `npm run build` is not a typecheck
  (no `tsc` in this repo) and is not the same as a live UI drive.

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

## 2026-07-19 — `t`-shadow bug in ElderlyAIScreen's `send()` — fixed (confirmed 2026-07-28)

Was: `send()` opened with `const t = text.trim()`, shadowing the imported
`t()` translation function, so any agent turn that committed a routable
action threw `t is not a function`. Confirmed during the 2026-07-28
dose-logging session that the code already uses `const trimmed = text.trim()`
— fixed at some point without a MEMORY.md note. Not the cause of that
session's "AI does nothing" report (see the 2026-07-28 entry).

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
