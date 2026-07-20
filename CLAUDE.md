# CLAUDE.md — Dosewise (repo root)

**Before doing any non-trivial work, read `CONTEXT.md` and `MEMORY.md` in this
directory.** `CONTEXT.md` is the current-state architecture snapshot; `MEMORY.md`
is the dated log of decisions and non-obvious gotchas already discovered — don't
rediscover them from scratch (e.g. re-debugging a fixed auth/CORS issue).

Keep both files up to date as you work:
- `CONTEXT.md` — update when the architecture or "what exists" changes.
- `MEMORY.md` — append a dated entry for any non-obvious fix, decision, or
  gotcha a future session would otherwise waste time rediscovering. Keep it a
  memory aid: short entries, prune/consolidate stale ones rather than letting
  it grow forever.

## Ownership boundaries

- `apps/web/` has its own `CLAUDE.md` with stricter rules (notably: normally
  forbids editing `services/hermes/` or `supabase/` from within that scope).
  Read it before touching that directory. Cross-cutting work across that
  boundary needs the user's explicit go-ahead, not an assumption.
- `services/hermes/` is the security boundary — it holds all external API
  keys and is the only thing that talks to the LLM/OpenFDA/HuggingFace/Supabase
  service-role key. Changes here affect **both** the web app and the Telegram
  testbed channel (`CONTEXT.md` explains why) — keep changes additive to the
  shared `run_agent_turn` core, don't special-case one channel in a way that
  breaks the other. `api/bodylimit.py`'s `MaxBodySizeMiddleware` enforces a
  hard request-body-size ceiling (`hermes_max_body_bytes`) — it's a raw ASGI
  middleware, not `@app.middleware("http")`, on purpose (see its docstring:
  `BaseHTTPMiddleware`'s request-caching wrapper silently empties any body a
  dispatch function reads via `Request.stream()`).
- `supabase/` — schema, RLS policies, seed data. RLS is the consent model;
  don't loosen a policy without understanding why it's restrictive. `care_links`
  is the consent anchor (migration `0005`): new caregiver links land `pending`,
  not `active` — only the elder can activate their own row, and a caregiver
  can only ever move a link to `revoked`, never back to `active`. Don't merge
  `care_links_update_by_elder`/`care_links_update_by_caregiver` back into one
  policy — that reopens the self-reactivation bug `0005` fixed.

## Security verification methodology (established, reuse rather than reinvent)

Two audit passes exist: `docs/security-verification-2026-07-12.md` (round 1 —
found and fixed the `care_links` consent bugs, missing `/profile/extract`
rate limit, unguarded base64 decode, JWT error-detail leak) and
`docs/security-verification-round2-2026-07-12.md` (round 2 — verified the
remaining write-RLS/Storage/apikey/Telegram-webhook/JWT-edge-case surfaces,
all clean, plus the request-body-size fix). The pattern, if extending this
further: stand up an **isolated local Supabase** (`npx supabase@latest start`
+ `db reset` — never `supabase link`, never touch the hosted project), divide
verification across subagents by attack surface, and write every test as
"assert the secure behavior, prove it fails before a fix and passes after."
A fresh local Supabase CLI stack needs a **manual baseline-GRANT workaround**
(`MEMORY.md`'s 2026-07-12 entries have the exact command) before RLS tests can
even reach PostgREST — this is scoped to the local container only and needs a
**fresh** user authorization every time a new instance is stood up (the
harness won't carry a prior instance's authorization forward automatically).

## Before running destructive git commands

This repo has a pm2-managed production Hermes process running on this box
(`pm2 list`) — see `MEMORY.md` for the port-8000 gotcha. Don't kill or restart
it without checking first; use a different port for local verification.

## Power-On Self-Test (POST) — run on EVERY backend restart / system reset

**Policy:** whenever you restart the backend (Hermes) or reset the whole system,
run the POST **before declaring the work done**. It guarantees the things that
have repeatedly bitten us: no port conflicts, no orphaned Hermes processes, no
Telegram `409` double-poller, no `[Errno 98] Address already in use`, and that
every layer is up and the agent path is reachable.

```bash
bash scripts/post.sh            # full POST: resets backends, starts tunnels/frontend, runs the test suite
bash scripts/post.sh --quick    # read-only health checks, no services touched
```

What it does, in order (`scripts/post.sh`):

1. **Clean slate** — `pm2 stop hermes hermes-demo`, then kill every orphaned
   Hermes python process (those reparented to init — PPID `1`, e.g. leaked
   `--multiprocessing-fork` children), then force ports `8000` and `5010` free.
   This is the durable fix for the port-8000 restart storm.
2. **Start backends** — `pm2 restart hermes` (`:8000`, has the Telegram token →
   sole poller) and `hermes-demo` (`:5010`, the web demo backend, empty token).
3. **Tunnels** — start the ngrok backend (fixed domain
   `neomi-unimprinted-shelton.ngrok-free.dev` → `:5010`) and frontend
   (→ `:5173`) **only if down**, so existing random frontend URLs are preserved.
4. **Frontend** — start Vite on `:5173` only if it is down.
5. **Checks** — `/health` 200 on both ports · no PPID-1 Hermes orphans · ports
   held by exactly the expected `hermes-serve` · backend ngrok reachable ·
   `/agent/turn` reachable (`401` without a JWT = OK, proves CORS preflight +
   API-key gate) · frontend served over its public URL · no `409` /
   `Address already in use` in the prod log · restart count flat over two
   samples (no storm) · all pm2 apps `online`.
6. **Feature validation** — runs `uv run pytest -q -m "not integration"` to
   exercise the full tool belt + safety rails offline (the per-feature check;
   skipped with `--quick`).

Exit code `0` = every check passed. **Do not consider a backend restart or
system reset complete until POST is green.** Re-running it is safe (idempotent).

The chronic offender this exists to prevent was an orphaned
`--multiprocessing-fork` child (from the scheduler) that survived its parent and
kept holding `:8000`; the cleanup phase removes exactly that class of leak each
time.
