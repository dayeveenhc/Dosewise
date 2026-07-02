# Dosewise — Architecture

Dosewise is an **agent-first** medication app for elderly patients and their caregivers. The elder talks to an AI agent (**Hermes**) in their own dialect; Hermes operates the app on the elder's behalf through a constrained tool belt. Caregivers use a fuller control interface. The design rests on three pillars: **understanding** (grounded, plain-language, dialect), the **caregiver dyad** as the retention engine, and **safety-by-design** (human-in-the-loop, grounded facts, escalation logging, an RLS consent model).

## Hybrid architecture

The system is a hybrid: a thin client, a managed data platform (Supabase), and an external Python orchestrator (Hermes) that acts as the security boundary between the client and all external AI/data providers.

```
                         ┌──────────────────────────────────────┐
                         │            CLIENT (Expo RN)           │
                         │  Elder voice-first view · Caregiver   │
                         │           control view               │
                         └──────────────┬───────────┬───────────┘
                                        │           │
              Supabase JWT (RLS-scoped) │           │ Supabase JWT
              direct data reads/writes  │           │ (agent turns)
                                        ▼           ▼
                       ┌────────────────────┐   ┌────────────────────────────┐
                       │      SUPABASE      │   │      HERMES (VPS)          │
                       │  Postgres + RLS    │◄──┤  Python 3.12 + FastAPI     │
                       │  Auth · Storage    │   │  SECURITY BOUNDARY         │
                       │  Realtime          │   │  · verifies JWT            │
                       │                    │   │  · calls Supabase AS USER  │
                       │  (consent model)   │   │    (forwards JWT → RLS)    │
                       └────────────────────┘   │  · service role: cron +    │
                                 ▲               │    privileged writes only  │
                                 │               │  · runs Claude tool loop   │
                                 │               │  · enforces safety rails   │
                                 │               └───────┬───────────┬────────┘
                                 │                       │           │
                                 │                       ▼           ▼
                                 │            ┌──────────────┐  ┌──────────────┐
                                 │            │  CLAUDE      │  │  OpenFDA     │
                                 │            │  Sonnet 5    │  │  (grounded   │
                                 │            │  (anthropic  │  │   drug facts,│
                                 │            │   SDK)       │  │   cached)    │
                                 │            └──────────────┘  └──────┬───────┘
                                 │                                     │
                                 └─────────── drug_cache write ────────┘
                                              (HuggingFace STT/TTS — voice stretch)
                                              (Expo Push — VPS scheduler drives)
```

## Components

| Component | Technology | Responsibility |
| --- | --- | --- |
| Client | Expo + React Native | Elder voice-first view + caregiver control view; onboarding fork. Talks to Supabase directly (RLS-scoped) and to Hermes for agent turns. |
| Data platform | Supabase — Postgres + RLS, Auth, Storage, Realtime | System of record. **RLS is the consent model.** Auth issues the JWTs that gate everything. |
| Orchestrator | Hermes — Python 3.12 + FastAPI on a private VPS | The security boundary. Holds all external API keys, verifies JWTs, runs the Claude tool-calling loop, enforces safety rails. |
| AI brain | Claude Sonnet 5 (`claude-sonnet-5`) via `anthropic` Python SDK | Vision (prescription scans), tool-calling, adaptive thinking. |
| Drug knowledge | OpenFDA | Grounded, authoritative drug facts; cached in Postgres (`drug_cache`). |
| Speech / dialect | HuggingFace Inference API | STT / translate / TTS. **Stretch goal** — the competition demo is text-first. |
| Push | Expo Push | Reminders and caregiver alerts, driven by the VPS scheduler. |

**Deployment note:** Hermes runs on a private VPS. Recommended: Render or Railway for simplicity, or a Hetzner / DigitalOcean droplet for full control.

## RLS preserved with an external orchestrator

The central architectural challenge: keep Postgres RLS as the single source of truth for consent **even though** an external orchestrator sits between the client and the data. Dosewise solves this by never letting the client call Claude, OpenFDA, or HuggingFace directly, and by having Hermes act **as the user**:

