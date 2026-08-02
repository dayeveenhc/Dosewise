# ChangeHighlight scenarios — gap analysis (2026-07-25)

Scope decision from the 2026-07-25 pass: of the 10 requested "highlight the change"
scenarios, **only #1 (dose taken) and #6 (dosage update) were buildable** without new
tables — both shipped and live-verified. The other **8 are greenfield gaps**: they need new
Supabase tables + RLS, new Hermes tools, and/or new frontend data models/screens. This
document records exactly what each needs so the cost is decision-ready. **Nothing here is
built.** ChangeHighlight correctly loud-logs (never fabricates an entity_id) for all of them
today.

## Why these are gaps — the three structural facts

1. **No dose-level DOM target.** The elder Home timeline and caregiver TimelineScreen render
   *medications*, not dose rows; `doses` rows are never rendered with a `dose-{id}` testid.
   (Scenario 1 worked only because we routed its `entity_id` to the **medication** card, à la
   `log_refill`.) Anything keyed on an individual dose occurrence (skip, snooze, caregiver-
   marks-given) has nothing to ring.
2. **The caregiver app never mounts `ChangeHighlight`.** `<ChangeHighlight>` is mounted once,
   in `ElderlyApp.tsx` (elderly mode only). `AskMeiScreen` does old-style `ACTION_TARGETS`
   navigation with no ring/caption. Any caregiver-side highlight needs that infrastructure
   first.
3. **Whole data domains don't exist.** No `symptom_reports`, `vitals`, `interaction_flags`,
   `caregiver_alerts`, or `schedule_entries` table (only 10 tables exist, all from
   `0001_init_schema.sql`); allergies are `string[]` with no severity and no per-entry id.

Size key: **M** = new tool + small frontend on existing infra; **L** = new table + RLS
migration + tool + new/changed screen (and possibly caregiver ChangeHighlight infra).

---

## Per-scenario

### #2 — Skip a dose with a reason ("skipping my evening dose, I feel nauseous") — **L**
- **Backend:** `log_dose` today only ever writes `status="taken"` (no skip path) and stores no
  reason. Need a skip path writing `doses.status="skipped"` + a reason (the `doses` table has
  no reason column → add one, small migration) and a committed action mirroring #1's
  med-id-as-entity_id trick.
