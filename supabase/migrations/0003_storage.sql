-- Dosewise — Storage buckets + policies.
--
-- Two buckets back the `storage_path` columns already in the schema:
--   * instruction_videos.storage_path -> `videos`      (how-to clips, shared)
--   * medications.pill_photo_path     -> `pill-photos` (per-elder, private)
--
-- Both buckets are private (no public URLs). Access mirrors the table RLS:
--   * videos: readable by any authenticated user (like instruction_videos).
--   * pill-photos: readable/writable by the owning elder OR an active linked
--     caregiver — same consent predicate as medications, keyed on the object's
--     top-level folder being the elder's uuid: `<elder_id>/<filename>`.
--
-- Privileged writes from Hermes use the service role, which BYPASSES RLS, so the
-- policies below only need to cover interactive (authenticated) access.

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('videos', 'videos', false),
  ('pill-photos', 'pill-photos', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- videos — shared how-to content, readable by any authenticated user.
-- Writes happen via the service role (bypasses RLS), so no write policy here.
-- ---------------------------------------------------------------------------
create policy videos_read_authenticated
  on storage.objects for select
  to authenticated
  using ( bucket_id = 'videos' );

-- ---------------------------------------------------------------------------
-- pill-photos — private per elder. Path convention: `<elder_id>/<filename>`.
-- The first path segment is the elder's uuid; access = owner or linked caregiver.
-- ---------------------------------------------------------------------------
create policy pill_photos_read_owner_or_caregiver
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'pill-photos'
    and (
      (storage.foldername(name))[1]::uuid = auth.uid()
      or public.is_linked_caregiver((storage.foldername(name))[1]::uuid)
    )
  );

create policy pill_photos_insert_owner_or_caregiver
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'pill-photos'
    and (
      (storage.foldername(name))[1]::uuid = auth.uid()
      or public.is_linked_caregiver((storage.foldername(name))[1]::uuid)
    )
  );

create policy pill_photos_update_owner_or_caregiver
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'pill-photos'
    and (
      (storage.foldername(name))[1]::uuid = auth.uid()
      or public.is_linked_caregiver((storage.foldername(name))[1]::uuid)
    )
  );