1. The app authenticates with **Supabase Auth** and holds the user's JWT.
2. Every request to the Hermes VPS carries that **Supabase JWT**.
3. Hermes **verifies** the JWT, then calls Supabase **as the user** by forwarding the JWT — so **RLS applies exactly as if the user queried directly**. A caregiver only ever sees what their `care_links` consent grants; a patient only sees their own rows.
4. The **service-role key** (which bypasses RLS) is used **only** for cron jobs and privileged writes **after** human confirmation — never on the interactive read path.

This keeps the consent model enforced in one place (the database) while still allowing a trusted server to hold secrets and run the agent loop.

## Data model (Supabase)

Defined and owned by the Supabase backend pass. Referenced here, not redefined:

- `profiles` — user accounts (patients and caregivers).
- `care_links` — the **consent anchor** linking a caregiver to a patient.
- `medications` — a patient's medication list.
- `doses` — logged doses / adherence records.
- `refills` — refill tracking.
- `doctor_questions` — questions queued for the patient's doctor.
- `conversation_turns` — agent conversation history.
- `dialect_lexicon` — dialect terms and mappings.
- `drug_cache` — cached OpenFDA facts.
- `instruction_videos` — how-to / instruction media references.

## Hermes tool belt (the agent contract)

The constrained set of actions Hermes can take on the user's behalf (deferred to the agent pass):

| Tool | Purpose |
| --- | --- |
| `log_dose()` | Record that a dose was taken. |
| `list_medications()` | Retrieve the patient's medications. |
| `get_drug_info()` | Fetch grounded drug facts (OpenFDA, cached). |
| `add_doctor_question()` | Queue a question for the doctor. |
| `message_caregiver()` | Send a message/alert to the linked caregiver. |
| `show_instruction_video()` | Surface a relevant instruction video. |
| `request_human_help()` | Escalate to a human (caregiver / support). |
| `add_prescription()` | Add a prescription (scan → propose → confirm). |

## Core flows (brief)

- **Ask about a medication.** Elder asks in dialect → Hermes calls `get_drug_info()` → grounds the answer in OpenFDA (cached) → replies in plain language / dialect. Explains, never diagnoses.
- **Log a dose.** Elder says they took a pill → Hermes calls `log_dose()` → writes as the user (RLS) → confirms.
- **Add a prescription (scan).** Elder photographs a prescription → Claude vision extracts details → Hermes **proposes** the entry and asks for confirmation → only after human confirmation does a privileged write commit. **Scan proposes, never commits.**
- **Escalation.** Uncertainty or a safety concern → `request_human_help()` and an entry in the escalation log → `message_caregiver()` bridges to a person.
- **Reminders.** The VPS scheduler (service role) computes due doses and sends Expo Push notifications.

## Safety rails

- **Scan = propose, never commit** — prescription scans are proposals confirmed by a human before any write.
- **Explain, never diagnose** — Hermes provides information, not medical judgement.
- **Grounded in OpenFDA** — drug facts come from an authoritative source, cached in Postgres, never invented.
- **Uncertainty → escalation** — when unsure, Hermes logs an escalation and routes to a human.
- **RLS + audit log** — the consent model is enforced in Postgres; privileged actions are auditable.
- **Human-in-the-loop** — consequential writes require confirmation.
- **Graceful fallback** — if voice fails, fall back to large, simple buttons.
- **Bridge to people, not a replacement** — the agent connects patients to their caregivers and doctors; it does not replace them.

## Build status / phasing

| Item | Status |
| --- | --- |
| Supabase backend — schema + RLS (consent model) + seed | **Built (this pass)** |
| Frontend — Expo + React Native (elder + caregiver views) | Deferred |
| Hermes orchestrator — Python 3.12 + FastAPI on VPS | Deferred |
| Hermes agent — Claude Sonnet 5 tool-calling loop + tool belt | Deferred |
| OpenFDA grounding + Postgres cache | Deferred |
| Voice / dialect — HuggingFace STT/TTS (stretch) | Deferred |
| Live human help / escalation routing | Deferred |
