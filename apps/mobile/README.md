# apps/mobile — Dosewise frontend (DEFERRED)

> **Status: not yet built.** This is a placeholder. The frontend is a later pass.

The Dosewise client will be an **Expo + React Native** app with a **dual interface**:

- **Elder voice-first view** — the primary experience: talk (or type) to Hermes in your own dialect; large, simple controls as a graceful fallback if voice fails.
- **Caregiver control view** — a fuller interface for the linked caregiver to monitor adherence, manage medications, and respond to escalations.
- **Onboarding fork** — onboarding branches early into the elder path vs. the caregiver path.

## How it will connect

- **Supabase directly** for data — authenticated with Supabase Auth; all reads/writes are **RLS-scoped** to the signed-in user (patient or caregiver), so the consent model is enforced by the database.
- **The Hermes VPS** for agent turns — the client sends the user's Supabase JWT with each agent request; Hermes verifies it and acts on the user's behalf. The client never calls Claude, OpenFDA, or HuggingFace directly.

See [`../../docs/architecture.md`](../../docs/architecture.md) for the full architecture.
