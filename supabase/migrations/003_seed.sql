-- OG HOST — Migration 003: Seed reference data
-- No Minecraft versions are hard-coded here. Available versions are
-- discovered at runtime from the official Mojang/Minecraft sources
-- (see apps/web/src/lib/bds/version-discovery.ts).

-- Default network provider catalogue (informational; provider behaviour
-- lives in code so it can be replaced without a migration).
create table if not exists public.network_providers (
  id text primary key,
  name text not null,
  description text not null,
  supports_cgnat boolean not null default false,
  requires_agent_component boolean not null default false,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.network_providers (id, name, description, supports_cgnat, requires_agent_component, is_default) values
  ('direct', 'Direct connection', 'Server is reachable directly on the node public IP/port. Works on networks with a public IPv4 or port forwarding. Fails behind CGNAT.', false, false, true),
  ('playit', 'Playit.gg tunnel', 'UDP tunnel via Playit.gg. Can work behind CGNAT. Requires the Playit agent/secret configured on the node. Free tier has limits — see docs/NETWORKING.md.', true, true, false),
  ('manual', 'Manual endpoint', 'You provide the public address/port yourself (e.g. your own VPS, router forwarding, or another tunnel). OG HOST verifies it before marking it verified.', true, false, false),
  ('custom', 'Custom provider', 'Reserved for future pluggable providers. Implement INetworkProvider in the Windows agent.', true, true, false)
on conflict (id) do nothing;

alter table public.network_providers enable row level security;

drop policy if exists "network_providers_select_all" on public.network_providers;
create policy "network_providers_select_all" on public.network_providers
  for select using (true);
