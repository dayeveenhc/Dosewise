# services/hermes — Dosewise orchestrator

**Hermes** is the AI orchestrator and **security boundary** of Dosewise: a
**Python 3.12 + FastAPI** service that runs the **Claude Sonnet 5** tool-calling
loop and the 8-tool belt, holding all external API keys. The client never talks to
Claude, OpenFDA, or HuggingFace directly.

It's testable **before any frontend exists** through two channels on one shared
core:

- **CLI harness** (`uv run hermes-chat`) — fast dev loop; prints tool calls inline.
- **Telegram bot** — mobile chat + photo upload for the prescription-scan flow.

## Tool belt

`list_medications` · `log_dose` · `get_drug_info` (OpenFDA, cached in `drug_cache`)
· `add_doctor_question` · `message_caregiver` · `show_instruction_video` ·
`request_human_help` · `add_prescription` (Claude vision → **propose → confirm**).

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
