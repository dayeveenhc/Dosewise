-- Dosewise — mockup-flavor demo seed (local dev only).
--
-- Distinct from seed.sql's Elder A/B + Caregiver C, which exists purely to
-- prove RLS isolation. This seed recreates the two example patients from the
-- Figma-derived apps/web mockup (Mdm Tan Bee Leng, Mr Wong Kah Wai) with
-- realistic medications, so signing in shows something resembling the
-- original mockup screenshots instead of an empty dashboard.
--
-- WARNING: inserts directly into auth.users. LOCAL DEV ONLY, same caveats as
-- seed.sql (do not run against a hosted project).
--
-- Login (password for all three = "password"):
--   Caregiver — Tan Wei Ming : wm.tan@dosewise.local
--   Elder     — Mdm Tan Bee Leng : tan.beeleng@dosewise.local
--   Elder     — Mr Wong Kah Wai  : wong.kahwai@dosewise.local

-- ---------------------------------------------------------------------------
-- auth.users + auth.identities
-- ---------------------------------------------------------------------------
-- confirmation_token/recovery_token/email_change_token_new/email_change need
-- to be '' not NULL — GoTrue (v2.192.0 tested) 500s on password login
-- otherwise ("Scan error ... converting NULL to string"). Same fix as
-- seed.sql.
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000d0001',
   'authenticated', 'authenticated', 'wm.tan@dosewise.local',
   crypt('password', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Tan Wei Ming"}',
   '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000d0002',
   'authenticated', 'authenticated', 'tan.beeleng@dosewise.local',
   crypt('password', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Mdm Tan Bee Leng"}',
   '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000d0003',
   'authenticated', 'authenticated', 'wong.kahwai@dosewise.local',
   crypt('password', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Mr Wong Kah Wai"}',
   '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
values
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000d0001',
   '00000000-0000-0000-0000-0000000d0001',
   '{"sub":"00000000-0000-0000-0000-0000000d0001","email":"wm.tan@dosewise.local"}',
   'email', now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000d0002',
   '00000000-0000-0000-0000-0000000d0002',
   '{"sub":"00000000-0000-0000-0000-0000000d0002","email":"tan.beeleng@dosewise.local"}',
   'email', now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000d0003',
   '00000000-0000-0000-0000-0000000d0003',
   '{"sub":"00000000-0000-0000-0000-0000000d0003","email":"wong.kahwai@dosewise.local"}',
   'email', now(), now(), now())
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
insert into public.profiles (id, role, full_name, dialect) values
  ('00000000-0000-0000-0000-0000000d0001', 'caregiver', 'Tan Wei Ming',     'en'),
  ('00000000-0000-0000-0000-0000000d0002', 'elder',     'Mdm Tan Bee Leng', 'hokkien'),
  ('00000000-0000-0000-0000-0000000d0003', 'elder',     'Mr Wong Kah Wai',  'en')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- care_links — Tan Wei Ming actively linked to both elders.
-- ---------------------------------------------------------------------------
insert into public.care_links (elder_id, caregiver_id, relationship, status) values
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d0001', 'Son', 'active'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000d0001', 'Son-in-law', 'active')
on conflict (elder_id, caregiver_id) do nothing;

-- ---------------------------------------------------------------------------
-- medications — Mdm Tan Bee Leng
-- ---------------------------------------------------------------------------
insert into public.medications (id, elder_id, name, purpose, dosage, schedule, priority, instructions) values
  ('00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d0002',
   'Metformin', 'Diabetes', '500mg',
   '{"times":["07:00","18:00"],"frequency":"daily"}', 'critical',
   'Take with food or right after eating — prevents stomach upset.'),
  ('00000000-0000-0000-0000-0000000d1002', '00000000-0000-0000-0000-0000000d0002',
   'Amlodipine', 'Blood Pressure', '5mg',
   '{"times":["07:00"],"frequency":"daily"}', 'critical',
   'Take at the same time each day, with or without food.'),
  ('00000000-0000-0000-0000-0000000d1003', '00000000-0000-0000-0000-0000000d0002',
   'Celecoxib', 'Joint Pain', '200mg',
   '{"times":["12:00"],"frequency":"daily"}', 'standard',
   'Take with food to protect your stomach. Do not exceed the prescribed dose.'),
  ('00000000-0000-0000-0000-0000000d1004', '00000000-0000-0000-0000-0000000d0002',
   'Atorvastatin', 'Cholesterol', '20mg',
   '{"times":["21:00"],"frequency":"daily"}', 'standard',
   'Take at night before bed. Avoid grapefruit and grapefruit juice.'),
  ('00000000-0000-0000-0000-0000000d1005', '00000000-0000-0000-0000-0000000d0002',
   'Latanoprost Eye Drops', 'Glaucoma', '1 drop each eye',
   '{"times":["21:00"],"frequency":"daily"}', 'standard',
   'One drop in each eye at bedtime. Tilt head back, look up, squeeze gently.')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- medications — Mr Wong Kah Wai
-- ---------------------------------------------------------------------------
insert into public.medications (id, elder_id, name, purpose, dosage, schedule, priority, instructions) values
  ('00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d0003',
   'Warfarin', 'Blood Thinning', '3mg',
   '{"times":["18:00"],"frequency":"daily"}', 'critical',
   'Take at the same time every day. Keep your diet consistent, especially green vegetables.'),
  ('00000000-0000-0000-0000-0000000d2002', '00000000-0000-0000-0000-0000000d0003',
   'Bisoprolol', 'Heart Rate', '2.5mg',
   '{"times":["08:00"],"frequency":"daily"}', 'critical',
   'Take in the morning. Never stop suddenly without checking with your doctor.'),
  ('00000000-0000-0000-0000-0000000d2003', '00000000-0000-0000-0000-0000000d0003',
   'Latanoprost Eye Drops', 'Glaucoma', '1 drop each eye',
   '{"times":["21:00"],"frequency":"daily"}', 'standard',
   'One drop in each eye at bedtime. Tilt head back, look up, squeeze gently.')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- refills — run_out_forecast relative to today, so "days left" stays sensible
-- whenever this seed is actually run.
-- ---------------------------------------------------------------------------
insert into public.refills (medication_id, elder_id, run_out_forecast) values
  ('00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d0002', current_date + 4),
  ('00000000-0000-0000-0000-0000000d1002', '00000000-0000-0000-0000-0000000d0002', current_date + 21),
  ('00000000-0000-0000-0000-0000000d1003', '00000000-0000-0000-0000-0000000d0002', current_date + 14),
  ('00000000-0000-0000-0000-0000000d1004', '00000000-0000-0000-0000-0000000d0002', current_date + 12),
  ('00000000-0000-0000-0000-0000000d1005', '00000000-0000-0000-0000-0000000d0002', current_date + 3),
  ('00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d0003', current_date + 9),
  ('00000000-0000-0000-0000-0000000d2003', '00000000-0000-0000-0000-0000000d0003', current_date + 3)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- doses — only the ones already "taken today"; everything else is left for
-- the frontend to materialize live from schedule.times (see apps/web/src/app/
-- data/api.ts's fetchMedicationsForElder), so it reads as upcoming/missed
-- correctly no matter what time of day this seed is actually run.
-- ---------------------------------------------------------------------------
insert into public.doses (medication_id, elder_id, scheduled_at, status, logged_at, logged_by) values
  ('00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d0002',
   current_date + time '07:14', 'taken', current_date + time '07:14', '00000000-0000-0000-0000-0000000d0002'),
  ('00000000-0000-0000-0000-0000000d1002', '00000000-0000-0000-0000-0000000d0002',
   current_date + time '07:14', 'taken', current_date + time '07:14', '00000000-0000-0000-0000-0000000d0002'),
  ('00000000-0000-0000-0000-0000000d2002', '00000000-0000-0000-0000-0000000d0003',
   current_date + time '08:02', 'taken', current_date + time '08:02', '00000000-0000-0000-0000-0000000d0003')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- doctor_questions — Mdm Tan Bee Leng (elder-mode "Ask Doctor" tab demo)
-- ---------------------------------------------------------------------------
insert into public.doctor_questions (elder_id, question, source, status) values
  ('00000000-0000-0000-0000-0000000d0002',
   'Can I take Celecoxib and Metformin at the same time?', 'agent', 'open'),
  ('00000000-0000-0000-0000-0000000d0002',
   'Is it normal to feel a little dizzy after taking Amlodipine?', 'agent', 'open')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- caregiver_messages — Care Team Notes demo thread for Mdm Tan Bee Leng.
-- ---------------------------------------------------------------------------
insert into public.caregiver_messages (elder_id, author_id, body, created_at) values
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d0001',
   'Hi Ah Ma, remember your Celecoxib after lunch today. Dr. Priya called — blood test is next Tuesday at 10am.',
   now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d0002',
   'Ok ok, I will remember. Thank you ah.',
   now() - interval '90 minutes')
on conflict do nothing;
