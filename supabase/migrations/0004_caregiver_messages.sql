-- Dosewise — caregiver_messages: human-to-human notes on an elder's care thread.
--
-- Distinct from conversation_turns (agent memory): this is the "Care Team
-- Notes" thread — a caregiver or the elder leaving a note for the other
-- humans on the care team, not an agent interaction. Same consent predicate
-- as every other elder-owned table: owner elder OR an active linked caregiver.

create table public.caregiver_messages (
  id         uuid primary key default gen_random_uuid(),
  elder_id   uuid not null references public.profiles(id) on delete cascade,
  author_id  uuid not null references public.profiles(id),
  body       text not null,
  created_at timestamptz not null default now()
);

create index idx_caregiver_messages_elder on public.caregiver_messages (elder_id, created_at);

alter table public.caregiver_messages enable row level security;

create policy caregiver_messages_select_owner_or_caregiver
  on public.caregiver_messages for select
  to authenticated
  using ( auth.uid() = elder_id or public.is_linked_caregiver(elder_id) );

-- Either the elder or an active linked caregiver may post, but only as themselves.
create policy caregiver_messages_insert_owner_or_caregiver
  on public.caregiver_messages for insert
  to authenticated
  with check (
    auth.uid() = author_id
    and (auth.uid() = elder_id or public.is_linked_caregiver(elder_id))
  );
