# Dosewise — Session Memory

A chronological log of decisions, gotchas, and non-obvious fixes — the "why"
behind things that aren't derivable from reading the code alone. For the
current-state architecture snapshot, read `CONTEXT.md` first.

Keep entries short and dated. Prune/consolidate stale entries rather than
letting this grow forever — it's a memory aid, not an audit log.

---

## 2026-07-07 — `isabel-tried` merged into `main`; web app becomes primary demo surface

`main` was fast-forwarded through the `assistant-fixes` branch (rate limiting,
RLS hardening, service-client guard) and then merged with `origin/isabel-tried`,
which wired `apps/web` to Supabase and Hermes (login, medication CRUD, profile,
travel mode, setup wizard, and both AI chat screens calling `agentTurn()`).
`origin/main` at the time was already an ancestor of `isabel-tried`, so no
separate "heera7 changes" merge was needed. Not pushed to `origin/main` at
merge time — confirm before pushing.

**Consequence:** the demo surface shifted from Telegram-only to the web app,
with Telegram kept as a testbed (see `CONTEXT.md`).

## 2026-07-07 — Wired the Hermes AI assistant live in the web app

The `agentTurn()` ↔ `/agent/turn` code wiring existed from the isabel-tried
merge but **did not actually work**. Fixed, in order of how they'd bite:

1. **No CORS on Hermes** — the browser was refused at preflight before ever
   reaching the agent. Added `CORSMiddleware` gated by `HERMES_CORS_ORIGINS`
   (`services/hermes/src/hermes/main.py`, `config.py`).
2. **PDF ingest missing on `/agent/turn`** — the endpoint only took
   `image_base64`; report uploads are often PDFs. Added `pdf_base64`, reusing
   `channels/pdf.py::extract_pdf_text` the same way `telegram.py` does
   (`api/routes.py`).
3. **Prompt not app-aware** — `agent/soul.md` was Telegram-flavored (referenced
   tap-buttons that don't exist on web). Made it channel-neutral and added a
   section describing the app's actual screens/features.
4. **Photo prescription, report upload, and voice were UI theater** — all
   three were `setTimeout`/hardcoded mocks in `apps/web`. Replaced with real
   `agentTurn()` calls (photo/report) and the browser Web Speech API (voice —
   client-side only, not routed through Hermes).

Decisions locked in via `AskUserQuestion` (not re-litigate without a reason to):
add real CORS to Hermes (not just a Vite dev proxy); wire all four gaps in one
pass; voice via Web Speech API, not a new Hermes voice endpoint.

Crossed `apps/web/CLAUDE.md`'s "never edit services/hermes" boundary — done
only because the user explicitly directed this specific cross-cutting task.

**Test-suite fallout:** the `isabel-tried` merge had silently dropped the
`use_anthropic()` pin from several tests in `test_agent_loop.py` /
`test_telegram.py`, which then routed `FakeAnthropic` into the real OpenAI code
path and failed. Restored the helper in `tests/fakes.py` and the call sites —
unrelated to this task's own changes, but blocked getting a green baseline.

## 2026-07-08 — Agent UX pass: language, per-user chat, mode persistence, commit→redirect

Four fixes across web + hermes (user-directed cross-cutting work):

1. **`tools_used` can't tell propose from commit.** `add_prescription` (and
   `update_medical_profile`, `set_medication_reminder`) are called with
   `confirmed=false` **and** `confirmed=true`, and `loop.py` appends the tool name
   to `tools_used` in *both* — so `tools_used.includes("add_prescription")` is true
   on the propose turn where nothing was written. Added `ToolContext.committed_actions`
   (`tools/base.py`), appended **only** in each write tool's commit branch, returned
   as `actions` on `/agent/turn`. This is the reliable "a write happened" signal;
   the web chat keys its confirm+redirect on it. Don't revert web code to sniffing
   `tools_used` for writes.
2. **`reply_language` was already supported but never wired.** `run_agent_turn`
   accepted it (→ `prompts.system_prompt_for`), but `/agent/turn` didn't. Now the
   route forwards it; `lib/hermes.ts::agentTurn` resolves it from a per-user
   localStorage language setting (`lib/preferences.ts`) so every call honors it with
   no call-site threading. It's *reply_language*, not `profiles.dialect` (different
   prompt semantics: "reply in X" vs "mirror their words").
3. **Elderly chat was shared across all accounts** — keyed `mei-chat:${patient.id}`
   where `patient.id` is the constant mock id `1`. Now keyed by the Supabase `elderId`.
4. **"Always loads elderly on reopen"** was NOT a role-write bug (the wizard writes
   role correctly for both paths). `appMode` was derived only from the DB role, and
   "Switch mode" is an ephemeral preview. Fix: persist last-active mode per user in
   localStorage (`lib/preferences.ts`), preferred over the role default on load.

**Env gotcha (unchanged, reconfirmed):** the pm2 `hermes` (id 0, prod :8000) process
is in a chronic restart loop (16k+ restarts) independent of any change here — don't
mistake its "waiting restart" churn for something you broke. `hermes-demo` also
long-polls the **same Telegram bot token**, so a local `hermes-serve` (even on :8901)
will start a second poller — kill it promptly after verifying to avoid getUpdates
409s. Kill by the exact PID bound to your test port, never a broad `pkill hermes-serve`.

## 2026-07-08 — Live UI↔agent test found two more real bugs

Asked to verify the chatbot is actually reachable from the UI, not just that
the code compiles. Signed in a real test Supabase user
(`ui-test-elder@dosewise.test`) and drove `/agent/turn` exactly as the browser
would (session JWT + `Origin` header), including a full
propose→confirm→read-back prescription write. Found:

1. **`apps/web/.env` didn't exist** — created it (git-ignored), mirroring
   `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`/`VITE_HERMES_URL` from the
   deployed root `.env`. Without it `agentTurn()` has nowhere to call.
2. **Real Supabase user JWTs are ES256, not HS256** — `db/auth.py::verify_jwt`
   only checked the legacy HS256 shared-secret path (which is how
   Hermes-*minted* Telegram/CLI tokens are signed). Every real browser login
   was getting a silent 401 → the chat's `FALLBACK_REPLY`, with no visible
   error. Fixed by verifying ES256/RS256 against the project's JWKS
   (`PyJWKClient`), added `pyjwt[crypto]` dependency, kept HS256 for the
   minted-token path. Regression test added in `tests/test_hermes.py`.

Both were invisible from a code read or from the existing test suite — only
surfaced by actually driving the real HTTP+auth path end-to-end. **Lesson:
"the code path exists and unit tests pass" is not the same as "a real login
can talk to it."**

Also confirmed during this pass: `Settings.supabase_project_url` (added
2026-07-07 for the doubled `/rest/v1/` bug) is the single place both
`db/supabase.py` and `db/auth.py`'s JWKS URL now derive the base Supabase URL
from — don't reintroduce a second ad-hoc `.rstrip("/")` elsewhere.

**Environment gotcha:** this box runs a pm2-managed production Hermes on port
8000 (`pm2 list`), auto-deployed via `deploy/pm2/watch-and-pull.sh`. Local
verification servers should bind a different port
(`HERMES_PORT=8901 uv run hermes-serve`) to avoid fighting it for the port —
killing pm2-managed processes needs explicit permission, it's not something to
do reflexively when a port is "stuck."
