-- OG VOICE — Migration 006: voice chat schema (additive)
--
-- ADDITIVE ONLY. This migration creates ten new tables and touches nothing that
-- already exists. It contains no DROP TABLE, no TRUNCATE, and no ALTER of the
-- pre-existing nodes / servers / pairing_codes / node_events tables.
--
-- ---------------------------------------------------------------------------
-- THE SECURITY MODEL, stated up front because it shapes every table below
-- ---------------------------------------------------------------------------
--
-- 1. GUEST PLAYERS HAVE NO ACCOUNT. Minecraft friends join a server without an
--    OG HOST login, so nothing here is keyed on auth.users for players. Player
--    identity lives in `voice_player_links`, bound to a *server*, not a user.
--
-- 2. THE BROWSER IS READ-ONLY AND MOSTLY BLIND. Five of these ten tables hold
--    session credentials, verification codes or guest data. They have NO row
--    level security policy at all and SELECT is explicitly revoked from
--    `authenticated`, so a signed-in user cannot read them even by accident.
--    They are reachable only through API routes using the service-role key, and
--    those routes re-check ownership themselves.
--
-- 3. NO SECRETS ARE STORED HERE. The LiveKit API key and secret live in
--    environment variables on the control plane only. Verification codes and
--    device session tokens are stored as SHA-256 hashes, never plaintext, and
--    are single-use. `voice_rooms.sfu_url` is a public WebSocket endpoint, not
--    a credential.
--
-- 4. THE SERVER CANNOT GRANT A MICROPHONE. `mic_permission_state` is reported
--    BY the player's device. No code path lets a server owner, the Bedrock
--    add-on or the control plane set it. See the column comment.
--
-- 5. RECORDING IS OFF AND STAYS OFF BY DEFAULT. `recording_enabled` and
--    `audio_storage_enabled` default to false. There is no audio column and no
--    audio bucket anywhere in this migration: OG VOICE stores metadata about
--    voice sessions, never voice.

