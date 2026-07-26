# Dosewise Scenario Catalog — 2026-07-26

**REVIEW document.** Complete inventory of chat-actionable scenarios: built, gap, or dead end —
with what each open item needs on the new bulk-action contract. Nothing here authorizes a build.
Companion to `docs/change-highlight-gap-analysis-2026-07-25.md` (the single-entity deep dive,
incorporated by reference in §2b).

## 1. Status legend + summary

| Tag | Meaning |
|---|---|
| **BUILT** | Live-verified end-to-end (real turn or dev-hook UI proof + independent DB re-read) |
| **GAP** | Feature request with no (or partial) backend/chat path — sized and specced below |
| **DEAD END** | Frontend action exists but chat cannot perform it (or vice versa) — recommendation given |
| **BROKEN SURFACE** | Tool commits but the highlight/proof layer has nowhere to land |
| **[KNOWN]** | Pre-dated this discovery pass (original 10 scenarios, 2026-07-25 gap analysis, MEMORY) |
| **[NEW]** | Surfaced by this discovery/debug pass (2026-07-25/26) |

**Counts:** 8 built scenarios (7 single-entity + 1 bulk) · 8 deferred single-entity gaps [KNOWN] ·
11 bulk gaps (c2–c11, c12 folds into c3) [NEW] · 15 dead ends [mostly NEW] · 8 broken highlight
surfaces [NEW] · 7 defects/hazards [mostly NEW].

**Infrastructure baseline (this pass, verified GREEN) [NEW]:** generic bulk action contract
`record_bulk_action` (`tools/base.py:99`) → `{tool, summary, entities:[{entity_type, entity_id,
changed_fields, …}]}`; `resolve_missed_doses` tool (`tools/doses.py:177`, propose→confirm with
list-shaped `pending_missed_doses` slot — `channels/session.py:53`); bulk ChangeHighlight
(simultaneous rings + one batch caption). **18 tools** (`tools/__init__.py:1`).

---

## 2. Single-entity scenarios

### 2a. Built (proof pointers)

| Scenario | Path | Proof | Tag |
|---|---|---|---|
| Add Medicine | `add_prescription` propose → `add_prescription_auto` walkthrough hybrid (elder: animated → Home reveal; caregiver/verify-fail: direct save). MEMORY 2026-07-24. | `e2e/add-prescription-auto.spec.ts`, live DB re-read | **BUILT [KNOWN]** |
| Add Condition | `add_condition_auto` walkthrough → structured `conditions[]` (not the blob). MEMORY 2026-07-23. | `e2e/add-condition-auto.spec.ts` | **BUILT [KNOWN]** |
| Dose taken | `log_dose` → `entity_id`=med id → Home card ring + "Taken: Metformin". | `e2e/scenario1-dose-taken.spec.ts` + live turn | **BUILT [KNOWN]** |
| Dosage update | `update_medication_dosage` (propose→confirm, `pending_dosage`) → Prescriptions card, "Updated: 500mg → 1000mg". | `e2e/scenario6-dosage-update.spec.ts` + live turn | **BUILT [KNOWN]** |
| Travel mode setup | `travel_mode_auto` walkthrough (client write). | `e2e/travel-mode-auto.spec.ts` | **BUILT [KNOWN]** |
| Edit profile field | `edit_profile_auto` walkthrough incl. write-fail path. | `e2e/edit-profile-auto.spec.ts` | **BUILT [KNOWN]** |
| Accept caregiver link | `accept_caregiver_link` — Mei navigates, elder taps Accept (consent). | `e2e/accept-caregiver-link.spec.ts` | **BUILT [KNOWN]** |
| Tick all missed doses (=c1) | `resolve_missed_doses` → bulk highlight. §3 c1. | LLM routing 4/4; bulk rings live-green | **BUILT [NEW]** |

### 2b. Planned-deferred — all **[KNOWN]**, full spec in `docs/change-highlight-gap-analysis-2026-07-25.md`

