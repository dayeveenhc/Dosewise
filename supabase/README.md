# Dosewise — Supabase Backend

Backend for Dosewise, an agent-first medication app for elderly patients and
their caregivers. This directory holds the database schema, Row-Level Security
(RLS) policies, seed data, and Supabase CLI config. No app/agent code lives here.

## Layout

```
supabase/
  config.toml                    # Supabase CLI config (project_id "dosewise")
  migrations/
    0001_init_schema.sql         # enums, 10 tables, indexes, updated_at triggers
    0002_rls_policies.sql        # RLS enable + policies + is_linked_caregiver()
  seed/
    seed.sql                     # local-dev seed (proves the consent model)
```

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- Docker running (the local stack runs in containers)

## Apply locally

```bash
# from the repo root
supabase start          # boot local Postgres + Auth + Studio, etc.
supabase db reset       # apply migrations/ in order, THEN run seed/seed.sql
```

`supabase db reset` recreates the local database, replays every file in
`migrations/` in filename order, and finally executes the seed configured under
`[db.seed]` in `config.toml`. Studio is at http://127.0.0.1:54323.

## The consent model (RLS via `care_links`)

Consent is anchored in the **`care_links`** table. Every piece of an elder's
health data (medications, doses, refills, doctor questions, conversation turns)
is readable by:

1. the **owner elder** (`auth.uid() = elder_id`), or
2. a caregiver who is **actively linked** to that elder
   (`public.is_linked_caregiver(elder_id)` — an active row in `care_links`).

`is_linked_caregiver` is a `SECURITY DEFINER` function with a fixed
`search_path`; it runs as the function owner so policies on other tables can
consult `care_links` without triggering RLS recursion.

Reference tables (`drug_cache`, `dialect_lexicon`, `instruction_videos`) are
readable by any authenticated user. They have **no** insert/update/delete
policies — those writes are done with the **service role**, which bypasses RLS.

### RLS isolation is provable from the seed

- Caregiver **C** is actively linked to Elder **A** → C can read A's meds/doses.
- Caregiver **C** is **not** linked to Elder **B** → C cannot read B's data.

Seeded local users (password `password` for all, local dev only):

| User        | Email                       | Role      |
|-------------|-----------------------------|-----------|
| Elder A     | elder.a@dosewise.local      | elder     |
| Elder B     | elder.b@dosewise.local      | elder     |
| Caregiver C | caregiver.c@dosewise.local  | caregiver |

## Credentials

Never commit real credentials. Copy `.env.example` (at the repo root) to a
git-ignored `.env` and supply your own project values:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
```

`supabase start` prints local anon/service keys and the JWT secret for local dev.

## Notes / deferred

- **pgvector is deferred.** The `vector` extension is intentionally not enabled
  to keep migrations portable. `dialect_lexicon` has a `-- TODO` marker where a
  semantic-matching embedding column can be added later.
- The seed writes directly into `auth.users` / `auth.identities`. This is
  **local dev only** and targets the current GoTrue/local schema; column sets
  can vary between Supabase versions (see caveats in `seed/seed.sql`).
