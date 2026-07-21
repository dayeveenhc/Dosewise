# Dosewise

**An agent-first medication app for elderly patients and their caregivers.**

> **USP:** Elderly users just *talk* — in their own dialect — to an AI agent (**Hermes**, persona *Mei*) that operates the app on their behalf, while caregivers get a fuller control interface. Built on three pillars: **understanding**, the **caregiver dyad**, and **safety-by-design**.

Dosewise is a university HCI & AI course competition build. Instead of asking frail or non-technical users to navigate menus, forms, and dosage schedules, we put an AI agent in front of them. The elder speaks (or types) naturally; the agent understands intent, grounds every drug fact in authoritative data, and takes action through a constrained tool belt. A caregiver dyad sits behind every patient as the retention and safety engine.

> **Live demo:** the app is hosted for the duration of the competition at **<https://7561-2a02-4780-5e-4dcc-00-1.ngrok-free.app/>** (served from our dev server via ngrok). On first visit you may see an ngrok interstitial — click **Visit Site** to continue. The link is temporary and may change between sessions.

---

## Project overview

Dosewise turns medication management into a conversation. Medication non-adherence among the elderly is a leading cause of avoidable hospitalization, yet the apps meant to help are menus, forms, and dosage schedules — exactly the things frail or non-tech-savvy users struggle with. Dosewise removes that friction: the elder just *talks* to a patient, warm AI helper (persona **Mei**, powered by the **Hermes** orchestrator), in their own language and dialect, and the agent operates the app for them — grounded in authoritative drug data, and always asking for confirmation before changing anything.

### Who it's for

- **Elderly patients** — typically multilingual Singaporean seniors who may be frail, anxious, or uncomfortable with technology. Their interface is **voice-first, large-text, and simplified**.
- **Their caregivers** — a consenting family member or helper linked to each patient. Their interface is a **fuller control view** for monitoring adherence, managing medications, and responding to escalations.

### The three pillars

- **Understanding** — grounded, plain-language answers, delivered in the user's own dialect. An optional slang glossary lets the agent actually *understand* local phrasing (e.g. a Hokkien word for a drug) without ever changing a grounded fact.
- **The caregiver dyad** — a consenting caregiver linked to each patient is the retention engine and the safety net. If a *critical* dose is missed, the linked caregiver is alerted.
- **Safety-by-design** — human-in-the-loop confirmation, facts grounded in OpenFDA, escalation logging, and a Postgres Row-Level-Security (RLS) consent model. The agent explains, it never diagnoses; it proposes, it never silently commits.

### Two interfaces, one app

Onboarding forks early into a role, and the same codebase serves two deliberately different experiences:

- **Elder mode** (`apps/web/src/app/screens/elderly/`) — large-text home schedule, a simplified "talk to Mei" chat, prescription list, and Quick-help tiles (add a prescription by photo, update profile from a report, ask about a medication, language & voice, travel mode).
- **Caregiver mode** (`apps/web/src/app/screens/`) — a dashboard, patient timeline, medication management, an "Ask Mei" assistant chat, notifications, and settings. Caregivers can preview the elder view without changing the stored role.

### Supported languages

Built for Singapore's multilingual, multi-dialect population. The chosen language drives the agent's reply language (`reply_language`), the UI strings, and the browser speech (voice input + read-aloud):

| Code | Language |
| --- | --- |
| `en` | English |
| `zh` | 华语 (Mandarin) |
| `hokkien` | 闽南话 (Hokkien) |
| `yue` | 粤语 (Cantonese) |
| `ta` | தமிழ் (Tamil) |
| `ms` | Melayu |

Medication schedule times are interpreted in `HERMES_TZ` (defaults to `Asia/Singapore`).

### Two channels, one agent core

Hermes exposes a single shared turn function, `run_agent_turn` (`services/hermes/src/hermes/agent/loop.py`), reached by two independent channels:

