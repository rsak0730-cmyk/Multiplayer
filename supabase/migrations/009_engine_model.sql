-- Multi-device, multi-engine hosting — Migration 009: the engine model
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- OG HOST today can only describe one kind of server: official Bedrock Dedicated
-- Server on a Windows node. Two things in the live schema make that a hard limit
-- rather than a missing feature:
--
--   1. `servers.game_type` carries CHECK ((game_type = 'bedrock')). A Java engine
--      cannot be inserted at all — the database rejects the row.
--   2. `servers` has no engine column. "Bedrock" is a protocol family, not an
--      engine: BDS, PowerNukkitX and PocketMine-MP all speak it and share almost
--      nothing else (runtime, world format, plugin model, console grammar).
--
-- Everything here is additive. No column is dropped or retyped, no row changes
-- meaning, and every existing server becomes engine_id = 'bds' — which is a true
-- statement about it, not a guess, because 'bedrock' was the only value the old
-- CHECK allowed and the Windows agent only ever launches bedrock_server.exe.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- Adding these columns does not make any engine work. The engine catalog in
-- packages/shared/src/engines.ts records the honest status of each one, and at the
-- time of writing not one of them is marked `supported`: BDS on Windows is
-- `unverified` (implemented, never compiled here) and all four others are
-- `not-implemented`. This migration only makes it possible to *describe* that
-- state truthfully in the database instead of implying everything is BDS.

-- ---------------------------------------------------------------------------
-- 1. servers → which engine, and which runtime that engine needs
-- ---------------------------------------------------------------------------
-- engine_id is authoritative for what is installed and how the server is started.
-- The CHECK list mirrors ENGINE_IDS in packages/shared/src/engines.ts, and a test
-- keeps the two in sync so the database cannot drift from the catalog.

alter table public.servers
  add column if not exists engine_id text not null default 'bds'
    check (engine_id in ('bds', 'powernukkitx', 'pocketmine-mp', 'paper', 'purpur'));

-- The engine build actually installed on the node, as reported by the agent after
-- a real install. Null means "never installed". This is deliberately separate from
-- `minecraft_version` (what the owner asked for) and `installed_version` (the
-- existing BDS-specific column, left untouched so nothing that reads it breaks).
alter table public.servers
  add column if not exists engine_version text;

-- 'native' means the engine needs no runtime (BDS is a self-contained binary).
-- Nullable because an existing BDS server has no runtime row and must not be
-- forced to invent one.
alter table public.servers
  add column if not exists runtime_kind text check (runtime_kind in ('native', 'jvm', 'php'));

alter table public.servers
  add column if not exists runtime_version text;

comment on column public.servers.engine_id is
  'Authoritative engine. Mirrors ENGINE_IDS in packages/shared/src/engines.ts. Defaults to bds so every pre-existing server keeps describing what it already is.';
comment on column public.servers.engine_version is
  'The build the agent actually installed, reported after installation. Null means never installed. Do not display minecraft_version as if it were this.';
comment on column public.servers.runtime_kind is
  'Runtime the engine needs: native (self-contained, e.g. BDS), jvm (Paper, Purpur, PowerNukkitX) or php (PocketMine-MP). A JVM is not interchangeable with another JVM; the exact version lives in runtime_version.';

-- The dashboard filters by engine, so this is a real access path rather than a
-- speculative index.
create index if not exists servers_engine_id_idx on public.servers (engine_id);

-- ---------------------------------------------------------------------------
-- 2. Widening servers.game_type — the one destructive-looking statement here
-- ---------------------------------------------------------------------------
-- This is the only place in the whole migration history where a constraint on a
-- pre-existing table is dropped. It is permitted because:
--
--   * It WIDENS the allowed values. 'bedrock' remains legal, so no existing row
--     becomes invalid and no row is rewritten, defaulted or lost.
--   * game_type is derived from engine_id, never chosen independently. Keeping it
--     at 'bedrock' only would make every Java server impossible to represent,
--     while deleting it would break the API routes and views that already read it.
--   * The replacement is applied in the same migration, and
--     packages/shared/tests/migration-safety.test.ts was amended to allow exactly
--     this named constraint and to require that the replacement still accepts
--     'bedrock'. Any other constraint drop on nodes/servers/pairing_codes/
--     node_events still fails CI. Dropping a primary key, foreign key or column
--     here remains forbidden.
--
-- game_type is retained for compatibility with existing readers. engine_id is the
-- field to trust; game_type is the edition, kept consistent by the check below.

