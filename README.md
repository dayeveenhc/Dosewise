# Dosewise

**An agent-first medication app for elderly patients and their caregivers.**

> **USP:** Elderly users just *talk* — in their own dialect — to an AI agent (**Hermes**) that operates the app on their behalf, while caregivers get a fuller control interface. Built on understanding, the caregiver dyad, and safety-by-design.

Dosewise is a university HCI & AI course competition build. Instead of asking frail or non-technical users to navigate menus, forms, and dosage schedules, we put an AI agent in front of them. The elder speaks (or types) naturally; the agent understands intent, grounds every drug fact in authoritative data, and takes action through a constrained tool belt. A caregiver dyad sits behind every patient as the retention and safety engine.

## Why Dosewise is different

- **Understanding** — grounded, plain-language answers, delivered in the user's own dialect.
- **The caregiver dyad** — a consenting caregiver linked to each patient is the retention engine and the safety net.
- **Safety-by-design** — human-in-the-loop confirmation, facts grounded in OpenFDA, escalation logging, and a Postgres Row-Level-Security (RLS) consent model. The agent explains, it never diagnoses; it proposes, it never silently commits.

## Tech stack

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend | Expo + React Native | Dual interface: elder voice-first view + caregiver control view |
| Data platform | Supabase (Postgres, Auth, Storage, Realtime) | System of record; **Postgres RLS is the consent model** |
| Orchestrator | Python 3.12 + FastAPI on a private VPS | Security boundary; holds all external keys; runs the agent loop and safety rails |
| AI brain | Claude Sonnet 5 (`claude-sonnet-5`) via the `anthropic` Python SDK | Vision (prescription scans), tool-calling, adaptive thinking |
| Drug knowledge | OpenFDA (cached in Postgres) | Grounded, authoritative drug facts |
| Speech / dialect | HuggingFace Inference API (STT / translate / TTS) | Voice + dialect (stretch goal; demo is text-first) |
| Push | Expo Push (driven by the VPS scheduler) | Reminders and caregiver alerts |

## Repository layout

```
Dosewise/
├── README.md              # this file
├── .gitignore
├── .env.example           # credential template (copy to .env; never commit .env)
├── docs/
│   └── architecture.md    # full architecture reference
├── supabase/              # Postgres schema + RLS + seed  (BUILT this pass)
├── apps/
│   └── mobile/            # Expo + React Native frontend  (DEFERRED)
│       └── README.md
└── services/
    └── hermes/            # Python + FastAPI orchestrator  (DEFERRED)
        └── README.md
```

## Current status

Only the **Supabase backend** is built so far: the Postgres **schema**, the **RLS** policies that encode the consent model, and the **seed** data. Everything else is scaffolding and deferred to later passes:

| Component | Status |
| --- | --- |
| Supabase backend (schema + RLS + seed) | **Built** |
| `apps/mobile` — Expo + React Native frontend | Deferred (scaffold only) |
| `services/hermes` — Python + FastAPI orchestrator | Deferred (scaffold only) |
| Hermes agent on Claude Sonnet 5 + tool belt | Deferred |
| OpenFDA grounding + Postgres cache | Deferred |
| HuggingFace voice / dialect (stretch) | Deferred |
| Live human help / escalation routing | Deferred |

## Getting started

1. **Apply the backend.** The only runnable component today is the Supabase backend. Follow [`supabase/README.md`](supabase/README.md) to apply the schema, RLS policies, and seed data.
2. **Set up credentials.** Copy the credential template to a **git-ignored** `.env`:
   ```bash
   cp .env.example .env
   ```
   Fill in your values in `.env`. It is ignored by git (see `.gitignore`) and must never be committed. `.env.example` is the only env file that is tracked.
3. **Read the architecture.** See [`docs/architecture.md`](docs/architecture.md) for the full hybrid architecture, the RLS-with-external-orchestrator model, the Hermes tool belt, and the build phasing.
