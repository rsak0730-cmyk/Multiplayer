-- OG HOST — Migration 005: Role privileges (CRITICAL SECURITY + FUNCTIONALITY FIX)
-- ============================================================================
-- WHY THIS MIGRATION EXISTS
--
-- An audit of the live "og-host" project (ref chhttgriyauqlracclkm) found that
-- the three Supabase API roles held ONLY `Dxt` — TRUNCATE, REFERENCES and
-- TRIGGER — on every table in public, and had NO SELECT/INSERT/UPDATE/DELETE:
--
--     postgres=arwdDxtm/postgres
--     anon=Dxtm/postgres
--     authenticated=Dxtm/postgres
--     service_role=Dxtm/postgres
--
-- Two separate consequences, both serious:
--
-- 1. FUNCTIONAL. The app could not work at all. Dashboard pages query through
--    the anon key with a user JWT (role `authenticated`) and every read failed
--    with "permission denied for table nodes". API routes use the service-role
--    key and every write failed too — pairing, heartbeat, command polling, all
--    of it. RLS policies were present and correct but unreachable, because a
--    policy only filters rows a role is already allowed to touch.
--
-- 2. SECURITY. TRUNCATE was granted to `anon` and `authenticated`.
--    TRUNCATE BYPASSES ROW LEVEL SECURITY. A role holding it can empty a table
--    outright, including every row owned by other accounts — exactly the
--    cross-account destruction this platform must never allow. TRIGGER is also
--    dangerous to hand to an untrusted role, since it permits attaching code to
--    a table; REFERENCES has no legitimate client use here.
--
--    Honest scoping of that risk: PostgREST exposes GET/POST/PATCH/DELETE, not
--    TRUNCATE, so this was NOT reachable through the ordinary REST API with an
--    anon key. It was reachable by anything holding a direct Postgres
--    connection as those roles, and it is precisely the kind of standing
--    privilege that turns a later mistake into data loss. It is revoked here.
--
-- WHAT THIS DOES
--   service_role  -> SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER (server-side
--                    key only; has BYPASSRLS, so ownership is enforced in the
--                    API routes, which is where it already happens)
--   authenticated -> SELECT only, on everything. RLS scopes each user to their
--                    own rows. No writes: the browser never writes, every
--                    mutation goes through an API route that re-checks ownership.
--   anon          -> SELECT on network_providers only (the public catalogue).
--                    Nothing else.
--
-- Idempotent: it revokes everything from the two untrusted roles first, so it
-- converges on a known state no matter what the starting grants were.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Reset the untrusted roles to a known-empty state, then grant minimally.
--    REVOKE ALL covers TRUNCATE/REFERENCES/TRIGGER without needing per-relation
--    privilege-type checks (TRUNCATE is not valid on a view, so a blanket
--    REVOKE ALL is both simpler and correct for tables and views alike).
-- ---------------------------------------------------------------------------
do $$
declare
  rel record;
begin
  for rel in
    select c.oid::regclass::text as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm')
  loop
    execute format('revoke all on table %s from anon, authenticated', rel.name);
  end loop;
end;
$$;

revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. authenticated: read-only. Row Level Security does the owner scoping.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- 3. anon: the public network-provider catalogue only.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon;
grant select on public.network_providers to anon;

-- ---------------------------------------------------------------------------
-- 4. service_role: full DML for the server-side API routes.
--    TRUNCATE is deliberately left untouched here. service_role is a secret key
--    that never reaches a browser, and the Supabase Studio table editor needs
--    TRUNCATE to remain usable by the project owner.
-- ---------------------------------------------------------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete, references, trigger
  on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- 5. Default privileges, so tables created by FUTURE migrations are granted
--    correctly instead of inheriting whatever was in force when they are made.
--    Note what is absent: no TRUNCATE, REFERENCES or TRIGGER for anon or
--    authenticated, and no writes for authenticated.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  grant select on tables to authenticated;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete, references, trigger on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role, authenticated;