alter table public.servers drop constraint if exists servers_game_type_check;
alter table public.servers add constraint servers_game_type_check
  check (game_type in ('bedrock', 'java'));

-- Two columns describing one fact must not be able to disagree. Without this, a
-- bug in an API route could store engine_id='paper' with game_type='bedrock' and
-- the console would then be handed Bedrock commands for a Java server (§9).
alter table public.servers drop constraint if exists servers_engine_matches_game_type;
alter table public.servers add constraint servers_engine_matches_game_type
  check (
    (engine_id in ('bds', 'powernukkitx', 'pocketmine-mp') and game_type = 'bedrock')
    or (engine_id in ('paper', 'purpur') and game_type = 'java')
  );

comment on column public.servers.game_type is
  'Edition, derived from engine_id and kept consistent with it by servers_engine_matches_game_type. Widened from bedrock-only in migration 009; engine_id is the authoritative field.';

-- ---------------------------------------------------------------------------
-- 3. node_engines — what is installed on each device (§5 engine manager)
-- ---------------------------------------------------------------------------
-- One row per (node, engine). This is what lets the UI answer "can this device run
-- Paper?" with a fact instead of an assumption, and it is where the install →
-- verify → register pipeline records its progress.
--
-- The integrity_check column exists because most of these publishers do not
-- provide a checksum. Only Paper could be pointed at a documented SHA-256
-- endpoint; BDS, PowerNukkitX, PocketMine-MP and Purpur have none confirmed.
-- 'unavailable' is therefore a legitimate state — but 'pending' and 'failed' are
-- not, and the table-level CHECK refuses to record an engine as installed until
-- the download has either been verified or been established as unverifiable.
-- §25: never execute unverified packages.

create table if not exists public.node_engines (
  node_id uuid not null references public.nodes (id) on delete cascade,
  engine_id text not null check (engine_id in ('bds', 'powernukkitx', 'pocketmine-mp', 'paper', 'purpur')),

  -- 'unsupported' means the engine catalog says this device cannot run it at all
  -- (for example any engine on Android today), which is different from 'failed'
  -- (we tried) and from 'not_installed' (we could, but have not).
  status text not null default 'not_installed'
    check (status in ('not_installed', 'installing', 'verifying', 'installed', 'failed', 'unsupported')),

  installed_version text,
  -- Always inside the OG HOST data directory. A path outside it is refused by the
  -- API route that writes this table, not by a check here, because the valid root
  -- differs per device and is not known to the database.
  install_path text,
  runtime_kind text check (runtime_kind in ('native', 'jvm', 'php')),

  integrity_check text not null default 'pending'
    check (integrity_check in ('pending', 'verified', 'unavailable', 'failed')),
  expected_checksum text,
  actual_checksum text,
  checksum_source text,

  installed_at timestamptz,
  last_verified_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (node_id, engine_id),

  -- Never record an engine as installed while its download is unverified or its
  -- checksum mismatched. 'unavailable' is allowed so the existing BDS workflow
  -- keeps working: Mojang publishes no checksum, and blocking on one would break
  -- official hosting rather than protect it.
  check (status <> 'installed' or integrity_check in ('verified', 'unavailable'))
);

comment on table public.node_engines is
  'Per-device engine install state. Lets the UI report platform compatibility, runtime requirement and install status as facts (§5) instead of assuming every engine runs everywhere.';
comment on column public.node_engines.status is
  'unsupported = the catalog says this device cannot run this engine. failed = we tried and it broke. not_installed = possible but not done. These must never be collapsed into one another.';
comment on column public.node_engines.integrity_check is
  'verified = matched a publisher checksum. unavailable = the publisher provides none, which is a disclosed weakness, not a pass. failed = mismatch; the package must never be executed.';