| # | Scenario | One-line status | Size |
|---|---|---|---|
| #2 | Skip dose + reason | `log_dose` has no skip path/reason column; reuse `message_caregiver` for the alert (decision recorded), don't add `caregiver_alerts` table | L |
| #3 | Symptom report tied to a med | No table, tool, or review screen anywhere — full greenfield | L |
| #4 | Interaction flag record | Recommendation stands: keep conversational, do NOT persist a what-if | M–L |
| #5 | Discontinue med | `medications.archived` exists, no tool sets it; needs distinct non-emerald "Stopped" treatment (see also §3 c3) | M |
| #7 | Vitals reading | No table/type/screen — full greenfield | L |
| #8 | Snooze one dose | No per-dose `reminder_at`; `set_medication_reminder` edits the recurring schedule (see also §3 c2) | M |
| #9 | Caregiver marks dose given | Blocked on dose-level DOM target + caregiver ChangeHighlight mount (§5) | L |
| #10 | Allergy severity | Allergies are `string[]`, no id/severity — data-model promotion ripples | M |

---

## 3. Bulk scenarios (the priority — every inherently-multi-entity feature)

The bulk contract (`record_bulk_action` + list-shaped pending slot + bulk ChangeHighlight) is the
platform; each row states which pieces it still needs. `pending_missed_doses`
(`channels/session.py:53`) is the existing list-shaped-slot precedent to copy.

