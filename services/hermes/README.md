# services/hermes — Dosewise orchestrator (DEFERRED)

> **Status: not yet built.** This is a placeholder. The Hermes orchestrator is a later pass.

**Hermes** is the AI orchestrator and the **security boundary** of Dosewise. It will be a **Python 3.12 + FastAPI** service running on a **private VPS** (recommended: Render / Railway for simplicity, or a Hetzner / DigitalOcean droplet for full control). It holds **all external API keys** — the client never talks to Claude, OpenFDA, or HuggingFace directly.

The AI brain is **Claude Sonnet 5** (`claude-sonnet-5`) via the official `anthropic` Python SDK.

## Deferred responsibilities

- **Tool belt** — implement the agent contract: `log_dose()`, `list_medications()`, `get_drug_info()`, `add_doctor_question()`, `message_caregiver()`, `show_instruction_video()`, `request_human_help()`, `add_prescription()`.
- **Tool-calling loop** — run the Claude Sonnet 5 conversation + tool-use loop with adaptive thinking.
- **JWT verification + user-JWT forwarding** — verify the incoming Supabase JWT and call Supabase **as the user** (forwarding the JWT) so **RLS** applies. Use the service-role key **only** for cron jobs and privileged writes after human confirmation.
- **Scan → confirm vision** — use Claude vision to read prescription scans and **propose** entries; commit only after human confirmation (scan proposes, never commits).
- **OpenFDA grounding** — fetch authoritative drug facts and cache them in Postgres (`drug_cache`).
- **Reminders cron** — scheduler that computes due doses and drives Expo Push notifications.
- **HuggingFace voice (stretch)** — STT / translate / TTS for voice and dialect; the competition demo is text-first.

## Safety rails Hermes enforces

Scan = propose never commit · explain never diagnose · grounded in OpenFDA · uncertainty → escalation log · RLS + audit log · human-in-the-loop · graceful fallback · bridge to people, not a replacement.

See [`../../docs/architecture.md`](../../docs/architecture.md) for the full architecture and the RLS-with-external-orchestrator model.
