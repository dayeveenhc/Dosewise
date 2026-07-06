-- Dosewise — local-dev seed data.
-- Exercises the consent model so a test can prove RLS isolation:
--   Caregiver C is linked to Elder A (active) but NOT to Elder B.
--   => C can read A's meds/doses, but MUST NOT read B's.
--
-- WARNING: This inserts directly into auth.users. LOCAL DEV ONLY.
-- Do not run against a hosted Supabase project. Column set targets the
-- GoTrue/local schema; adjust if your Supabase CLI version differs.
--
-- Fixed, readable UUIDs:
--   Elder A     : 00000000-0000-0000-0000-00000000000a
--   Elder B     : 00000000-0000-0000-0000-00000000000b
--   Caregiver C : 00000000-0000-0000-0000-00000000000c

-- ---------------------------------------------------------------------------
-- auth.users (local dev only)
-- password for all three = "password" (bcrypt hash below). role/aud must be
-- 'authenticated' for the anon/authenticated JWT flow to work locally.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000a',
   'authenticated', 'authenticated', 'elder.a@dosewise.local',
   crypt('password', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Elder A"}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000b',
   'authenticated', 'authenticated', 'elder.b@dosewise.local',
   crypt('password', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Elder B"}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000c',
   'authenticated', 'authenticated', 'caregiver.c@dosewise.local',
   crypt('password', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Caregiver C"}')
on conflict (id) do nothing;

-- Email identities so local email/password login works (GoTrue requires an
-- identity row per user). provider_id must be unique per provider.
insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
values
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-00000000000a',
   '{"sub":"00000000-0000-0000-0000-00000000000a","email":"elder.a@dosewise.local"}',
   'email', now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000b',
   '00000000-0000-0000-0000-00000000000b',
   '{"sub":"00000000-0000-0000-0000-00000000000b","email":"elder.b@dosewise.local"}',
   'email', now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000c',
   '00000000-0000-0000-0000-00000000000c',
   '{"sub":"00000000-0000-0000-0000-00000000000c","email":"caregiver.c@dosewise.local"}',
   'email', now(), now(), now())
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
insert into public.profiles (id, role, full_name, dialect, accessibility) values
  ('00000000-0000-0000-0000-00000000000a', 'elder',     'Elder A',     'hokkien',
   '{"font_scale":1.5,"tts_default":true}'),
  ('00000000-0000-0000-0000-00000000000b', 'elder',     'Elder B',     'tamil',
   '{"font_scale":1.25,"tts_default":true}'),
  ('00000000-0000-0000-0000-00000000000c', 'caregiver', 'Caregiver C', 'en',
   '{"font_scale":1.0,"tts_default":false}')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- care_links — C is ACTIVE caregiver for A only. (No link to B => RLS proof.)
-- ---------------------------------------------------------------------------
insert into public.care_links (id, elder_id, caregiver_id, relationship, permissions, status) values
  ('00000000-0000-0000-0000-0000000c0a01',
   '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-00000000000c',
   'daughter',
   '{"view_meds":true,"view_doses":true,"quiet_hours":{"start":"22:00","end":"07:00"},"alert_on_missed_critical":true}',
   'active')
on conflict (elder_id, caregiver_id) do nothing;

-- ---------------------------------------------------------------------------
-- medications — for BOTH elders.
--   Elder A meds : ...a-med1 (critical), ...a-med2 (vitamin)
--   Elder B meds : ...b-med1 (standard)
-- ---------------------------------------------------------------------------
insert into public.medications
  (id, elder_id, name, purpose, dosage, schedule, priority, instructions) values
  ('00000000-0000-0000-0000-00000a0e0d01',
   '00000000-0000-0000-0000-00000000000a',
   'Metformin', 'Blood sugar control', '500mg',
   '{"times":["08:00","20:00"],"frequency":"daily"}', 'critical',
   'Take after a meal — it works better and is gentler on your stomach.'),
  ('00000000-0000-0000-0000-00000a0e0d02',
   '00000000-0000-0000-0000-00000000000a',
   'Vitamin D3', 'Bone health', '1000 IU',
   '{"times":["08:00"],"frequency":"daily"}', 'vitamin',
   'Take once in the morning with breakfast.'),
  ('00000000-0000-0000-0000-00000b0e0d01',
   '00000000-0000-0000-0000-00000000000b',
   'Amlodipine', 'Blood pressure', '5mg',
   '{"times":["09:00"],"frequency":"daily"}', 'standard',
   'Take once a day, morning is best. It helps keep blood pressure steady.')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- doses — a scheduled instance per elder med (fixed times for repeatable tests).
-- ---------------------------------------------------------------------------
insert into public.doses (id, medication_id, elder_id, scheduled_at, status) values
  ('00000000-0000-0000-0000-00000a0d0501',
   '00000000-0000-0000-0000-00000a0e0d01', '00000000-0000-0000-0000-00000000000a',
   '2026-07-02 08:00:00+00', 'taken'),
  ('00000000-0000-0000-0000-00000a0d0502',
   '00000000-0000-0000-0000-00000a0e0d01', '00000000-0000-0000-0000-00000000000a',
   '2026-07-02 20:00:00+00', 'pending'),
  ('00000000-0000-0000-0000-00000a0d0503',
   '00000000-0000-0000-0000-00000a0e0d02', '00000000-0000-0000-0000-00000000000a',
   '2026-07-02 08:00:00+00', 'taken'),
  ('00000000-0000-0000-0000-00000b0d0501',
   '00000000-0000-0000-0000-00000b0e0d01', '00000000-0000-0000-0000-00000000000b',
   '2026-07-02 09:00:00+00', 'pending')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- A little reference data so authenticated reads return something.
-- ---------------------------------------------------------------------------
insert into public.dialect_lexicon (dialect, term, normalized_en, mapping) values
  ('hokkien', 'pang sai',  'bowel movement', '{"category":"symptom"}'),
  ('tamil',   'maruthuvam','medicine',       '{"category":"general"}')
on conflict do nothing;

insert into public.instruction_videos (title, technique, storage_path, drug_match) values
  ('How to use eye drops', 'eye_drops', 'videos/eye_drops.mp4', '{}'),
  ('How to use an inhaler', 'inhaler',  'videos/inhaler.mp4',   '{}')
on conflict do nothing;
