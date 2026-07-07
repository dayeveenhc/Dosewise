# CLAUDE.md — apps/web

## Context
This is a monorepo. apps/web is the Vite + React 18 + Tailwind + shadcn/ui 
frontend. The Supabase backend and services/hermes (FastAPI orchestrator) 
are already built and working end-to-end via a Telegram bot integration. 
apps/web's UI is built but not yet connected to either.

## Ownership boundaries
- I own: apps/web only.
- Do NOT edit files in supabase/ or services/hermes/ — read them for 
  context (contracts, schemas, auth patterns) but never modify them.
- If a task seems to require backend changes, stop and tell me instead 
  of making the change yourself.

## Before writing code
- Always read existing code in the area you're about to touch before 
  writing anything new. Match existing naming, file structure, and 
  formatting conventions exactly.
- If wiring something to Hermes or Supabase, check how the Telegram bot 
  integration does it first, and mirror that contract (endpoints, auth 
  headers, error shapes, response parsing).
- For any non-trivial task, give me a short plan (files touched, 
  approach) before writing code. Wait for confirmation.

## Code style
- No new dependencies unless I explicitly approve them. Use what's 
  already in package.json.
- No new state management patterns, folder structures, or abstractions 
  invented on the spot — extend what exists.
- Comment only non-obvious logic. No comment-per-line, no restating 
  what the code already says.
- Keep diffs surgical: don't rename, reformat, or "clean up" files or 
  code outside the scope of the current task.
- Match existing TypeScript/JS conventions (e.g. function vs arrow 
  components, named vs default exports) — check a neighboring file 
  before deciding.

## Environment / secrets
- Never hardcode API keys, Supabase URLs, or Hermes endpoints — use 
  environment variables, matching whatever .env pattern already exists.
- Never commit .env files or print their contents.

## When unsure
- If you're not sure whether something is in scope, ask rather than 
  guessing.
- If you find messy/inconsistent code while working, don't fix it 
  silently — flag it to me and let me decide.