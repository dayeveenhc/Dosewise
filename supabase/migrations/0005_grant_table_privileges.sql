-- Dosewise — base table privileges for anon/authenticated.
--
-- Discovered missing while wiring apps/web to a real (local CLI) Supabase
-- instance: every table in 0001-0004 only had TRIGGER/TRUNCATE/REFERENCES
-- granted to anon/authenticated, not SELECT/INSERT/UPDATE/DELETE. RLS never
-- even gets evaluated without the base GRANT — Postgres denies at the
-- privilege-check stage first ("permission denied for table", 42501), before
-- any policy runs. This affects every elder-owned table, not just one.
--
-- Base grants are intentionally broad here, matching Supabase's own default
-- project setup: RLS (0002_rls_policies.sql) is the real gate, exactly as
-- documented in docs/architecture.md ("RLS is the consent model"). A grant
-- with no matching policy still returns zero rows / rejects the write.
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

-- Apply the same defaults to any table added by a future migration.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;
