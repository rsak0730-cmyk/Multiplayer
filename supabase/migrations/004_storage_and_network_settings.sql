-- OG HOST — Migration 004: Storage buckets for add-ons + per-node network settings
--
-- WHY STORAGE BUCKETS: Vercel serverless functions cap request bodies at
-- ~4.5 MB, but Bedrock add-ons (.mcaddon/.mcpack) and config files can be
-- much larger. Uploads therefore go directly from the browser to Supabase
-- Storage via a signed upload URL issued by our API, and the Windows agent
-- pulls the file down via a short-lived signed download URL. No large
-- payload ever transits a serverless function.

-- ---------------------------------------------------------------------------
-- 1. Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('oghost-addons', 'oghost-addons', false, 268435456, array[
    'application/zip',
    'application/octet-stream',
    'application/x-zip-compressed'
  ]),
  ('oghost-server-files', 'oghost-server-files', false, 52428800, null),
  ('oghost-backups', 'oghost-backups', false, 2147483648, null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Storage policies: every object path is prefixed with the owner's user id,
--    i.e. "<auth.uid()>/<server_id>/<file>". The API issues signed URLs, so
--    these policies only need to stop cross-account reads.
-- ---------------------------------------------------------------------------
drop policy if exists "addons_own_select" on storage.objects;
create policy "addons_own_select" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('oghost-addons', 'oghost-server-files', 'oghost-backups')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "addons_own_insert" on storage.objects;
create policy "addons_own_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('oghost-addons', 'oghost-server-files', 'oghost-backups')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "addons_own_update" on storage.objects;
create policy "addons_own_update" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('oghost-addons', 'oghost-server-files', 'oghost-backups')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "addons_own_delete" on storage.objects;
create policy "addons_own_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('oghost-addons', 'oghost-server-files', 'oghost-backups')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 3. Per-node network settings (tunnel secrets etc.)
--    Secrets are stored hashed-or-encrypted at rest by Supabase; the plaintext
--    is only ever returned to the owning user's authenticated session and to
--    the owning node's agent.
-- ---------------------------------------------------------------------------
create table if not exists public.node_network_settings (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null unique references public.nodes (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  playit_secret text,
  playit_agent_installed boolean not null default false,
  playit_tunnel_id text,
  custom_provider_name text,
  custom_endpoint_template text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.node_network_settings enable row level security;

drop policy if exists "node_network_settings_own" on public.node_network_settings;
create policy "node_network_settings_own" on public.node_network_settings
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop trigger if exists trg_touch_updated_at on public.node_network_settings;
create trigger trg_touch_updated_at before update on public.node_network_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Scheduled backup settings (per server)
-- ---------------------------------------------------------------------------
create table if not exists public.backup_schedules (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  interval_hours integer not null default 24 check (interval_hours between 1 and 168),
  keep_count integer not null default 7 check (keep_count between 1 and 50),
  safe_stop_server boolean not null default false,
  upload_to_drive boolean not null default false,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (server_id)
);

alter table public.backup_schedules enable row level security;

drop policy if exists "backup_schedules_own" on public.backup_schedules;
create policy "backup_schedules_own" on public.backup_schedules
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop trigger if exists trg_touch_updated_at on public.backup_schedules;
create trigger trg_touch_updated_at before update on public.backup_schedules
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Google Drive connection (OAuth tokens live in Vault, not in a table;
--    this table stores only the non-secret connection metadata).
-- ---------------------------------------------------------------------------
create table if not exists public.drive_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  email text,
  scope text,
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (owner_id)
);

alter table public.drive_connections enable row level security;

drop policy if exists "drive_connections_own" on public.drive_connections;
create policy "drive_connections_own" on public.drive_connections
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Vault secrets for Drive OAuth are inserted via the Supabase Vault UI or
-- `select vault.create_secret(...)` by the project owner. Never in migrations.
