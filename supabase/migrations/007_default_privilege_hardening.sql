-- OG VOICE — Migration 007: close inherited TRUNCATE/REFERENCES/TRIGGER on new tables
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Migration 005 revoked TRUNCATE, REFERENCES and TRIGGER from `anon` and
-- `authenticated` on every table that existed at the time, and the repository's
-- static migration tests still pass. Both are true, and the database was still
-- vulnerable, because of something a static test cannot see:
--
--   Supabase ships default privileges for tables created by `postgres` in
--   `public` of  {anon=Dxtm, authenticated=rDxtm}.
--
-- `Dxt` is TRUNCATE, REFERENCES, TRIGGER. So 005 cleaned the tables that
-- existed, but every table created AFTER it silently re-inherited those three
-- privileges. Verified live after applying 006, the affected tables were
-- exactly the four owner-facing voice tables:
--
--   voice_server_configs, voice_rooms, voice_groups, voice_service_health
--
-- TRUNCATE bypasses row level security. With it, an `anon` or `authenticated`
-- session holding a direct Postgres connection could empty voice configuration
-- for every account on the platform. The six credential-bearing voice tables
-- were unaffected only because 006 revoked from them explicitly.
--
-- Scoping the claim honestly: PostgREST exposes GET/POST/PATCH/DELETE, not
-- TRUNCATE, so this was not reachable through the anon-key REST API. It needed
-- a direct database connection as one of those roles. That is a smaller blast
-- radius than "anyone on the internet", and it is still a defect worth closing.
--
-- THE FIX, in two parts, because fixing only the tables would leave the next
-- migration to reopen the hole:
--   1. Change the default ACL, so tables created from now on do not inherit it.
--   2. Revoke from every existing public table, generically, so this is
--      idempotent and covers tables added by any future migration.

-- ---------------------------------------------------------------------------
-- 1. Stop future tables inheriting the dangerous privileges.
--    SELECT for `authenticated` is deliberately kept: the browser is read-only
--    and RLS does the scoping, which is the model 005 established.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated;

alter default privileges for role postgres in schema public
  grant select on tables to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tighten every existing public table.
--    Written as a loop rather than a table list so it cannot go stale: a table
--    added by a later migration is covered the moment this runs again, and
--    re-running it is harmless.
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    -- anon gets nothing at all on any public table except the one public
    -- catalogue re-granted below.
    execute format('revoke all on table public.%I from anon', t.relname);
    -- authenticated keeps SELECT but loses TRUNCATE, REFERENCES and TRIGGER.
    execute format(
      'revoke truncate, references, trigger on table public.%I from authenticated',
      t.relname
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Restore the two intentional grants that the loop above removed.
-- ---------------------------------------------------------------------------

-- The browser role is read-only across the schema; RLS scopes rows to the owner.
grant select on all tables in schema public to authenticated;

-- The only table an unauthenticated visitor may read: the seeded catalogue of
-- network providers shown on the public landing page. It holds no user data.
grant select on table public.network_providers to anon;