- **The web app** — `POST /agent/turn` (`services/hermes/src/hermes/api/routes.py`), called directly from the browser by `apps/web`. This is the **primary demo surface**. The client forwards its Supabase session JWT; Hermes verifies it and acts as that user.
- **Telegram bot** — the **testbed channel**, kept working for informal testing and to demo features the web app doesn't have yet (native voice notes, inline confirm buttons).

Both channels persist conversation history and act through Supabase **RLS as the user** (Hermes mints/verifies JWTs — `services/hermes/src/hermes/db/auth.py`), never a service-role bypass except for `drug_cache`, cron reads, and pill-photo uploads.

### HTTP API

Hermes exposes a small, security-gated REST surface (`services/hermes/src/hermes/api/routes.py`):

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness probe → `{"status":"ok","service":"hermes"}`. |
| `POST /agent/turn` | The primary agent turn. Body `{message, jwt?, elder_id?, image_base64?, pdf_base64?, reply_language?}` → `{reply, tools_used, actions}`. `actions` lists the writes the agent **actually committed** this turn (a tool name in `tools_used` alone is not enough — propose and commit both call e.g. `add_prescription`). Auth: a verified Supabase JWT (**ES256**, checked against the project JWKS) in production (`HERMES_STRICT_AUTH=1`); the dev `elder_id` fallback for local testing. |
| `POST /profile/extract` | AI-powered extraction of medical-profile fields from an uploaded report image/PDF (vision) → structured fields the user **confirms before saving**. |
| `POST /telegram/webhook` | Inbound Telegram updates (webhook mode; long-poll is used locally). |

All POST endpoints are guarded by an in-process rate limiter (`RATE_LIMIT_*`) and, when set, a shared `X-Hermes-Api-Key` header (`HERMES_API_KEY`). The client never holds LLM/OpenFDA/HuggingFace keys — Hermes is the only thing that calls them.

### What the agent can do

For an elderly patient (or their caregiver), Mei/Hermes can:

- **List your medicines** — what you take, when, and what each is for.
- **Explain any drug in plain words** — grounded in OpenFDA, never invented.
- **Read a prescription photo** (or a PDF report) — reads the details back and saves only after you confirm.
- **Log a dose** — confirm when you've taken a pill.
- **Track refills** — warns you before you run out, and lets you log a refill.
- **Daily dose reminders** — notifies you at each dose time and alerts a linked caregiver if a *critical* dose is missed.
- **Set your own reminder times** — "remind me at 8am and 8pm" and it notifies you every day.
- **Queue a question for your doctor**, message a **caregiver**, or **get a human** when something's wrong.
- **Show a how-to video** for an inhaler or eye-drops.
- **Talk in your language & dialect**, by **voice or text**.

**Tool belt (11):** `list_medications` · `log_dose` · `get_drug_info` · `check_refills` · `log_refill` · `add_prescription` (vision → propose → confirm) · `set_medication_reminder` · `add_doctor_question` · `message_caregiver` · `show_instruction_video` · `request_human_help`.

### Data model & consent

The system of record is Postgres on Supabase, defined across 4 migrations in `supabase/migrations/`. Consent is anchored in the **`care_links`** table and enforced by Row-Level Security — the **database**, not the app, decides who can see what.

| Table | Holds |
| --- | --- |
| `profiles` | User profile — role (`elder`/`caregiver`), dialect, medical profile, travel plan |
| `care_links` | The consent graph — an active row links a caregiver to an elder (the RLS pivot) |
| `medications` | A patient's medications + `schedule.times` |
| `doses` | Dose log (taken / skipped) |
| `refills` | Refill log + remaining-supply tracking |
| `doctor_questions` | Questions queued for the patient's doctor |
| `conversation_turns` | Agent conversation history (both channels) |
| `drug_cache` | Cached OpenFDA facts (service-role written, public read) |
| `dialect_lexicon` | Dialect slang glossary backing slang understanding |
| `instruction_videos` | Curated how-to videos (inhalers, eye-drops) |

