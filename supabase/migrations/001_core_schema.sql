-- OG HOST — Migration 001: Core schema extensions
-- ============================================================================
-- IMPORTANT: This migration assumes the following tables already exist
-- (created manually in the Supabase dashboard for project "og-host"):
--   nodes, servers, pairing_codes, node_events
-- It does NOT drop or recreate them. It only adds missing columns if absent
-- and creates the additional tables required by the application.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ensure expected columns exist on pre-existing tables (idempotent)
-- ---------------------------------------------------------------------------

-- nodes: add columns the agent + web app need
alter table public.nodes
  add column if not exists hostname text,
  add column if not exists agent_platform text default 'windows',
  add column if not exists token_created_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists pairing_code_id uuid,
  add column if not exists disk_used_mb bigint default 0,
  add column if not exists uptime_seconds bigint default 0,
  add column if not exists updated_at timestamptz default now();

-- servers: add columns for lifecycle + networking
alter table public.servers
  add column if not exists description text default '',
  add column if not exists world_name text default 'world',
  add column if not exists port integer default 19132,
  add column if not exists network_provider text default 'direct',
  add column if not exists public_address text,
  add column if not exists public_port integer,
  add column if not exists networking_verified boolean default false,
  add column if not exists networking_verified_at timestamptz,
  add column if not exists installed_version text,
  add column if not exists available_version text,
  add column if not exists auto_update boolean default false,
  add column if not exists auto_start_on_node_boot boolean default false,
  add column if not exists last_started_at timestamptz,
  add column if not exists last_stopped_at timestamptz,
  add column if not exists last_error text,
  add column if not exists online_players integer default 0,
  add column if not exists updated_at timestamptz default now();

-- pairing_codes: add attempts tracking for rate limiting
alter table public.pairing_codes
  add column if not exists attempts integer default 0,
  add column if not exists invalidated_at timestamptz;

-- node_events: nothing to add; keep as-is