- **Frontend:** the Home timeline has no "skipped" rendering for a real dose; add a skipped
  state + a dose/med testid (same gap as #1's taken-card, already partly solved).
- **Decision asked — does this also need a `caregiver_alert` entity?** **Recommendation: do
  NOT add a new `caregiver_alerts` table.** A skipped-with-symptom dose is exactly the kind of
  thing `message_caregiver` already models (it writes a `system` row to `conversation_turns`
  and emits `entity_type="caregiver_message"`). Reuse that: on a skip-with-reason, also call
  the caregiver-notify path so the caregiver sees it in their messages. A dedicated
  `caregiver_alert` entity/table is only worth it if the caregiver dashboard grows a real
  first-class "alerts" surface — which doesn't exist yet, so it would be speculative. If built,
  Subagent 2-B would wire **both** highlights (the elder's skipped dose + the caregiver
  message), and the caregiver-side one is blocked on structural fact #2 above.

### #3 — Side effect / symptom tied to a medication ("dizzy after my BP pill") — **L**
- **Decision asked — does a symptom-review screen exist? NO.** There is zero symptom/side-
  effect UI, type, or store anywhere, and no medication *detail* screen to hang it on
  (prescription cards don't expand to a route).
- **Needs:** a new `symptom_reports` table (+ RLS as the elder, caregiver-readable), a new
  Hermes tool (`report_symptom(medication_name, symptom, …)`), and a review surface — either a
  new symptom list screen or a med-detail screen with a symptoms section — before there is any
  element to ring. Per the original spec, this is a genuine gap; building the screen as a side
  effect was explicitly out of scope.

### #4 — Proactive interaction flag ("can I take Panadol with what I'm on") — **M–L**
- **Decision asked — should this write a permanent record? Recommendation: NO (for now).**
  Interactions are read-only today: `check_drug_interactions` / the OpenFDA-grounded warning
  path answer in-conversation and persist nothing. That is the safer default — a *proactive
  what-if* about a drug the elder is merely *considering* isn't a committed change to their
  regimen, and recording it risks implying a clinical determination. Keep it conversational.
- **If the user does want a record:** new `interaction_flags` table + RLS + a tool, and a
  screen listing flagged interactions; Subagent 4-B would highlight **both** medications
  involved (needs both `medication-{uuid}` cards on one screen — the prescription list already
  renders all cards, so the ring/caption could target two). Size jumps to L with the table.

### #5 — Discontinue a medication (status "Discontinued", not deleted) — **M**
- **Backend:** the `medications.archived` boolean exists but **no tool ever sets it**. Add a
  `discontinue_medication` tool (propose→confirm) setting `archived=true` (+ maybe a
  `discontinued_at`), emitting `entity_type="medication"` with `changed_fields.status`.
- **Frontend:** the med card shows no status badge; add a **visually distinct** "Stopped"
  treatment — explicitly NOT the emerald "good news" highlight. The plan/spec calls for a
  different color/icon (e.g. a muted/gray or amber "Discontinued" badge + a neutral ring
  variant). `describeChange` would need a "Stopped:" verb like Scenario 1's "Taken:".
- No new table; medications already supports it. The distinct-treatment requirement is the
  main frontend work.

### #7 — Log a vitals reading ("BP 130 over 85") — **L**
- **Decision asked — does a vitals store/screen exist? NO.** No vitals type on `Patient`, no
  readings store, no screen. "Blood Pressure"/"Heart Rate" appear only as medication *purpose*
  labels. The caregiver PDF-upload path feeds `extractProfile` → conditions/allergies/meds
  only; it does **not** surface vitals either.
- **Needs:** a new `vitals` table (+ RLS), a tool (`log_vitals(type, value, …)`), and a vitals/
  health-readings screen. Full greenfield; building the screen as a side effect was out of
  scope per the spec.

### #8 — Snooze a single dose reminder for today ("remind me in 30 minutes") — **M**
- **Backend:** no per-dose `reminder_at` concept exists — `set_medication_reminder` edits the
  *recurring* `medications.schedule` jsonb, which is a permanent change, not a one-off snooze.
  Need a one-time snooze store (a `reminder_at` on the relevant `doses` row, or a small snoozes
  table) + a tool, taking care its `changed_fields` shows the **temporary** reminder time, not
  the recurring schedule.
- **Frontend:** timeline needs a per-dose target (structural fact #1) and Subagent 8-B's
  caption must read as a one-time snooze ("Reminder snoozed to 6:30 PM today"), clearly
  distinct from a permanent schedule edit.

### #9 — Caregiver marks a dose given on the elder's behalf ("I gave mom her meds") — **L**
- **Backend:** same `doses` write as #1 but authored by the caregiver (RLS must allow a linked
  caregiver to write the elder's dose — check `care_links` active-link policy).
- **Frontend:** blocked on structural facts **#1 and #2** — the caregiver `TimelineScreen` has
  no dose-level testid and the caregiver app mounts no `ChangeHighlight`. Needs the caregiver-
  side highlight infrastructure built first, plus a "mark given" affordance.

### #10 — Update an allergy's severity ("penicillin allergy is severe, not mild") — **M**
- **Data model:** allergies are `string[]` (`Patient.allergies`) — no severity field, no per-
  entry id, rendered with `key={i}` and no testid. Need to promote allergies to objects
  (`{id, name, severity}`) across the profile model, settings UI, and caregiver view, a tool to
  update a single allergy's severity, and per-entry `data-testid` so the highlight rings the
  **specific** allergy entry, not the whole allergies section. The data-model change ripples
  through several files, which is what makes it M rather than trivial.

---

## Recommended sequencing if the user greenlights any

1. **Cheapest, highest-demo-value first:** #5 (discontinue) and #10 (allergy severity) — both
   ride existing tables/models with a bounded frontend change.
2. **Dose-occurrence family** (#2 skip, #8 snooze, #9 caregiver-given): do the shared
   prerequisites once — a dose-level DOM target and (for #9) caregiver-side `ChangeHighlight` —
   then the three are incremental.
3. **New domains** (#3 symptoms, #7 vitals, #4-with-record interactions): each is a full
   table + RLS + tool + screen; scope like a normal feature, not a highlight-wiring task.
