# Dosewise

**An agent-first medication app for elderly patients and their caregivers.**

> **USP:** Elderly users just *talk* — in their own dialect — to an AI agent (**Hermes**, persona *Mei*) that operates the app on their behalf, while caregivers get a fuller control interface. Built on three pillars: **understanding**, the **caregiver dyad**, and **safety-by-design**.

Dosewise is a university HCI & AI course competition build. Instead of asking frail or non-technical users to navigate menus, forms, and dosage schedules, we put an AI agent in front of them. The elder speaks (or types) naturally; the agent understands intent, grounds every drug fact in authoritative data, and takes action through a constrained tool belt. A caregiver dyad sits behind every patient as the retention and safety engine.

> **Live demo:** the app is hosted for the duration of the competition at **<https://7561-2a02-4780-5e-4dcc-00-1.ngrok-free.app/>** (served from our dev server via ngrok). On first visit you may see an ngrok interstitial — click **Visit Site** to continue. The link is temporary and may change between sessions.

---

## Project overview

Dosewise turns a medication-management app into a conversation. The design rests on three pillars:

- **Understanding** — grounded, plain-language answers, delivered in the user's own dialect (with an optional slang glossary so it actually *understands* local phrasing).
- **The caregiver dyad** — a consenting caregiver linked to each patient is the retention engine and the safety net.
- **Safety-by-design** — human-in-the-loop confirmation, facts grounded in OpenFDA, escalation logging, and a Postgres Row-Level-Security (RLS) consent model. The agent explains, it never diagnoses; it proposes, it never silently commits.

### Two channels, one agent core

Hermes exposes a single shared turn function, `run_agent_turn` (`services/hermes/src/hermes/agent/loop.py`), reached by two independent channels:

- **The web app** — `POST /agent/turn` (`services/hermes/src/hermes/api/routes.py`), called directly from the browser by `apps/web`. This is the **primary demo surface**. The client forwards its Supabase session JWT; Hermes verifies it and acts as that user.
- **Telegram bot** — the **testbed channel**, kept working for informal testing and to demo features the web app doesn't have yet (native voice notes, inline confirm buttons).

Both channels persist conversation history and act through Supabase **RLS as the user** (Hermes mints/verifies JWTs — `services/hermes/src/hermes/db/auth.py`), never a service-role bypass except for `drug_cache`, cron reads, and pill-photo uploads.

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

### Prerequisites

- **Node.js** (for the web frontend) and **npm**
- **Python 3.12** + [**uv**](https://docs.astral.sh/uv/) (for Hermes)
- [**Supabase CLI**](https://supabase.com/docs/guides/cli) + **Docker** (for the local database)
- API keys for the providers you intend to use (OpenAI is the default brain)

### 1. Clone & configure credentials

```bash
git clone <repo-url> dosewise && cd dosewise
cp .env.example .env        # then fill in your values
```

Fill in your Supabase values plus the LLM provider of your choice (OpenAI is the default brain; Anthropic is the automatic fallback). Telegram / HuggingFace / MongoDB keys are optional — those features degrade to text when unset. `.env` is git-ignored; **never commit it**.

### 2. Apply the database

Follow [`supabase/README.md`](supabase/README.md):

```bash
supabase start && supabase db reset   # applies migrations/ then seed/seed.sql
supabase status                       # copy API URL / anon / service_role / JWT secret
```

### 3. Run the Hermes backend

```bash
cd services/hermes
uv sync --extra dev
uv run hermes-serve      # FastAPI on :8000  (or `uv run hermes-chat` for the CLI harness)
```

The web app calls `/agent/turn` directly from the browser; allowed origins come from `HERMES_CORS_ORIGINS` (defaults to `http://localhost:5173`). Details: [`services/hermes/README.md`](services/hermes/README.md).

### 4. Run the web frontend

It needs its own git-ignored `.env` (mirror the Supabase values under the `VITE_` prefix and point at Hermes):

```bash
cd apps/web
cp .env.example .env      # fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_HERMES_URL
npm install
npm run dev               # Vite dev server on http://localhost:5173
```

### 5. Explore the architecture

See [`docs/architecture.md`](docs/architecture.md) for the full hybrid architecture, the RLS-with-external-orchestrator model, the Hermes tool belt, and the build phasing.

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
