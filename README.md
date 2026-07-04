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
| Frontend (web) | Vite + React + Tailwind + shadcn/ui | Dual interface: elder voice-first view + caregiver control view (from Figma design) |
| Frontend (mobile) | Expo + React Native | Deferred native client, same dual interface |
| Data platform | Supabase (Postgres, Auth, Storage, Realtime) | System of record; **Postgres RLS is the consent model** |
| Orchestrator | Python 3.12 + FastAPI on a private VPS | Security boundary; holds all external keys; runs the agent loop and safety rails |
| AI brain | Claude Sonnet 5 (`claude-sonnet-5`) via the `anthropic` Python SDK | Vision (prescription scans), tool-calling, adaptive thinking |
| Drug knowledge | OpenFDA (cached in Postgres) | Grounded, authoritative drug facts |
| Speech | HuggingFace Inference API (STT / TTS) | Telegram voice notes: STT is wired; TTS reply-back is opt-in (set `HF_TTS_MODEL`) |
| Push | Expo Push (driven by the VPS scheduler) | Reminders and caregiver alerts |

## Repository layout

```
Dosewise/
├── README.md              # this file
├── .gitignore
├── .env.example           # credential template (copy to .env; never commit .env)
├── docs/
│   └── architecture.md    # full architecture reference
├── supabase/              # Postgres schema + RLS + seed  (BUILT)
├── apps/
│   ├── web/               # Vite + React frontend, from Figma design  (IN PROGRESS)
│   └── mobile/            # Expo + React Native frontend  (DEFERRED)
│       └── README.md
└── services/
    └── hermes/            # Python + FastAPI orchestrator + agent + tool belt  (BUILT)
        └── README.md
```

## Current status

The **Supabase backend** and the **Hermes orchestrator** (agent + full tool belt) are both built and work end-to-end. The **current demo interface is Telegram** — an elder chats with the bot and Hermes drives the agent loop, tools, and database live. The Figma design has landed as a Vite + React web app in `apps/web`; it still needs to be wired up to Supabase and Hermes.

| Component | Status |
| --- | --- |
| Supabase backend (schema + RLS + seed) | **Built** |
| `services/hermes` — Python + FastAPI orchestrator | **Built** |
| Hermes agent on Claude Sonnet 5 + tool belt (10 tools) | **Built** |
| OpenFDA grounding + Postgres cache | **Built** |
| Telegram demo channel (elder chats with the bot) | **Built** |
| Voice notes — HuggingFace STT (+ optional TTS) on Telegram | **Built** |
| Reminders scheduler + caregiver alerts (Telegram delivery) | **Built** |
| `apps/web` — Vite + React frontend (from Figma design) | UI built, not yet wired to Supabase/Hermes |
| `apps/mobile` — Expo + React Native frontend | Deferred |

## Getting started

1. **Set up credentials.** Copy the credential template to a **git-ignored** `.env`:
   ```bash
   cp .env.example .env
   ```
   Fill in your values in `.env`. It is ignored by git (see `.gitignore`) and must never be committed. `.env.example` is the only env file that is tracked.
2. **Apply the database.** Follow [`supabase/README.md`](supabase/README.md) to apply the schema, RLS policies, and seed data.
3. **Run Hermes.** Follow [`services/hermes/README.md`](services/hermes/README.md) to start the orchestrator and chat with the agent over the CLI or the Telegram bot (the current demo interface).
4. **Run the web frontend.**
   ```bash
   cd apps/web
   npm install
   npm run dev
   ```
   It's UI-only for now — not yet wired to Supabase Auth or the Hermes API.
5. **Read the architecture.** See [`docs/architecture.md`](docs/architecture.md) for the full hybrid architecture, the RLS-with-external-orchestrator model, the Hermes tool belt, and the build phasing.
