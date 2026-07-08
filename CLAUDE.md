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
  breaks the other.
- `supabase/` — schema, RLS policies, seed data. RLS is the consent model;
  don't loosen a policy without understanding why it's restrictive.

## Before running destructive git commands

This repo has a pm2-managed production Hermes process running on this box
(`pm2 list`) — see `MEMORY.md` for the port-8000 gotcha. Don't kill or restart
it without checking first; use a different port for local verification.