alter table public.node_engines enable row level security;

drop policy if exists "node_engines_own_select" on public.node_engines;
create policy "node_engines_own_select" on public.node_engines
  for select using (
    exists (select 1 from public.nodes n
            where n.id = node_engines.node_id and n.owner_id = auth.uid()));

drop trigger if exists trg_node_engines_touch on public.node_engines;
create trigger trg_node_engines_touch before update on public.node_engines
  for each row execute function public.touch_updated_at();

create index if not exists node_engines_node_status_idx on public.node_engines (node_id, status);
create index if not exists node_engines_engine_idx on public.node_engines (engine_id);

-- ---------------------------------------------------------------------------
-- 4. node_runtimes — JVM and PHP installs per device (§6 runtime manager)
-- ---------------------------------------------------------------------------
-- Separate from node_engines because one runtime serves many engines and many
-- servers: a single JVM can host Paper, Purpur and PowerNukkitX. Storing the
-- runtime on the engine row would duplicate it and invite the assumption that
-- each engine has its own Java.
--
-- `origin` is the column that carries §6's hardest rule. A runtime the owner
-- already had ('preinstalled') is detected and recorded, never upgraded, moved or
-- deleted by the agent — overwriting someone's Java is how a hosting tool breaks
-- unrelated software on their machine. Only 'oghost-managed' installs, which live
-- inside the OG HOST data directory, may be modified.
--
-- 'native' is intentionally absent: BDS needs no runtime, and a row claiming one
-- would be invented data.

create table if not exists public.node_runtimes (
  node_id uuid not null references public.nodes (id) on delete cascade,
  runtime_kind text not null check (runtime_kind in ('jvm', 'php')),
  -- Full version string as reported by the runtime itself (e.g. the output of
  -- `java -version`), not a version we guessed from the download filename.
  runtime_version text not null,
  major_version integer,
  install_path text not null,

  origin text not null default 'oghost-managed'
    check (origin in ('preinstalled', 'oghost-managed')),

  -- Recorded so the dashboard can state truthfully whether anything outside the
  -- OG HOST directory was touched. Must always be false for our own installs; §6
  -- forbids modifying the global PATH.
  modifies_global_path boolean not null default false,

  detected_at timestamptz not null default now(),
  verified_at timestamptz,
  verification_error text,

  -- A node may legitimately hold two JVMs, so the version is part of the key.
  primary key (node_id, runtime_kind, runtime_version)
);

comment on table public.node_runtimes is
  'Runtime installs detected or managed per device. origin=preinstalled rows are reported only and must never be modified by the agent (§6).';
comment on column public.node_runtimes.runtime_version is
  'Reported by the runtime itself. Never derived from a filename or assumed from a download: two JVMs with the same vendor can behave differently, and §25 forbids treating runtimes as interchangeable.';
comment on column public.node_runtimes.origin is
  'preinstalled = found on the device, read-only to us. oghost-managed = installed by OG HOST inside its own data directory and safe to update or remove.';

alter table public.node_runtimes enable row level security;

drop policy if exists "node_runtimes_own_select" on public.node_runtimes;
create policy "node_runtimes_own_select" on public.node_runtimes
  for select using (
    exists (select 1 from public.nodes n
            where n.id = node_runtimes.node_id and n.owner_id = auth.uid()));

create index if not exists node_runtimes_node_kind_idx on public.node_runtimes (node_id, runtime_kind);

-- ---------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------
-- Owners may read their own engine and runtime state. All writes come from API
-- routes holding the service-role key, because the values are agent-reported facts
-- and a browser must not be able to declare an engine installed.
--
-- Migration 007 fixed the default ACL so new tables inherit no dangerous
-- privileges. Revoked explicitly anyway: a table created later must not depend on
-- someone remembering to re-run that sweep. TRUNCATE bypasses RLS, so it is never
-- granted to anon or authenticated.

revoke all on table public.node_engines from anon, authenticated;
revoke all on table public.node_runtimes from anon, authenticated;

grant select on table public.node_engines to authenticated;
grant select on table public.node_runtimes to authenticated;