| # | User says | What exists today | Needs on the bulk contract | Size | Tag |
|---|---|---|---|---|---|
| c1 | "I missed my morning meds, tick them all" | **BUILT this pass**: `resolve_missed_doses` (`tools/doses.py:177`) — server-side missed-set resolution, propose→confirm, back-dated writes, bulk highlight; soul rail `soul.md:181` → 4/4 LLM routing | — (done) | — | **BUILT [NEW]** |
| c2 | "Move all my reminders an hour later" / "snooze everything" | `set_medication_reminder` (`tools/medications.py:337`) is single-med and REPLACES the schedule; single `pending_reminder` slot clobbers on a second proposal | New `shift_reminders`-style bulk tool + a **list-shaped pending slot** (the next architectural step; copy `pending_missed_doses`) + `record_bulk_action` emit | **M** | GAP [NEW] |
| c3 | "Stop these three meds" (+ c12 caregiver group-delete) | NO archive/discontinue tool at all; UI group-delete exists caregiver-side only (`PatientScreen.tsx:130` — `m.ids.forEach(onDeleteMedication)`) | Single `discontinue_medication` first (gap #5), then a list-accepting variant + list pending slot + bulk highlight with non-emerald "Stopped" styling | **M** (single) + **S** (bulk on top) | GAP [NEW] (single-med half [KNOWN] as #5) |
| c4 | "Refill everything that's low" | `check_refills` (`tools/refills.py:60`) already computes the low set — but prose-only; `log_refill` (`tools/refills.py:95`) is single-med, writes immediately | Nearly free: mirror c1's shape — server resolves the low set, propose→confirm, loop `log_refill` logic, one `record_bulk_action` | **S** | GAP [NEW] |
| c5 | "Mark all notifications read" | Elder Notifications is a local mock — no table, no backend | New table + RLS + tool + real fetch; only worth it if notifications become real (ties to a9) | **L** | GAP [NEW] |
| c6 | Photo/PDF of a med list → "add them all" | Chat scan path is single `pending_proposal` + `pending_image`; **`/profile/extract` ALREADY returns `current_meds[]` arrays** (`agent/extract.py:67`) — the parser exists | Reuse extract's array parse in the agent path + list-shaped proposal slot + loop `add_prescription` commit logic + bulk highlight | **M** | GAP [NEW] |
| c7 | Onboarding bulk med intake via chat | Wizard bypasses Hermes entirely (client-side); chat intake costs N propose/confirm round-trips | Rides c6's list-shaped proposal (one confirm for the whole list); otherwise leave to the wizard | **S** after c6 | GAP [NEW] |
| c8 | "Make me a packing list for my trip" | Client-only computation in the travel sheet; no tool emits anything | A read-only compute tool (no writes → no bulk contract needed), or explicitly leave client-side | **S** / out-of-scope | GAP [NEW] |
| c9 | "How did I do this week?" (adherence summary) | `show_schedule` week-view approximates; caregiver weekly-summary sheet is 100% mock | Read-only aggregation tool over `doses`; caregiver surface blocked on §5 caregiver infra | **M** | GAP [NEW] |
| c10 | "Check ALL my meds against each other" | `check_drug_interactions` drug_b-omitted mode is one-vs-all (`tools/interactions.py:21`); no all-pairs sweep | Read-only loop over pairs inside the existing tool (no writes, no pending slot) — cheap | **S** | GAP [NEW] |
| c11 | "Close out my doctor questions" | No status tool; UI answered-state is local-only **and has a revert bug** — `refreshDoctorQuestions` overwrites local answered with DB still-open | Add `status` handling tool + fix the merge to respect local answered; bulk = list slot on top | **M** | GAP [NEW] |
| c12 | Caregiver group-delete meds | UI bulk exists, no chat equivalent | **Folded into c3** | — | GAP [NEW] |

### Recommended priority order

1. **c4 refill-all — first.** Nearly free: `check_refills` already computes the set; c1's exact
   propose→confirm/back-write/bulk-highlight shape transplants directly. Highest demo value per line.
2. **c10 all-pairs interactions.** Read-only, no pending slot, strong safety-story demo.
3. **c2 reminder shift.** Forces the **list-shaped pending slot** design — the next architectural
   step every remaining bulk write (c3, c6, c7, c11) then reuses.
4. **c3 discontinue-several** (do single `discontinue_medication` first — it's also gap #5).
5. **c6 multi-med scan → c7 chat intake.** Biggest wow; unblocked once the list slot exists, and
   `/profile/extract`'s `current_meds[]` parser is a direct reuse.
6. **c11 doctor-question closeout** (fix the revert bug regardless — it's a defect, §5).
7. **c9 adherence summary** (elder-side read first; caregiver blocked on §5 infra).
8. **c5 / c8** last — c5 needs a whole notifications backend; c8 is fine client-side.

---

## 4. Dead ends (frontend action ↔ chat mismatch) — recommendation per item

| # | Surface | Situation | Recommendation | Tag |
|---|---|---|---|---|
| a1 | Delete/discontinue med via chat | UNGRACEFUL — no tool, soul.md silent, model may misroute (e.g. toward add/update) | Build `discontinue_medication` (= gap #5 / c3) + a soul rail so "remove X" routes safely NOW even before the tool ("I can't remove meds yet — ask your caregiver") | [NEW] |
| a2 | Edit med in UI | Inverse gap: `update_medication_dosage` exists chat-only; no edit affordance on med cards | Wire a UI edit sheet to the same write path — small, closes an asymmetry users will hit | [NEW] |
| a3 | Caregiver "send reminder" | Local mock; **worse: caregiver chat acts on the caregiver's OWN data** — `routes.py:77` derives elder_id from JWT sub, no act-on-behalf-of | Design decision required (act-on-behalf-of = consent + RLS surface, scope like a feature); until then add a soul/UX guard so Ask-Mei doesn't silently edit the caregiver's own empty profile | [NEW] |
| a4 | Care-team management | Mock | Out-of-scope until care-team is a real table | [NEW] |
| a5 | Emergency contacts | Mock; consent-excluded from autonomous walkthroughs (MEMORY 2026-07-23) | Out-of-scope; keep consent exclusion when built | [KNOWN exclusion, NEW dead-end audit] |
| a6 | Travel mode from Telegram | No tool emits `travel_plan`; walkthrough is web-only → Telegram dead end | Either a direct `set_travel_plan` tool (both channels benefit) or explicit "web-app only" reply in soul.md | [NEW] |
| a7 | Doctor-question mark-answered/delete | No status tool + the c11 revert bug | Same fix as c11; the revert bug is a defect to fix regardless | [NEW] |
| a8 | Care-link accept/decline via chat | **DELIBERATELY human-only** — consent must be the elder's own tap (CONTEXT.md safety rails; `accept_caregiver_link` walkthrough navigates only) | **Intentional — keep.** Document in soul.md so Mei explains rather than fails | [KNOWN] |
| a9 | Notification dismiss / "order refill" button | No table/backend | Out-of-scope until c5's backend exists | [NEW] |
| a10 | Weekly summary (caregiver) | 100% mock | Fold into c9 | [NEW] |
| a11–a12 | Language/voice/accessibility via chat | Client-only settings — but **graceful** (in-chat "Language & voice" switch exists) | No action; already acceptable | [KNOWN] |
| a13 | Structured profile fields vs free-text blob | `update_medical_profile` writes `accessibility.medical_profile` which the UI never renders — a Telegram "update my profile" ask is **silently ineffective** | Either render the blob in Settings or route the tool to structured fields; pick one — the split is the root of the b-item `profile_field` too | [KNOWN root (MEMORY 2026-07-23), NEW Telegram-ineffective finding] |
| a14 | Caregiver add-patient manually | Mock (QR path is the real one) | Out-of-scope; QR is the supported path | [KNOWN] |
| a15 | Caregiver Messages thread | Caregiver web never fetches/displays `conversation_turns` — `message_caregiver` writes into a one-way black hole | Wire a real fetch (table + RLS already exist) — cheap and it un-breaks the b-item `caregiver_message` surface too | [NEW] |

---

## 5. Broken highlight surfaces (b-items) + defects & hazards

### Broken/missing highlight surfaces — all **[NEW]** except where noted

| Surface | Problem | Anchor |
|---|---|---|
| `profile_field` | ENTITY_TARGETS maps it (`changeHighlight.ts:20`) but no testid exists anywhere and Settings never renders the blob (a13) | `lib/changeHighlight.ts:20` |
| `caregiver_message` | Elder Notifications renders mock, no fetch → nothing to ring (see a15 for the caregiver side) | `changeHighlight.ts:23` |
| `escalation` | `fetchDoctorQuestions` deliberately filters OUT `[ESCALATION]` rows → committed escalations unhighlightable | `lib/doctor.ts` filter ([KNOWN filter], NEW implication) |
| `caregiver_invite`, `travel_plan` | ENTITY_TARGETS mappings with **no emitter** — no tool ever produces these entity_types | `changeHighlight.ts:21,24` |
| Caregiver mode entirely | `<ChangeHighlight>` mounted only in `ElderlyApp`; caregiver shell has zero testids and no mount | [KNOWN — gap-analysis structural fact #2] |
| `update_medication_dosage` in caregiver chat | Absent from `ACTION_TARGETS` (`agentActions.ts:16-22`) → commits with **zero feedback** in AskMei | `lib/agentActions.ts:16` |
| `show_instruction_video` | Returns a path nothing plays | `tools/videos.py` |

### Defects & hazards

| Defect | Detail | Tag |
|---|---|---|
| `find_medications` exact-match | Wildcard-less `ilike.{name}` (`tools/base.py:144`) = case-insensitive **exact** match — LLM label-echo ("Metformin 500mg") yields false "not found". New soul bare-name rule partially mitigates; the ilike behavior itself is unchanged (consider `%…%` or normalize) | [NEW] |
| `actions[]` order nondeterministic | Built from `asyncio.gather` completion order (`agent/loop.py:258,335,441`) — frontend `firstRoutableAction`/`firstHighlightable` may pick differently across identical turns | [NEW] |
| Telegram declined-proposal leak | `_clear_pending` (`channels/telegram.py:253-257`) clears only `pending_proposal`/`pending_reminder` — **not** `pending_dosage`/`pending_missed_doses`; a declined dosage change stays committable by a later "yes"; tap-confirm same gap | [NEW] |
| `start_walkthrough` double-queue | Second call silently drops the first yet reports success for both | [NEW] |
| `_MAX_ITERATIONS=8` exhaustion | (`agent/loop.py:30`) → generic retry message with no partial-success report even if some tools committed | [NEW] |
| ChangeHighlight first-poll latch | Latches pre-navigation elements when fired from a tab already showing matching testids (latent, pre-existing) | [NEW] |
| LLM tool-routing variance | `log_dose` fires ~1/3 of real turns vs `resolve_missed_doses` 4/4 — **soul-rail specificity is the lever**; confirm-guard correctly refuses on skipped propose (no false writes). Prompt tuning, not code defect | [KNOWN baseline (MEMORY 2026-07-25), NEW 4/4 comparison] |

---

## 6. Reading guide

- Greenlighting any **bulk** item: start at §3's priority order — c4 first, c2 to establish the
  list-shaped pending slot, then the rest are incremental.
- Greenlighting any **single-entity** gap: `docs/change-highlight-gap-analysis-2026-07-25.md`
  has the full per-item spec and its own sequencing (that sequencing still holds).
- The **defects table** (§5) is buildable-now hygiene independent of any scenario decision;
  the Telegram declined-proposal leak and the c11 revert bug are the two with user-visible
  wrong behavior today.