**Consent rule:** an elder's health data is readable by the owner (`auth.uid() = elder_id`) or an actively linked caregiver (`public.is_linked_caregiver(elder_id)`, a `SECURITY DEFINER` function with a fixed `search_path`). Reference tables (`drug_cache`, `dialect_lexicon`, `instruction_videos`) are public-read, service-role-write. Migration `0004_rls_hardening.sql` adds restrictive DELETE / reference denials so RLS can't be silently reopened.

---

## Team members

| Member | Role |
| --- | --- |
| Isabel Yee Ann | — |
| Davin Handreas | — |
| Kam Fang Yu | — |
| Suheera Banu | — |
| Nathaniel Neo | — |

---

## Tech stack

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend (web) | Vite + React + Tailwind + shadcn/ui (Radix) + MUI, Supabase JS | **Primary demo surface** — dual interface: elder voice-first view + caregiver control view (from Figma design) |
| Frontend (mobile) | Expo + React Native | Deferred native client, same dual interface |
| Data platform | Supabase (Postgres, Auth, Storage, Realtime) | System of record; **Postgres RLS is the consent model** |
| Orchestrator | Python 3.12 + FastAPI | Security boundary; holds all external keys; runs the agent loop and safety rails |
| Drug knowledge | OpenFDA (cached in Postgres `drug_cache`) | Grounded, authoritative drug facts |
| Speech (Telegram) | HuggingFace Inference API — Whisper/MMS STT + TTS, fastText LID | Telegram voice notes transcribed; replies read back in the detected language |
| Speech (web) | Browser Web Speech API (`SpeechRecognition` + `speechSynthesis`) | Client-side voice in/out; degrades gracefully where unsupported |
| Slang | MongoDB dialect glossary (optional) | Lets Hermes understand the elder's dialect slang — never changing a grounded fact |
| Reminders | In-process scheduler | Daily dose reminders + caregiver alerts when a critical dose is missed (Telegram delivery) |

---

## AI models

Hermes' agent loop is **provider-agnostic**. The active brain is selected by `LLM_PROVIDER`; **Anthropic is the automatic fallback** when the configured provider's API key is unset.

| Model | Use | Notes |
| --- | --- | --- |
| **OpenAI `gpt-4o`** | Agent brain (default) | Tool-calling, vision (prescription scans) |
| **Google `gemini-2.5-flash`** | Agent brain (alternative) | Set `LLM_PROVIDER=gemini` |
| **Anthropic `claude-sonnet-5`** | Agent brain (alternative + automatic fallback) | Used when the configured provider's key is missing |
| **`openai/whisper-large-v3`** | Speech-to-text (high-resource languages) | HuggingFace Inference API |
| **`facebook/mms-1b-all`** | Speech-to-text (low-resource / dialect, e.g. Hokkien/Teochew) | Whisper autodetect fallback |
| **`facebook/mms-tts-*`** | Text-to-speech (per-language) | Telegram `sendAudio` |
| **`facebook/fasttext-language-identification`** | Input-language detection | Downloaded locally, not via API |

---

## APIs & external services

| Service | Purpose |
| --- | --- |
| **OpenAI API** | Default LLM brain (gpt-4o) |
| **Anthropic API** | Alternate LLM brain (Claude Sonnet 5) + automatic fallback |
| **Google Gemini API** | Alternate LLM brain (Gemini 2.5 Flash) |
| **OpenFDA API** | Authoritative drug labeling/interaction facts (keyless works at a lower rate limit; cached in Postgres `drug_cache`) |
| **HuggingFace Inference API** | STT / TTS / language-identification for Telegram voice (optional) |
| **Supabase** | Postgres, Auth, Storage, Realtime — system of record; RLS is the consent model |
| **Telegram Bot API** | Testbed channel (chat, photo scan, voice notes, inline confirm) |
| **MongoDB** | Optional dialect slang glossary (disabled when `MONGODB_URI` is unset) |
| **Browser Web Speech API** | Client-side voice input/output in the web app |