-- ---------------------------------------------------------------------------
-- 2. Profiles (public user profile, 1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Server configuration (1:1 with servers — official BDS server.properties)
-- ---------------------------------------------------------------------------
create table if not exists public.server_configs (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null unique references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- BDS server.properties fields (defaults are conservative for low-end hardware)
  server_name text not null default 'OG HOST Server',
  gamemode text not null default 'survival'
    check (gamemode in ('survival', 'creative', 'adventure')),
  force_gamemode boolean not null default false,
  difficulty text not null default 'easy'
    check (difficulty in ('peaceful', 'easy', 'normal', 'hard')),
  spawn_monsters boolean not null default true,
  spawn_animals boolean not null default true,
  spawn_npcs boolean not null default true,
  pvp boolean not null default true,
  command_block_output boolean not null default true,
  force_command_block_output boolean not null default false,
  function_command_limit integer not null default 10,
  max_players integer not null default 10 check (max_players between 1 and 100),
  online_mode boolean not null default true,
  allow_list boolean not null default false,
  server_port integer not null default 19132 check (server_port between 1024 and 65535),
  server_portv6 integer not null default 19133 check (server_portv6 between 1024 and 65535),
  enable_lan_transfer boolean not null default true,
  enable_command_blocking boolean not null default true,
  compression_threshold integer not null default 1,
  compression_algorithm text not null default 'deflate'
    check (compression_algorithm in ('deflate', 'none')),
  tick_command_redstone_conduction integer not null default 7,
  enable_scripting boolean not null default false,
  enable_external_server_requests boolean not null default false,
  bedrock_blocking_player_prefix text not null default 'Deny',
  level_name text not null default 'world',
  level_seed text not null default '',
  default_player_permission_level text not null default 'member'
    check (default_player_permission_level in ('visitor', 'member', 'operator')),
  texture_pack_required boolean not null default false,
  server_auth_inputs_allowlist_only boolean not null default false,
  synced_skins_required boolean not null default true,
  dedicated_server_allowlist_file text not null default 'allowlist.json',
  server_admin_allowlist_file text not null default 'server_admin_allowlist.json',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Node command queue (agent polls this table via API; outbound-only)
-- ---------------------------------------------------------------------------
create table if not exists public.node_commands (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes (id) on delete cascade,
  server_id uuid references public.servers (id) on delete cascade,
  command_type text not null,
  -- e.g. start_server, stop_server, restart_server, force_stop,
  --      install_bds, update_bds, rollback_bds, backup_world,
  --      restore_backup, console_command, file_upload, file_download,
  --      file_delete, file_mkdir, file_edit, addon_install,
  --      networking_start, networking_stop, config_apply
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_node_commands_pending
  on public.node_commands (node_id, status, created_at)
  where status in ('pending', 'claimed', 'running');

-- ---------------------------------------------------------------------------
-- 5. Node tokens (rotation history; nodes.token_hash remains the active hash)
-- ---------------------------------------------------------------------------
create table if not exists public.node_tokens (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.nodes (id) on delete cascade,
  token_hash text not null,
  label text not null default 'agent',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

create index if not exists idx_node_tokens_node
  on public.node_tokens (node_id, revoked_at);

-- ---------------------------------------------------------------------------
-- 6. Server backups
-- ---------------------------------------------------------------------------
create table if not exists public.server_backups (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  file_name text not null,
  size_bytes bigint not null default 0,
  minecraft_version text,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'failed', 'restoring')),
  storage_provider text not null default 'local'
    check (storage_provider in ('local', 'google_drive')),
  drive_file_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create index if not exists idx_server_backups_server
  on public.server_backups (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. Server version history (BDS install/update/rollback log)
-- ---------------------------------------------------------------------------
create table if not exists public.server_versions (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  version text not null,
  channel text not null default 'stable' check (channel in ('stable', 'preview')),
  action text not null
    check (action in ('installed', 'updated', 'rolled_back', 'verified')),
  install_path text,
  archive_checksum_sha256 text,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create index if not exists idx_server_versions_server
  on public.server_versions (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. Server add-ons (.mcpack / .mcaddon / .mcworld)
-- ---------------------------------------------------------------------------
create table if not exists public.server_addons (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  addon_type text not null check (addon_type in ('mcpack', 'mcaddon', 'mcworld')),
  size_bytes bigint not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'installing', 'installed', 'failed')),
  installed_path text,
  created_at timestamptz not null default now(),
  installed_at timestamptz,
  error_message text
);

create index if not exists idx_server_addons_server
  on public.server_addons (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 9. Network endpoints (pluggable provider results)
-- ---------------------------------------------------------------------------
create table if not exists public.network_endpoints (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('direct', 'playit', 'manual', 'custom')),
  address text,
  port integer,
  status text not null default 'unknown'
    check (status in ('unknown', 'pending', 'active', 'verified', 'failed', 'stopped')),
  verified boolean not null default false,
  verified_at timestamptz,
  last_checked_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_network_endpoints_server
  on public.network_endpoints (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 10. Server players (last-known player list from BDS console output)
-- ---------------------------------------------------------------------------
create table if not exists public.server_players (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  player_name text not null,
  xuid text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (server_id, player_name)
);

-- ---------------------------------------------------------------------------
-- 11. Console log buffer (recent lines pushed by the agent)
-- ---------------------------------------------------------------------------
create table if not exists public.server_console_logs (
  id bigint generated always as identity primary key,
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  line text not null,
  stream text not null default 'stdout' check (stream in ('stdout', 'stderr', 'system')),
  created_at timestamptz not null default now()
);

create index if not exists idx_console_logs_server_time
  on public.server_console_logs (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 12. Audit logs
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete set null,
  actor_type text not null default 'user' check (actor_type in ('user', 'agent', 'system')),
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_owner_time
  on public.audit_logs (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 13. Helper: updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'server_configs', 'nodes', 'servers',
    'node_commands', 'network_endpoints'
  ]
  loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format(
        'drop trigger if exists trg_touch_updated_at on public.%I', t);
      execute format(
        'create trigger trg_touch_updated_at before update on public.%I
         for each row execute function public.touch_updated_at()', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.server_configs enable row level security;
alter table public.node_commands enable row level security;
alter table public.node_tokens enable row level security;
alter table public.server_backups enable row level security;
alter table public.server_versions enable row level security;
alter table public.server_addons enable row level security;
alter table public.network_endpoints enable row level security;
alter table public.server_players enable row level security;
alter table public.server_console_logs enable row level security;
alter table public.audit_logs enable row level security;

-- Owner-scoped policies (browser can read/write ONLY its own rows).
-- The agent and privileged operations go through server-side API routes
-- using the service-role key, which bypasses RLS by design.
do $$
declare
  pol record;
begin
  for pol in
    select tablename, policyname from pg_policies where schemaname = 'public'
  loop
    -- policies are (re)created below; drop existing owner policies we manage
    null;
  end loop;
end;
$$;

-- profiles
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- server_configs (owner_id column)
drop policy if exists "server_configs_all_own" on public.server_configs;
create policy "server_configs_all_own" on public.server_configs
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- node_commands (ownership via node)
drop policy if exists "node_commands_select_own" on public.node_commands;
create policy "node_commands_select_own" on public.node_commands
  for select using (
    exists (select 1 from public.nodes n
            where n.id = node_commands.node_id and n.owner_id = auth.uid()));
drop policy if exists "node_commands_insert_own" on public.node_commands;
create policy "node_commands_insert_own" on public.node_commands
  for insert with check (
    exists (select 1 from public.nodes n
            where n.id = node_commands.node_id and n.owner_id = auth.uid()));
drop policy if exists "node_commands_update_own" on public.node_commands;
create policy "node_commands_update_own" on public.node_commands
  for update using (
    exists (select 1 from public.nodes n
            where n.id = node_commands.node_id and n.owner_id = auth.uid()));

-- node_tokens (via node)
drop policy if exists "node_tokens_select_own" on public.node_tokens;
create policy "node_tokens_select_own" on public.node_tokens
  for select using (
    exists (select 1 from public.nodes n
            where n.id = node_tokens.node_id and n.owner_id = auth.uid()));

-- server_backups / server_versions / server_addons / network_endpoints /
-- server_players / server_console_logs (owner_id column)
drop policy if exists "server_backups_all_own" on public.server_backups;
create policy "server_backups_all_own" on public.server_backups
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "server_versions_all_own" on public.server_versions;
create policy "server_versions_all_own" on public.server_versions
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "server_addons_all_own" on public.server_addons;
create policy "server_addons_all_own" on public.server_addons
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "network_endpoints_all_own" on public.network_endpoints;
create policy "network_endpoints_all_own" on public.network_endpoints
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "server_players_all_own" on public.server_players;
create policy "server_players_all_own" on public.server_players
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "server_console_logs_all_own" on public.server_console_logs;
create policy "server_console_logs_all_own" on public.server_console_logs
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- audit_logs (owner can read own)
drop policy if exists "audit_logs_select_own" on public.audit_logs;
create policy "audit_logs_select_own" on public.audit_logs
  for select using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- 15. Ensure read policies exist on the ORIGINAL four tables
--     (they were created manually; re-assert owner-scoped reads idempotently)
-- ---------------------------------------------------------------------------
drop policy if exists "nodes_select_own" on public.nodes;
create policy "nodes_select_own" on public.nodes
  for select using (auth.uid() = owner_id);

drop policy if exists "servers_select_own" on public.servers;
create policy "servers_select_own" on public.servers
  for select using (auth.uid() = owner_id);

drop policy if exists "pairing_codes_select_own" on public.pairing_codes;
create policy "pairing_codes_select_own" on public.pairing_codes
  for select using (auth.uid() = owner_id);

drop policy if exists "node_events_select_own" on public.node_events;
create policy "node_events_select_own" on public.node_events
  for select using (
    exists (select 1 from public.nodes n
            where n.id = node_events.node_id and n.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 16. Prune old console logs (keep last 7 days) — run via pg_cron if enabled,
--     otherwise harmless no-op here. A scheduled job is documented in docs.
-- ---------------------------------------------------------------------------
create or replace function public.prune_console_logs()
returns void
language plpgsql
as $$
begin
  delete from public.server_console_logs
  where created_at < now() - interval '7 days';
end;
$$;
