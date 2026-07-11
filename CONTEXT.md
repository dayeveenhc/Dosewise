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
└── docs/architecture.md  # deeper architecture reference
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

Voice input/output is client-side (browser Web Speech API — `SpeechRecognition`
+ `speechSynthesis`), not routed through Hermes; it degrades gracefully where
unsupported. Text-to-speech goes through the shared `lib/speech.ts::speak`
(cancel→speak race fix + `voiceschanged` voice selection). Whether Mei reads
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
- `tools/` — one file per tool (medications, profile, drug_info, interactions,
  schedule, doses, refills, caregiver, doctor, escalation, videos), registered
  via `tools/base.py`.
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