-- ---------------------------------------------------------------------------
-- 1. Per-server voice configuration
--    §14 lists "server voice modes" as a separate suggested table. Mode, range
--    and falloff are per-server settings with a one-to-one relationship to this
--    row, so splitting them would create a second table that can only ever hold
--    exactly one row per config and can disagree with it. They live here.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_server_configs (
  server_id uuid primary key references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,

  enabled boolean not null default true,

  -- 'proximity' = distance and dimension limited, 'global' = whole server,
  -- 'disabled' = no audio routed at all.
  mode text not null default 'proximity'
    check (mode in ('proximity', 'global', 'disabled')),

  -- Blocks. The spec's 16/32/64/128 are examples, not guaranteed optima, so
  -- the owner may set anything in this range.
  voice_range integer not null default 32 check (voice_range between 4 and 512),
  falloff_start numeric(4,3) not null default 0.500 check (falloff_start > 0 and falloff_start <= 1),
  ignore_altitude boolean not null default false,

  -- Push-to-talk is available but never forced on the player.
  push_to_talk_available boolean not null default true,
  default_push_to_talk boolean not null default true,

  -- A hard ceiling so one server cannot exhaust the voice host. Not a
  -- benchmarked capacity claim — a limit the owner chooses.
  max_participants integer not null default 10 check (max_participants between 2 and 100),

  -- Privacy defaults. Both false, and no audio is ever stored regardless.
  recording_enabled boolean not null default false,
  audio_storage_enabled boolean not null default false,

  -- Bedrock add-on state, so the dashboard can show the truth rather than
  -- pretending the integration installed. 'not_installed' until the agent
  -- reports success.
  add_on_status text not null default 'not_installed'
    check (add_on_status in (
      'not_installed', 'installing', 'installed', 'update_available',
      'failed', 'incompatible', 'unsupported_version'
    )),
  add_on_version text,
  add_on_error text,
  add_on_installed_at timestamptz,

  -- Minecraft engine + scripting API versions actually detected on the server,
  -- which is what makes a compatibility warning accurate instead of assumed.
  detected_engine_version text,
  detected_script_api_version text,
  server_net_available boolean,

  last_position_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.voice_server_configs is
  'Per-Minecraft-server voice settings. Mode/range/falloff live here rather than in a separate one-to-one table. Privacy defaults are recording_enabled=false and audio_storage_enabled=false.';
comment on column public.voice_server_configs.server_net_available is
  'Whether @minecraft/server-net is usable on this server. False on Realms, which is why an add-on variant without it exists. Null means not yet probed — never assume true.';
comment on column public.voice_server_configs.add_on_status is
  'Reported by the Windows agent after it actually installs or fails. The UI must show this value, not an assumed success.';

alter table public.voice_server_configs enable row level security;

drop policy if exists "voice_server_configs_own" on public.voice_server_configs;
create policy "voice_server_configs_own" on public.voice_server_configs
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop trigger if exists trg_voice_server_configs_touch on public.voice_server_configs;
create trigger trg_voice_server_configs_touch before update on public.voice_server_configs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Server → voice room mapping
-- ---------------------------------------------------------------------------
create table if not exists public.voice_rooms (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null unique references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,

  -- Deterministically derived: oghost-<server uuid>. One room per Minecraft
  -- server. Proximity is per-listener gain inside this one room, not a swarm
  -- of tiny rooms, so routing stays cheap at the ~10 player design target.
  room_name text not null unique,

  -- Public WebSocket endpoint of the self-hosted SFU. NOT a credential.
  sfu_url text not null,
  region text,

  status text not null default 'provisioned'
    check (status in ('provisioned', 'active', 'degraded', 'offline', 'disabled')),
  last_error text,

  participant_count integer not null default 0 check (participant_count >= 0),
  created_at timestamptz not null default now(),
  last_active_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.voice_rooms is
  'Maps a Minecraft server to its self-hosted voice room. Contains no API key or secret: SFU credentials live only in control-plane environment variables.';
comment on column public.voice_rooms.sfu_url is
  'Public WebSocket URL of the owner-controlled voice server. Reachable by design; carries no authority on its own.';

alter table public.voice_rooms enable row level security;

drop policy if exists "voice_rooms_own" on public.voice_rooms;
create policy "voice_rooms_own" on public.voice_rooms
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop trigger if exists trg_voice_rooms_touch on public.voice_rooms;
create trigger trg_voice_rooms_touch before update on public.voice_rooms
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Guest player identity links
--    §12: friends need no OG HOST account. A link binds a Minecraft player on a
--    specific server to a companion session. It is created only by redeeming a
--    verification code — never by trusting a client-supplied username.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_player_links (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,

  -- The Minecraft display name as reported by the Bedrock add-on running inside
  -- the server process. It is a label, NOT proof of identity: two different
  -- people can share a name over time, and a client could claim any name. The
  -- trust comes from the code redemption, not from this string.
  player_name text not null,

  -- Best effort only. XUID is not cleanly exposed to Bedrock scripting, so this
  -- is frequently null and must never be treated as a required identifier.
  xuid text,

  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,

  -- One active link per player name per server. Revoked rows are kept for
  -- audit, so the uniqueness is partial.
  constraint voice_player_links_active_unique
    unique nulls not distinct (server_id, player_name, revoked_at)
);

comment on table public.voice_player_links is
  'Guest identity links. Deliberately has no auth.users column: Minecraft friends have no OG HOST account and must never gain access to account or server-management data.';
comment on column public.voice_player_links.player_name is
  'A display label, not an identity proof. Access is authorised by verification-code redemption, never by this value alone.';

alter table public.voice_player_links enable row level security;
-- No policy: unreachable from the browser. See note 2 in the header.

-- ---------------------------------------------------------------------------
-- 4. One-time verification codes
-- ---------------------------------------------------------------------------
create table if not exists public.voice_verification_codes (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  player_link_id uuid references public.voice_player_links (id) on delete cascade,

  -- SHA-256 hex of the code. The plaintext is shown once, in Minecraft or on
  -- the owner dashboard, and is never written to chat as a long-lived secret.
  code_hash text not null,

  attempts integer not null default 0 check (attempts >= 0),
  consumed boolean not null default false,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,

  -- Issued to which channel, so an unauthorized-linking attempt is traceable.
  issued_via text not null default 'in_game'
    check (issued_via in ('in_game', 'dashboard', 'agent'))
);

comment on table public.voice_verification_codes is
  'Short-lived single-use codes. Stores only a SHA-256 hash; redemption is capped by attempts and expires_at, and a consumed code can never be reused.';

alter table public.voice_verification_codes enable row level security;
-- No policy: unreachable from the browser.

create index if not exists voice_verification_codes_server_recent_idx
  on public.voice_verification_codes (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Companion device sessions
-- ---------------------------------------------------------------------------
create table if not exists public.voice_device_sessions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.voice_player_links (id) on delete cascade,
  server_id uuid not null references public.servers (id) on delete cascade,

  -- SHA-256 hex of the session token. The token itself is returned once to the
  -- companion app and is never stored, never logged, never sent to Minecraft.
  session_token_hash text not null,

  -- LiveKit participant identity, p-<session uuid>. Unique so two devices can
  -- never impersonate each other inside a room.
  identity text not null unique,

  platform text not null default 'unknown'
    check (platform in ('android', 'windows', 'ios', 'web', 'unknown')),
  device_name text,
  app_version text,

  -- THE TEN §4 PERMISSION STATES. Reported BY the device that owns this
  -- session. There is no server-side or owner-side path that writes it: an
  -- owner can disconnect a session, but can never turn a microphone on.
  -- Note 'permission_granted' means the OS allowed capture — it does NOT mean
  -- audio is flowing. Only 'mic_active' means transmitting, and even that is
  -- the device's own report, cross-checked against SFU track publication.
  mic_permission_state text not null default 'not_requested'
    check (mic_permission_state in (
      'not_requested', 'permission_required', 'permission_granted',
      'permission_denied', 'permission_permanently_denied', 'permission_revoked',
      'mic_active', 'mic_muted', 'device_unavailable', 'disconnected'
    )),
  mic_permission_updated_at timestamptz,

  connected boolean not null default false,
  transmitting boolean not null default false,

  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text
);

comment on table public.voice_device_sessions is
  'Companion app sessions. mic_permission_state is device-reported; no owner or server code path may set it, because a server can never grant or force microphone access.';
comment on column public.voice_device_sessions.session_token_hash is
  'Hash only. Plaintext tokens are issued once and are not recoverable from the database.';
comment on column public.voice_device_sessions.transmitting is
  'True only while the SFU reports an active published audio track. Kept separate from mic_permission_state so an OS grant is never displayed as a live microphone.';

alter table public.voice_device_sessions enable row level security;
-- No policy: unreachable from the browser.

create index if not exists voice_device_sessions_link_idx
  on public.voice_device_sessions (link_id);
create index if not exists voice_device_sessions_active_idx
  on public.voice_device_sessions (server_id, connected)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 6. Player audio preferences
--    Keyed on the guest link, so a player without an account still keeps their
--    volume, device and push-to-talk choices.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_player_preferences (
  link_id uuid primary key references public.voice_player_links (id) on delete cascade,
  server_id uuid not null references public.servers (id) on delete cascade,

  input_device_id text,
  output_device_id text,
  output_route text not null default 'speaker'
    check (output_route in ('speaker', 'wired', 'bluetooth', 'system')),

  -- 0.00 to 2.00 allows boost above unity without clipping by default.
  global_volume numeric(4,2) not null default 1.00 check (global_volume >= 0 and global_volume <= 2),
  mic_sensitivity numeric(4,2) not null default 0.50 check (mic_sensitivity >= 0 and mic_sensitivity <= 1),

  -- Applied where the platform supports them. The companion reports what it
  -- actually enabled, so the UI never claims an effect it did not apply.
  noise_suppression boolean not null default true,
  echo_cancellation boolean not null default true,
  auto_gain_control boolean not null default true,

  push_to_talk boolean not null default true,
  -- Android: a UI button id. Windows: a hotkey such as "Ctrl+Shift+V".
  ptt_binding text,

  deafened boolean not null default false,

  -- Player names the listener has individually muted, and per-player volumes
  -- keyed by player name. Both are the listener's own choices.
  muted_players jsonb not null default '[]'::jsonb check (jsonb_typeof(muted_players) = 'array'),
  per_player_volume jsonb not null default '{}'::jsonb check (jsonb_typeof(per_player_volume) = 'object'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.voice_player_preferences is
  'Per-player audio settings, owned by the player through their device session. An owner can disable voice for a server but can never edit these rows.';

alter table public.voice_player_preferences enable row level security;
-- No policy: unreachable from the browser.

drop trigger if exists trg_voice_player_preferences_touch on public.voice_player_preferences;
create trigger trg_voice_player_preferences_touch before update on public.voice_player_preferences
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Temporary voice groups (party rooms / team channels)
-- ---------------------------------------------------------------------------
create table if not exists public.voice_groups (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,

  name text not null,
  kind text not null default 'temporary'
    check (kind in ('temporary', 'party', 'team')),

  -- Player name of the creator, or 'owner' when created from the dashboard.
  created_by text not null default 'owner',
  max_members integer not null default 8 check (max_members between 2 and 32),

  -- Group members hear each other regardless of distance and dimension. That is
  -- the point of a group, and it is why membership is checked explicitly.
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  disbanded_at timestamptz,

  constraint voice_groups_name_unique
    unique nulls not distinct (server_id, name, disbanded_at)
);

comment on table public.voice_groups is
  'Temporary voice groups. Members bypass proximity distance and dimension limits; non-members are never routed group audio, so a private group cannot be joined without authorization.';

alter table public.voice_groups enable row level security;

drop policy if exists "voice_groups_own" on public.voice_groups;
create policy "voice_groups_own" on public.voice_groups
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- 8. Group membership
-- ---------------------------------------------------------------------------
create table if not exists public.voice_group_members (
  group_id uuid not null references public.voice_groups (id) on delete cascade,
  link_id uuid not null references public.voice_player_links (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, link_id)
);

comment on table public.voice_group_members is
  'Membership is the only thing that authorises group audio. Rows are created by the API after it verifies the session belongs to this server.';

alter table public.voice_group_members enable row level security;
-- No policy: reachable only through API routes that verify the device session.

create index if not exists voice_group_members_link_idx
  on public.voice_group_members (link_id);

-- ---------------------------------------------------------------------------
-- 9. Connection and permission events (audit trail)
-- ---------------------------------------------------------------------------
create table if not exists public.voice_connection_events (
  id bigint generated always as identity primary key,
  server_id uuid not null references public.servers (id) on delete cascade,
  link_id uuid references public.voice_player_links (id) on delete set null,
  session_id uuid references public.voice_device_sessions (id) on delete set null,

  event_type text not null check (event_type in (
    -- pairing / identity
    'code_issued', 'code_redeemed', 'code_expired', 'code_rejected',
    'code_attempt_limit', 'link_created', 'link_revoked',
    -- sessions
    'session_created', 'session_connected', 'session_disconnected',
    'session_revoked', 'session_expired', 'reconnect_attempt',
    -- microphone
    'mic_permission_changed', 'mic_started', 'mic_stopped', 'mic_revoked',
    -- configuration
    'mode_changed', 'range_changed', 'voice_enabled', 'voice_disabled',
    'add_on_installed', 'add_on_failed', 'add_on_incompatible',
    -- failures and abuse
    'unauthorized_link_attempt', 'unauthorized_room_access', 'cross_server_attempt',
    'position_update_rejected', 'room_provision_failed', 'service_restarted',
    'quality_degraded', 'reported_by_player'
  )),

  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

comment on table public.voice_connection_events is
  'Append-only audit trail for voice pairing, permission changes and abuse attempts. Contains metadata only — never audio, never plaintext codes or tokens.';
comment on column public.voice_connection_events.link_id is
  'On delete set null: revoking or purging a guest link must not erase the evidence that an unauthorized attempt happened.';

alter table public.voice_connection_events enable row level security;
-- No policy: the owner reads a filtered projection through the API, never the
-- raw table, so guest rows cannot leak session or identity detail to a browser.

create index if not exists voice_connection_events_server_time_idx
  on public.voice_connection_events (server_id, created_at desc);
create index if not exists voice_connection_events_type_idx
  on public.voice_connection_events (event_type, created_at desc);

-- ---------------------------------------------------------------------------
-- 10. Voice service health
--     server_id null = the voice service as a whole. `nulls not distinct` keeps
--     that single global row unique, which plain NULL uniqueness would not.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_service_health (
  id uuid primary key default gen_random_uuid(),
  server_id uuid unique nulls not distinct references public.servers (id) on delete cascade,
  owner_id uuid references auth.users (id) on delete cascade,

  status text not null default 'unknown'
    check (status in ('unknown', 'healthy', 'degraded', 'offline')),
  sfu_reachable boolean,

  -- Measured on the voice host, not on the Minecraft host.
  cpu_percent numeric(5,2) check (cpu_percent is null or (cpu_percent >= 0 and cpu_percent <= 100)),
  memory_used_mb integer check (memory_used_mb is null or memory_used_mb >= 0),
  memory_total_mb integer check (memory_total_mb is null or memory_total_mb >= 0),

  active_rooms integer not null default 0 check (active_rooms >= 0),
  active_participants integer not null default 0 check (active_participants >= 0),

  -- §10: distinguish these honestly instead of assuming direct connectivity.
  -- Jio/Airtel/Vi mobile CGNAT generally cannot accept inbound, so 'direct' is
  -- a measured result, never a default.
  relay_mode text not null default 'unknown'
    check (relay_mode in ('direct', 'self_hosted_relay', 'external_relay', 'unsupported', 'unknown')),
  turn_servers_configured boolean not null default false,

  last_check_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.voice_service_health is
  'Current health of the self-hosted voice service. relay_mode records what was actually measured; unknown means unverified, and must be displayed as such.';
comment on column public.voice_service_health.relay_mode is
  'Never defaulted to direct. Mobile carriers using CGNAT typically block inbound, so this reflects a real connectivity test.';

alter table public.voice_service_health enable row level security;

drop policy if exists "voice_service_health_own" on public.voice_service_health;
create policy "voice_service_health_own" on public.voice_service_health
  for select to authenticated
  using (owner_id is not null and auth.uid() = owner_id);

drop trigger if exists trg_voice_service_health_touch on public.voice_service_health;
create trigger trg_voice_service_health_touch before update on public.voice_service_health
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 11. Privileges
--     Migration 005 set default privileges granting `authenticated` SELECT on
--     future tables, so every table above inherits it. That is correct for the
--     owner-facing tables, where RLS scopes rows to the owner. It is NOT
--     acceptable for the five credential and guest tables, so SELECT is
--     revoked from them explicitly. `service_role` bypasses RLS and keeps full
--     access for the API routes.
--     No privilege is granted to `anon` here.
-- ---------------------------------------------------------------------------
revoke all on table public.voice_player_links from anon, authenticated;
revoke all on table public.voice_verification_codes from anon, authenticated;
revoke all on table public.voice_device_sessions from anon, authenticated;
revoke all on table public.voice_player_preferences from anon, authenticated;
revoke all on table public.voice_group_members from anon, authenticated;
revoke all on table public.voice_connection_events from anon, authenticated;

grant select on table public.voice_server_configs to authenticated;
grant select on table public.voice_rooms to authenticated;
grant select on table public.voice_groups to authenticated;
grant select on table public.voice_service_health to authenticated;
