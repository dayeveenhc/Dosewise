-- Dosewise — RLS hardening (defense in depth over 0002).
--
-- 0002 already enables RLS on every table and, because RLS is deny-by-default,
-- DELETE on elder-owned tables and writes to reference tables are *implicitly*
-- forbidden (no policy grants them). This migration makes those denials explicit
-- and, crucially, RESTRICTIVE — a restrictive `using/with check (false)` is ANDed
-- with any future permissive policy, so a later edit can't silently re-open a
-- DELETE or a reference-table write. The service role bypasses RLS entirely, so
-- the sanctioned service-role paths (drug_cache write-through, cron reads, Storage
-- uploads) are unaffected.
--
-- No 0002 policy is altered; this file only adds restrictive denials.

-- ---------------------------------------------------------------------------
-- Elder-owned + consent tables: hard-deny DELETE for authenticated users.
-- (SELECT / INSERT / UPDATE keep their 0002 owner-or-caregiver policies.)
-- ---------------------------------------------------------------------------
create policy profiles_no_delete
  on public.profiles as restrictive for delete
  to authenticated using ( false );

create policy care_links_no_delete
  on public.care_links as restrictive for delete
  to authenticated using ( false );

create policy medications_no_delete
  on public.medications as restrictive for delete
  to authenticated using ( false );

create policy doses_no_delete
  on public.doses as restrictive for delete
  to authenticated using ( false );

create policy refills_no_delete
  on public.refills as restrictive for delete
  to authenticated using ( false );

create policy doctor_questions_no_delete
  on public.doctor_questions as restrictive for delete
  to authenticated using ( false );

create policy conversation_turns_no_delete
  on public.conversation_turns as restrictive for delete
  to authenticated using ( false );

-- ---------------------------------------------------------------------------
-- Reference tables: read-only for authenticated. Writes are service-role only,
-- so hard-deny INSERT / UPDATE / DELETE for authenticated (restrictive so a
-- future permissive write policy can't override this).
-- ---------------------------------------------------------------------------
create policy dialect_lexicon_no_insert
  on public.dialect_lexicon as restrictive for insert
  to authenticated with check ( false );
create policy dialect_lexicon_no_update
  on public.dialect_lexicon as restrictive for update
  to authenticated using ( false );
create policy dialect_lexicon_no_delete
  on public.dialect_lexicon as restrictive for delete
  to authenticated using ( false );

create policy drug_cache_no_insert
  on public.drug_cache as restrictive for insert
  to authenticated with check ( false );
create policy drug_cache_no_update
  on public.drug_cache as restrictive for update
  to authenticated using ( false );
create policy drug_cache_no_delete
  on public.drug_cache as restrictive for delete
  to authenticated using ( false );

create policy instruction_videos_no_insert
  on public.instruction_videos as restrictive for insert
  to authenticated with check ( false );
create policy instruction_videos_no_update
  on public.instruction_videos as restrictive for update
  to authenticated using ( false );
create policy instruction_videos_no_delete
  on public.instruction_videos as restrictive for delete
  to authenticated using ( false );
