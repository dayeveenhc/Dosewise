# services/hermes — Dosewise orchestrator

**Hermes** is the AI orchestrator and **security boundary** of Dosewise: a
**Python 3.12 + FastAPI** service that runs the **Claude Sonnet 5** tool-calling
loop and the 10-tool belt, holding all external API keys. The client never talks to
Claude, OpenFDA, or HuggingFace directly.

It's testable **before any frontend exists** through two channels on one shared
core:

- **CLI harness** (`uv run hermes-chat`) — fast dev loop; prints tool calls inline.
- **Telegram bot** — the current demo interface: chat, photo upload for the
  prescription-scan flow, and **voice notes** (transcribed via HuggingFace STT).

## Tool belt

`list_medications` · `log_dose` · `get_drug_info` (OpenFDA, cached in `drug_cache`)
· `add_doctor_question` · `message_caregiver` · `show_instruction_video` ·
`request_human_help` · `add_prescription` (Claude vision → **propose → confirm**) ·
`check_refills` · `log_refill`.

## Reminders, dialect & voice

- **Daily dose reminders** — an in-process background task expands each active
  medication's `schedule.times` (interpreted in `HERMES_TZ`) into today's due slots,
  DMs the elder at each time, and alerts a linked caregiver when a *critical* dose is
  overdue and not logged taken — suppressed during the caregiver's quiet hours (the
  caregiver alert always pierces them). The full dose *calendar* is deferred with the
  frontend. See `src/hermes/dosing.py` + `channels/scheduler.py`.
- **Dialect & slang** — the elder's `profiles.dialect` is folded into the system
  prompt, and a dialect **slang glossary from MongoDB** (`MONGODB_URI`, optional) lets
  Hermes *understand* slang — never changing a grounded fact. See `src/hermes/slang.py`.
- **Multilingual voice** — Telegram voice notes are transcribed with
  **Whisper-large-v3** (high-resource) or **MMS** (`facebook/mms-1b-all`, for
  Hokkien/Teochew, with a Whisper fallback); **fastText** detects the input language;
  Hermes replies in that language as **text + audio** (per-language `facebook/mms-tts-*`
  via Telegram `sendAudio`). All voice/slang features degrade to text when their keys
  are unset. See `channels/lang.py` + `channels/voice.py`.

## Safety rails

Scan proposes never commits · explain never diagnose · grounded in OpenFDA ·
uncertainty → escalation log · human-in-the-loop · RLS + audit · bridge to people.
Encoded in `src/hermes/agent/prompts.py` **and** enforced server-side (the
`add_prescription` confirm guard).

## How RLS is preserved

Hermes acts **as the user**. For the test harness it mints a short-lived Supabase
JWT (`sub` = the mapped elder) signed with `SUPABASE_JWT_SECRET`, then calls
PostgREST with it — so every existing RLS policy applies unchanged
(`src/hermes/db/auth.py`, `db/supabase.py`). The service-role key is used **only**
for `drug_cache` writes.

## Layout

```
src/hermes/
├── config.py            # pydantic-settings (reads repo-root .env)
├── main.py              # FastAPI app + lifespan; `hermes-serve`
├── agent/               # prompts.py + loop.py (the Claude tool-use loop)
├── db/                  # auth.py (mint/verify JWT) + supabase.py (PostgREST)
├── tools/               # one file per tool + registry (base.py)
├── channels/            # session.py, cli.py, telegram.py
└── api/routes.py        # /health, /agent/turn, /telegram/webhook
```

## Run it locally (long-polling)

1. **Start local Supabase** (from the repo root):
   ```bash
   brew install supabase/tap/supabase
   supabase start
   supabase db reset          # applies migrations + seed (Elder A/B, Caregiver C)
   supabase status            # copy API URL / anon / service_role / JWT secret
   ```
2. **Fill `.env`** (repo root) with those Supabase values, plus `ANTHROPIC_API_KEY`
   and `TELEGRAM_BOT_TOKEN`. Keep `HERMES_CHANNEL_MODE=polling`.
3. **Install + run:**
   ```bash
   cd services/hermes && uv sync
   uv run hermes-chat        # CLI harness, or…
   uv run hermes-serve       # FastAPI + Telegram long-poll
   ```

## Try it

- CLI / Telegram: *"what are my medications?"* → `list_medications` → Metformin,
  Vitamin D3 (Elder A). *"I took my metformin"* → `log_dose`. *"what is metformin
  for?"* → `get_drug_info` (grounded). **RLS proof:** `/switch b` → only Amlodipine.
- Telegram photo of a prescription → `add_prescription` proposes → reply *"yes"* →
  it saves.

## Test

```bash
uv run pytest          # offline: JWT claims + propose-never-commit guard
uv run ruff check src
```

## Deploy to the VPS

Webhook mode on the Hostinger VPS — see [`deploy/README.md`](deploy/README.md).
Note: local Supabase isn't reachable from the VPS, so the webhook deploy needs a
**hosted** Supabase (a follow-up).

See [`../../docs/architecture.md`](../../docs/architecture.md) for the full picture.
