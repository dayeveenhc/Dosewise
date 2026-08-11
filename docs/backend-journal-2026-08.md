# Backend Changes Journal — since 2026-07-30

Documentation record of the major backend changes landed since 2026-07-30,
built from git commit history plus `MEMORY.md`'s dated entries for context.
Compiled 2026-08-11.

**Scope — "backend" here means:**
- `services/hermes/` — the FastAPI orchestrator (agent loop, tools, API
  routes). This is the security boundary: the only thing holding the
  LLM/OpenFDA/HuggingFace/Supabase service-role keys.
- `supabase/` — schema, migrations, RLS policies.

`apps/web/src/app/lib/hermes.ts` is the *client* that calls Hermes, not the
backend itself, and is excluded. Frontend-only work (UI screens, walkthrough
pacing, styling) is out of scope even when large.

**Not covered here:** the 2026-07-12 security-verification passes
(`docs/security-verification-2026-07-12.md`,
`docs/security-verification-round2-2026-07-12.md`) predate this window —
mentioned for context only.

**A note on dates:** this repo tends to bundle several days of work into one
commit (e.g. a single commit's message spans four unrelated features). Where
`MEMORY.md` records a change as *done* on one date but it only *lands* in a
commit dated later, this journal uses the **commit date** as the entry date
and calls out the MEMORY date separately. Several 2026-08-04 MEMORY entries
(walkthrough Confirm/Submit split, IdleTimeout, TrustMode) are pure frontend
(`apps/web/lib/walkthrough/*`) and don't appear below for that reason.

---

## 2026-08-02 — `1c81fe2`: 8-defect fix pass, plus 3 backend hardening items

Commit: `1c81fe2` — "Fix 8 reported defects; land the pending
walkthrough-engine pass" (105 files changed, mixed frontend/backend).
Context from `MEMORY.md`'s same-day "8 reported defects, 6 root causes"
and "Full end-to-end verification" entries.

**New tools:**
- `services/hermes/src/hermes/tools/caregiver.py` — new read-only
  `list_caregivers` tool over the `care_links` table. Fixed a real data
  leak: emergency-contact info was falling back to stale fixture data on
  real accounts because no `phone` column existed and a client-side
  `...prev[0]` spread was silently reusing the wrong record.
- `services/hermes/src/hermes/tools/choices.py` (new, +78 lines) — role-
  filters which walkthrough/tool choices are offered, so an elder account
  can no longer be routed into a caregiver-only walkthrough; refusals now
  return a reason string to both chat UIs (web + Telegram).
- `services/hermes/src/hermes/tools/refills.py` (new, +82 lines) —
  refill-request tool.

**Fixes:**
- `agent/prompts.py` / `soul.md` — the "already shown" walkthrough rail
  only ever told the model what was *undone*; added the mirror instruction
  ("Walkthroughs already shown: … DO NOT offer to show/guide/walk them
  through it again") so a completed tour stops being re-offered as generic
  filler.
- System prompt never stated today's date, so relative-date phrases
  ("next Monday") could resolve against a stale year — fixed.
- `tools/base.py` — `session.awaiting_confirmation` is now surfaced
  consistently on both channels (Telegram already had it; web didn't),
  reset per turn.
- `tools/medications.py::update_medication_dosage` — the confirm branch
  used to do `dosage = dosage or pending.get("dosage")`, so a
  `confirmed=true` carrying a *different* dose than was proposed and read
  back would silently save it, skipping the dosage-jump safety warning
  entirely. Now refuses and re-asks unless the confirmed dose matches the
  proposed one.
- `agent/loop.py::_dispatch_tool`'s `committed` field — the signal both
  chat screens gate navigation on — had zero test coverage (the stream
  route's fake `run_agent_turn` bypasses it entirely); added a direct unit
  test.
- Minor hygiene: `offer_choices` no longer claims to have "attached N
  tappable buttons" on Telegram, where none render; `request_refill` skips
  inserting a duplicate `doctor_questions` row when an open one already
  exists for the same medication.

---

## 2026-08-08 — `21681aa`: fixed-course prescriptions + 4 new tool/agent modules

Commit: `21681aa` — "Course durations, urgent alerts, iOS status bar, and a
walkthrough geometry sweep" (159 files changed, large hermes footprint).

- **Fixed-course prescriptions**: `end_date` is stored inside the existing
  `medications.schedule` jsonb column — no migration required.
  `services/hermes/src/hermes/dosing.py::scheduled_today` and the
  frontend's `isDueOn` now implement the identical inclusive end-date rule
  so the reminder scheduler and the app agree on when a course has ended.
  Also fixed an `interval_days` bug where every-other-day medications were
  reminded daily and reported as missed on their off days.
- **New `tools/alerts.py`** (+108 lines) — lets Mei raise an urgent alert
  herself; the tool's *return value* is a dedup verdict the model consumes,
  rather than the alert being a pure side effect.
- **New `tools/risk.py`** (+201 lines) — risk-classification tool.
- **New `agent/answers.py`** (+233 lines) — structured answer/button
  support for agent turns.
- **New `agent/tts.py`** (+78 lines) — text-to-speech support added to the
  agent/API layer.
- **New `config.py` surface** (+44 lines) supporting the above.
- `api/routes.py` — new endpoints wiring alerts/voice/answers into the API.
- Supporting changes in `tools/medications.py`, `tools/choices.py`,
  `tools/walkthrough.py`, `agent/loop.py`, `agent/prompts.py`, `soul.md`,
  `tools/base.py` for course durations, alert integration, and the
  confirmation flow.

---

## 2026-08-11 — Prescription-label photo scanning, multi-image agent turns

Committed today as part of this documentation pass (not part of the
2026-07-30–08-08 commit-history sweep above — landed same-day as this
journal).

- `services/hermes/src/hermes/agent/extract.py` — refactored around a
  shared `_run_extraction()` helper; adds a **separate** prescription-label
  extraction path (`record_prescription` schema: `name, dose, purpose,
  times, duration_days, instructions` from a photo of a med label/box),
  deliberately kept apart from the existing profile-photo extractor's
  schema (written for clinic-record fields).
- `services/hermes/src/hermes/api/routes.py` — new `prescription_extract`
  POST endpoint.
- `services/hermes/src/hermes/agent/loop.py` — `run_agent_turn` extended
  to accept `images: list[bytes] | None`, in addition to the existing
  single `image_bytes` param, so the web composer can send several photos
  in one turn.
- `services/hermes/src/hermes/agent/soul.md` — prompt updates: dose can now
  be "as directed" when unknown (never guess a numeric dose); `times` is
  now passed to `add_prescription_auto` as a single comma-separated string,
  not a list (which would otherwise arrive as literal text).
- `services/hermes/src/hermes/tools/walkthrough.py` — schema doc update to
  match the comma-separated `times` convention above.
- Matching frontend: camera/photo-source UI, an add-refill sheet, a new
  elderly medication-detail screen.

---

## Infrastructure note (not a code change, but operationally relevant)

**2026-08-02 — `dfa2f71`**: root-caused the port-8000 restart storm
(~37,900 accumulated Hermes restarts). The real cause was `watch-and-pull.sh`
comparing HEAD against `origin/main` on a VPS checked out on a feature
branch — a false positive on "new commit available" every ~15 seconds — not
the previously-suspected orphaned `--multiprocessing-fork` child. Documented
in `MEMORY.md`; no code fix included in this commit.

---

## `supabase/` — no changes in this window

Zero commits touched `supabase/` between 2026-07-30 and 2026-08-11 — no
schema changes, migrations, or RLS policy updates. The last schema activity
predates this window (migration `0005`, the `care_links` consent-state fix
covered in the 2026-07-12 security-verification docs).
