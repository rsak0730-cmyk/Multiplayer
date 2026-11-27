-- OG HOST — Migration 002: Performance indexes + agent polling helpers
-- Safe to run after 001_core_schema.sql. All statements are idempotent.

-- Fast agent command polling (partial index already in 001; add ordering index)
create index if not exists idx_node_commands_node_created
  on public.node_commands (node_id, created_at);

-- Stale node detection
create index if not exists idx_nodes_last_seen
  on public.nodes (last_seen_at desc);

-- Server listing per owner
create index if not exists idx_servers_owner_node
  on public.servers (owner_id, node_id);

-- Pairing code lookup by hash (agent claim path uses service role)
create index if not exists idx_pairing_codes_hash
  on public.pairing_codes (code_hash);

-- Console log tail queries
create index if not exists idx_console_logs_server_id
  on public.server_console_logs (server_id, id desc);

-- Audit log retention queries
create index if not exists idx_audit_logs_created
  on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- Helper view: node online status (online if seen within 90 seconds)
-- ---------------------------------------------------------------------------
create or replace view public.node_status_view as
select
  n.*,
  case
    when n.revoked_at is not null then 'revoked'
    when n.last_seen_at is not null
         and n.last_seen_at > now() - interval '90 seconds' then 'online'
    else 'offline'
  end as computed_status
from public.nodes n;

-- ---------------------------------------------------------------------------
-- Helper view: server + node + config joined for dashboard queries
-- ---------------------------------------------------------------------------
create or replace view public.server_overview_view as
select
  s.id as server_id,
  s.owner_id,
  s.node_id,
  s.name as server_name,
  s.status as server_status,
  s.minecraft_version,
  s.installed_version,
  s.available_version,
  s.max_players,
  s.public_address,
  s.public_port,
  s.networking_verified,
  s.online_players,
  s.last_error,
  n.name as node_name,
  n.computed_status as node_status,
  n.cpu_percent,
  n.ram_total_mb,
  n.ram_available_mb,
  n.storage_total_mb,
  n.storage_available_mb,
  c.gamemode,
  c.difficulty,
  c.level_name
from public.servers s
left join public.nodes n on n.id = s.node_id
left join public.server_configs c on c.server_id = s.id;
