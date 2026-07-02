-- Dosewise — Row-Level Security policies
-- Consent model: an elder owns their data; a caregiver sees ONLY the elders they
-- are ACTIVELY linked to via care_links. Reference tables are readable by any
-- authenticated user; their writes happen via the service role (bypasses RLS).

-- ---------------------------------------------------------------------------
-- Helper: is the current user an ACTIVE caregiver for target_elder?
-- SECURITY DEFINER + fixed search_path avoids RLS recursion when policies on
-- other tables reference care_links. Runs as owner, so it is not itself gated
-- by care_links RLS.
-- ---------------------------------------------------------------------------
create or replace function public.is_linked_caregiver(target_elder uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.care_links cl
    where cl.caregiver_id = auth.uid()
      and cl.elder_id     = target_elder
      and cl.status       = 'active'
  );
$$;

revoke all on function public.is_linked_caregiver(uuid) from public;
grant execute on function public.is_linked_caregiver(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table (deny-by-default until a policy allows).
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.care_links         enable row level security;
alter table public.medications        enable row level security;
alter table public.doses              enable row level security;
alter table public.refills            enable row level security;
alter table public.doctor_questions   enable row level security;
alter table public.conversation_turns enable row level security;
alter table public.dialect_lexicon    enable row level security;
alter table public.drug_cache         enable row level security;
alter table public.instruction_videos enable row level security;

-- ===========================================================================
-- profiles
-- ===========================================================================
-- A user reads their own profile; a linked caregiver reads their elder's profile.
create policy profiles_select_self_or_caregiver
  on public.profiles for select
  to authenticated
  using ( auth.uid() = id or public.is_linked_caregiver(id) );

-- A user can create their own profile row (id must equal their auth uid).
create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check ( auth.uid() = id );

-- A user updates only their own profile.
create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using ( auth.uid() = id )
  with check ( auth.uid() = id );

-- ===========================================================================
-- care_links (the consent anchor)
-- ===========================================================================
-- Either party (elder or caregiver) can see the link.
create policy care_links_select_party
  on public.care_links for select
  to authenticated
  using ( auth.uid() = elder_id or auth.uid() = caregiver_id );

-- A caregiver may create a link naming themselves as the caregiver.
create policy care_links_insert_as_caregiver
  on public.care_links for insert
  to authenticated
  with check ( auth.uid() = caregiver_id );

-- Either party may update the link (e.g. elder activates a pending link,
-- either side revokes). Predicate applies to the existing and resulting row.
create policy care_links_update_party
  on public.care_links for update
  to authenticated
  using ( auth.uid() = elder_id or auth.uid() = caregiver_id )
  with check ( auth.uid() = elder_id or auth.uid() = caregiver_id );

-- ===========================================================================
-- Elder-owned data: owner elder OR active linked caregiver.
-- Same predicate for select / insert / update. Pattern repeated per table.
-- ===========================================================================

-- medications ---------------------------------------------------------------
create policy medications_select_owner_or_caregiver
  on public.medications for select
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy medications_insert_owner_or_caregiver
  on public.medications for insert
  to authenticated
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy medications_update_owner_or_caregiver
  on public.medications for update
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) )
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

-- doses ---------------------------------------------------------------------
create policy doses_select_owner_or_caregiver
  on public.doses for select
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy doses_insert_owner_or_caregiver
  on public.doses for insert
  to authenticated
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy doses_update_owner_or_caregiver
  on public.doses for update
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) )
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

-- refills -------------------------------------------------------------------
create policy refills_select_owner_or_caregiver
  on public.refills for select
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy refills_insert_owner_or_caregiver
  on public.refills for insert
  to authenticated
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy refills_update_owner_or_caregiver
  on public.refills for update
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) )
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

-- doctor_questions ----------------------------------------------------------
create policy doctor_questions_select_owner_or_caregiver
  on public.doctor_questions for select
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy doctor_questions_insert_owner_or_caregiver
  on public.doctor_questions for insert
  to authenticated
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy doctor_questions_update_owner_or_caregiver
  on public.doctor_questions for update
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) )
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

-- conversation_turns --------------------------------------------------------
create policy conversation_turns_select_owner_or_caregiver
  on public.conversation_turns for select
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy conversation_turns_insert_owner_or_caregiver
  on public.conversation_turns for insert
  to authenticated
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

create policy conversation_turns_update_owner_or_caregiver
  on public.conversation_turns for update
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) )
  with check ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

-- ===========================================================================
-- Reference data: readable by any authenticated user.
-- NOTE: no INSERT/UPDATE/DELETE policies here on purpose. Writes to these
-- tables are performed by the service role, which BYPASSES RLS entirely.
-- ===========================================================================
create policy dialect_lexicon_select_authenticated
  on public.dialect_lexicon for select
  to authenticated
  using ( true );

create policy drug_cache_select_authenticated
  on public.drug_cache for select
  to authenticated
  using ( true );

create policy instruction_videos_select_authenticated
  on public.instruction_videos for select
  to authenticated
  using ( true );