---

## Datasets

| Dataset | Use | Source |
| --- | --- | --- |
| **OpenFDA** drug labeling | Grounds every drug explanation/interaction in authoritative data | [open.fda.gov](https://open.fda.gov) — public; cached locally in Postgres `drug_cache` |
| **Dialect slang glossary** | Lets the agent understand the elder's local phrasing | Team-curated, stored in MongoDB (optional) |
| **Instructional videos** | "How-to" media for devices (inhalers, eye-drops) | Curated references served via `show_instruction_video` |
| **Seed data** | Local-dev demonstration of the RLS consent model | Synthetic, local-only (`supabase/seed/seed.sql`) — Elder A, Elder B, Caregiver C. **Not real patient data.** |

---

## Repository layout

```
Dosewise/
├── README.md              # this file
├── CONTEXT.md             # current-state architecture snapshot (read first)
├── MEMORY.md              # dated log of decisions & non-obvious gotchas
├── CLAUDE.md              # agent ownership & safety boundaries
├── .env.example           # credential template (copy to .env; never commit .env)
├── docker-compose.yml     # runs Hermes in a container on the VPS (bind-mounts the repo)
├── .github/workflows/ci.yml   # Ruff lint + offline pytest; keeps main green
├── docs/
│   └── architecture.md    # full architecture reference
├── supabase/              # Postgres schema + RLS + seed + migrations   (built)
│   ├── migrations/        # 0001 init → 0002 RLS → 0003 storage → 0004 RLS hardening
│   └── README.md
├── apps/
│   ├── web/               # Vite + React frontend — PRIMARY demo surface   (built + wired)
│   │   ├── README.md / CLAUDE.md
│   └── mobile/            # Expo + React Native frontend   (deferred)
└── services/
    └── hermes/            # Python + FastAPI orchestrator + agent + tool belt   (built)
        └── README.md
```

## Current status

The **Supabase backend**, the **Hermes orchestrator**, and the **web frontend** are all built and work end-to-end. The web app (`apps/web`) is the primary demo surface — login/signup, medication CRUD, profile save, dose logging, travel planning, and the full chat / photo-prescription / report-upload agent flows are all wired to Supabase and Hermes. Telegram remains as a testbed channel for voice and inline-confirm features.

| Component | Status |
| --- | --- |
| Supabase backend (4 migrations: schema + RLS + storage + RLS hardening) | **Built** |
| `services/hermes` — Python + FastAPI orchestrator | **Built** |
| Hermes agent (OpenAI default / Gemini / Claude, auto-fallback) + tool belt (11 tools) | **Built** |
| OpenFDA grounding + Postgres `drug_cache` | **Built** |
| `apps/web` — Vite + React frontend | **Built + wired** to Supabase + Hermes (primary surface) |
| Telegram channel — chat, photo scan, voice notes, inline confirm | **Built** (testbed channel) |
| Multilingual voice (Telegram: HF STT/TTS · Web: Web Speech API) | **Built** |
| Reminders scheduler + caregiver alerts (Telegram delivery) | **Built** |
| `apps/mobile` — Expo + React Native frontend | Deferred |

## Safety rails

Grounded facts only (drug info always from `get_drug_info`/OpenFDA, never memory) · explain-never-diagnose · scan/reminder/profile changes always propose → confirm before writing · human-in-the-loop · RLS + audit trail · bridge-to-people escalation path. These are encoded in `agent/soul.md` **and** enforced server-side (e.g. the `add_prescription` confirm guard) — they don't rely on the prompt alone.

---

## Setup & installation

Dosewise is a **hybrid** app: you run three things — a **database** (Supabase/Postgres), an **orchestrator** (Hermes, Python/FastAPI), and a **frontend** (Vite/React). The frontend talks to *both* Supabase (direct data, RLS-scoped) and Hermes (agent turns). The full picture is in [`docs/architecture.md`](docs/architecture.md).

### Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) + **npm** | LTS (18+) | Runs the Vite/React frontend |
| [Python](https://www.python.org/) | **3.12** | Runs Hermes |
| [uv](https://docs.astral.sh/uv/) | latest | Python package manager for Hermes |
| [Supabase CLI](https://supabase.com/docs/guides/cli) | latest | Applies the local Postgres schema + RLS + seed |
| [Docker](https://www.docker.com/) | running | The local Supabase stack runs in containers |
| [Git](https://git-scm.com/) | any | Clone the repo |

Plus **API keys** for the LLM provider you want to use (OpenAI by default). Telegram / HuggingFace / MongoDB keys are optional — those features degrade gracefully to text when unset.

### 1. Clone the repo

```bash
git clone <repo-url> dosewise
cd dosewise
```

### 2. Configure credentials (`.env`)

```bash
cp .env.example .env      # then edit .env with your values
```

`.env` is git-ignored — **never commit it**. **Required** values:

| Group | Variables | Notes |
| --- | --- | --- |
| **Supabase** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | From `supabase status` (local) or your project dashboard (hosted) |
| **LLM brain** | `LLM_PROVIDER` + the matching `_API_KEY` / `_MODEL` | `openai` (default) · `gemini` · `anthropic`. Anthropic is the **automatic fallback** if the chosen provider's key is unset |

**Optional** values (features turn off gracefully when blank):

| Group | Variables | Notes |
| --- | --- | --- |
| **Drug facts** | `OPENFDA_API_KEY` | Keyless works at a lower rate limit |
| **Voice (Telegram)** | `HUGGINGFACE_API_KEY`, `HF_STT_MODEL`, `HF_STT_LOWRESOURCE_MODEL`, `HF_TTS_MODEL`, `HF_LID_MODEL` | Whisper/MMS STT + TTS, fastText LID |
| **Slang** | `MONGODB_URI`, `MONGODB_DB`, `MONGODB_SLANG_COLLECTION` | Disables slang grounding when unset |
| **Telegram** | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Testbed channel |
| **Server** | `HERMES_HOST`, `HERMES_PORT`, `HERMES_CHANNEL_MODE`, `HERMES_TZ` | Defaults `0.0.0.0:8000`, `polling`, `Asia/Singapore` |
| **Web / security** | `HERMES_CORS_ORIGINS`, `HERMES_STRICT_AUTH`, `HERMES_API_KEY` | CORS defaults to `http://localhost:5173`; set `HERMES_STRICT_AUTH=1` in production |
| **Rate limiting** | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_TURNS_PER_MINUTE`, `RATE_LIMIT_TURNS_PER_HOUR`, `RATE_LIMIT_HTTP_PER_MINUTE` | On by default |
| **Reminders** | `REMINDERS_ENABLED`, `REMINDER_POLL_SECONDS`, `MISSED_DOSE_MINUTES` | Caregiver alert when a critical dose is overdue |
| **Dev identity** | `DEV_DEFAULT_ELDER_ID` | Telegram/CLI test identity (Elder A from the seed) |

### 3. Set up the database

**Option A — local Supabase (recommended for development):**

```bash
supabase start          # boot local Postgres + Auth + Studio
supabase db reset       # apply migrations/ then seed/seed.sql
supabase status         # copy API URL / anon key / service_role key / JWT secret into .env
```

Studio UI: http://127.0.0.1:54323. Seeded local users (password `password`, **local dev only**): `elder.a@dosewise.local`, `elder.b@dosewise.local`, `caregiver.c@dosewise.local`.

**Option B — hosted Supabase (for a shared / live demo):** create a project at supabase.com, run the files in `supabase/migrations/` against it in order (`0001` → `0004`), then put the project URL / anon key / service_role key / JWT secret into `.env`. This is how the live demo is hosted.

See [`supabase/README.md`](supabase/README.md) for the schema, RLS policies, and the consent model.

### 4. Run the Hermes backend

```bash
cd services/hermes
uv sync --extra dev          # install deps (incl. dev/test tooling)
uv run hermes-serve          # FastAPI on http://localhost:8000
```

Verify it's up:

```bash
curl http://localhost:8000/health     # → {"status":"ok","service":"hermes"}
```

Alternatives: `uv run hermes-chat` for a CLI harness (no web/Telegram needed), or `HERMES_PORT=8901 uv run hermes-serve` to avoid a port clash. Because the browser calls `/agent/turn` directly, add your frontend origin to `HERMES_CORS_ORIGINS` (defaults to `http://localhost:5173`). Details: [`services/hermes/README.md`](services/hermes/README.md).

### 5. Run the web frontend

The frontend has its **own** git-ignored `.env` (Vite only exposes `VITE_`-prefixed vars to the browser):

```bash
cd apps/web
cp .env.example .env     # fill in: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_HERMES_URL
npm install
npm run dev              # Vite dev server → http://localhost:5173
```

Point `VITE_HERMES_URL` at your Hermes instance (e.g. `http://localhost:8000`, or the ngrok URL for a remote demo). Open http://localhost:5173, sign in or sign up, and you're in.

### 6. Try it

In the assistant chat (elder "talk to Mei" or caregiver "Ask Mei"):

- *"what are my medications?"* → `list_medications`
- *"what is metformin for?"* → `get_drug_info` (grounded in OpenFDA)
- Upload a prescription photo → `add_prescription` proposes → confirm → it saves
- *"I took my metformin"* → `log_dose`

### Troubleshooting

- **`/agent/turn` returns 401 / chat shows a fallback message** — real Supabase JWTs are **ES256** and verified against the project JWKS; ensure `SUPABASE_URL` is the bare project URL (no trailing `/rest/v1/`). Set `HERMES_STRICT_AUTH=1` only in production.
- **Browser blocked at preflight (CORS)** — add the frontend origin to `HERMES_CORS_ORIGINS`.
- **Port 8000 busy** — run Hermes on another port (`HERMES_PORT=...`).
- **429 Too Many Requests** — you hit the rate limiter; tune the `RATE_LIMIT_*` vars or set `RATE_LIMIT_ENABLED=0` for local dev.
- **Voice / slang features silent** — their API keys are unset; the app gracefully falls back to text.

### Next steps

Read [`docs/architecture.md`](docs/architecture.md) for the full hybrid architecture, the RLS-with-external-orchestrator model, the Hermes tool belt, and the build phasing.

---

## Testing

```bash
cd services/hermes
uv run pytest -q -m "not integration"   # offline suite (CI runs this)
uv run ruff check .                     # lint
```

Integration tests (e.g. the RLS check) need a live local Supabase and are marked `integration`; the web frontend is verified via `npm run build`.

## Deployment

Hermes runs on a Hostinger VPS — either via `docker-compose.yml` (bind-mounts the repo; `docker compose restart hermes` after a code sync) or pm2. Production posture: set `HERMES_STRICT_AUTH=1` so `/agent/turn` requires a verified Supabase JWT, and add the deployed app origin to `HERMES_CORS_ORIGINS`. See [`services/hermes/deploy/`](services/hermes/deploy/) for webhook-mode details.

---

## Declarations

### AI tools used in development

Parts of this project's code and documentation were developed with the assistance of AI tooling. All AI-generated output was reviewed, tested, and is the responsibility of the team.

- **Codex** via **opencode** — primary coding assistant used during development.
- **Claude** (Anthropic) — used for code review, refactoring, and documentation.

AI is used *inside the product* too — see the **AI models** section above. The medical agent is strictly **explain-never-diagnose**: it grounds drug facts in OpenFDA, proposes actions for human confirmation, and never invents clinical advice. It is **not** a medical device and does not provide medical advice.

### Academic integrity

This is a university HCI & AI course competition build. Third-party datasets and services are attributed in the **Datasets** and **APIs** sections. No real patient data is used — the seed dataset is synthetic and for local development only.
