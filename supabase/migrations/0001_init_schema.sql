-- Dosewise — initial schema
-- Agent-first medication app for elderly patients + caregivers.
-- This migration defines: ENUM types, 10 tables, indexes, and updated_at triggers.
-- RLS is enabled/policied separately in 0002_rls_policies.sql.

-- pgcrypto provides gen_random_uuid(). Available by default on Supabase; enable defensively.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- ENUM types (create before any table uses them)
-- ---------------------------------------------------------------------------
create type public.user_role         as enum ('elder', 'caregiver');
create type public.care_link_status  as enum ('pending', 'active', 'revoked');
create type public.med_priority      as enum ('critical', 'standard', 'vitamin');
create type public.dose_status       as enum ('pending', 'taken', 'skipped');
create type public.question_source   as enum ('agent', 'elder', 'caregiver');
create type public.question_status   as enum ('open', 'answered', 'dismissed');
create type public.turn_speaker      as enum ('user', 'assistant', 'system');

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. profiles — one row per app user, keyed to Supabase Auth.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          public.user_role not null,
  full_name     text,
  dialect       text,                                  -- 'en','ms','zh','hokkien','teochew','cantonese','tamil'
  accessibility jsonb not null default '{}'::jsonb,     -- font scale, tts-default, reminder prefs
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. care_links — elder <-> caregiver relationship + permissions. CONSENT ANCHOR.
-- ---------------------------------------------------------------------------
create table public.care_links (
  id           uuid primary key default gen_random_uuid(),
  elder_id     uuid not null references public.profiles(id) on delete cascade,
  caregiver_id uuid not null references public.profiles(id) on delete cascade,
  relationship text,                                   -- 'daughter','son','domestic_helper'
  permissions  jsonb not null default '{}'::jsonb,      -- visibility, quiet hours, alert triggers
  status       public.care_link_status not null default 'active',
  created_at   timestamptz not null default now(),
  unique (elder_id, caregiver_id)
);

create index idx_care_links_caregiver on public.care_links (caregiver_id, status);
create index idx_care_links_elder      on public.care_links (elder_id, status);

-- ---------------------------------------------------------------------------
-- 3. medications — owned by an elder.
-- ---------------------------------------------------------------------------
create table public.medications (
  id             uuid primary key default gen_random_uuid(),
  elder_id       uuid not null references public.profiles(id) on delete cascade,
  name           text not null,
  purpose        text,
  dosage         text,
  schedule       jsonb not null default '{}'::jsonb,    -- times/frequency
  priority       public.med_priority not null default 'standard',
  pill_photo_path text,                                 -- Supabase Storage object path
  instructions   text,                                  -- plain-language "take after a meal" + why
  verified_by    uuid references public.profiles(id),
  verified_at    timestamptz,
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_medications_elder on public.medications (elder_id) where archived = false;

create trigger trg_medications_updated_at
  before update on public.medications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. doses — scheduled instances of a medication.
-- ---------------------------------------------------------------------------
create table public.doses (
  id            uuid primary key default gen_random_uuid(),
  medication_id uuid not null references public.medications(id) on delete cascade,
  elder_id      uuid not null references public.profiles(id) on delete cascade,  -- denormalized for RLS
  scheduled_at  timestamptz not null,
  status        public.dose_status not null default 'pending',
  logged_at     timestamptz,
  logged_by     uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);

create index idx_doses_elder_scheduled on public.doses (elder_id, scheduled_at);
create index idx_doses_medication       on public.doses (medication_id);

-- ---------------------------------------------------------------------------
-- 5. refills
-- ---------------------------------------------------------------------------
create table public.refills (
  id               uuid primary key default gen_random_uuid(),
  medication_id    uuid not null references public.medications(id) on delete cascade,
  elder_id         uuid not null references public.profiles(id) on delete cascade,
  pills_remaining  int,
  threshold        int,
  run_out_forecast date,
  updated_at       timestamptz not null default now()
);

create index idx_refills_elder on public.refills (elder_id);

create trigger trg_refills_updated_at
  before update on public.refills
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. doctor_questions — escalation log.
-- ---------------------------------------------------------------------------
create table public.doctor_questions (
  id         uuid primary key default gen_random_uuid(),
  elder_id   uuid not null references public.profiles(id) on delete cascade,
  question   text not null,
  context    jsonb not null default '{}'::jsonb,
  source     public.question_source not null default 'agent',
  status     public.question_status not null default 'open',
  created_at timestamptz not null default now()
);

create index idx_doctor_questions_elder on public.doctor_questions (elder_id, status);

-- ---------------------------------------------------------------------------
-- 7. conversation_turns — agent memory (JSONB-heavy).
-- ---------------------------------------------------------------------------
create table public.conversation_turns (
  id         uuid primary key default gen_random_uuid(),
  elder_id   uuid not null references public.profiles(id) on delete cascade,
  speaker    public.turn_speaker not null,
  transcript text,
  intent     text,
  tool       text,
  outcome    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_conversation_turns_elder on public.conversation_turns (elder_id, created_at);

-- ---------------------------------------------------------------------------
-- 8. dialect_lexicon — reference data (slang/dialect -> normalized English).
-- ---------------------------------------------------------------------------
create table public.dialect_lexicon (
  id           uuid primary key default gen_random_uuid(),
  dialect      text not null,
  term         text not null,
  normalized_en text,
  mapping      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
-- TODO (later): optional pgvector embedding column for semantic dialect matching

create index idx_dialect_lexicon_dialect_term on public.dialect_lexicon (dialect, term);

-- ---------------------------------------------------------------------------
-- 9. drug_cache — cached OpenFDA label data.
-- ---------------------------------------------------------------------------
create table public.drug_cache (
  id              uuid primary key default gen_random_uuid(),
  drug_key        text not null unique,                 -- normalized drug name
  openfda_payload jsonb not null,
  fetched_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. instruction_videos — how-to clips (eye drops, inhalers) in Storage.
-- ---------------------------------------------------------------------------
create table public.instruction_videos (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  technique    text,                                    -- 'eye_drops','inhaler','ointment'
  storage_path text not null,
  drug_match   text[] not null default '{}',
  created_at   timestamptz not null default now()
);

create index idx_instruction_videos_technique on public.instruction_videos (technique);
