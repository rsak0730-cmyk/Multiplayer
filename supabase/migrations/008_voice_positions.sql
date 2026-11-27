-- OG VOICE — Migration 008: authoritative player positions for proximity voice
--
-- WHY A SEPARATE TABLE
-- --------------------
-- §7 requires proximity voice to use server-authoritative coordinates, and §17
-- requires position traffic to stay off the game loop and out of the tables that
-- hold credentials. Positions are:
--
--   * high frequency — the add-on reports a few times per second per player,
--   * ephemeral — a position from ten seconds ago is worthless,
--   * not secret, but not owner-readable either, since they describe guests.
--
-- Putting x/y/z on `voice_player_links` would mix a fast-changing gameplay
-- stream into the identity table, and every position update would rewrite a row
-- that also carries revocation state. A dedicated one-row-per-player table keeps
-- writes narrow and lets positions be cleared without touching identity.
--
-- Coordinates are written ONLY by the Bedrock add-on through the node-token
-- authenticated route. A companion app can never submit its own position: that
-- would let a player claim to be standing next to someone they are not, which is
-- the "unauthorized position updates" attack §12 requires preventing.
--
-- The dimension check mirrors BEDROCK_DIMENSIONS in packages/shared/src/voice.ts.
-- Official BDS reports exactly these three; the value is mandatory because a
-- missing dimension would make cross-dimension audio separation impossible.

create table if not exists public.voice_positions (
  -- One row per linked player. Upserted, never appended, so the table stays at
  -- one row per online player instead of growing with every tick.
  link_id uuid primary key references public.voice_player_links (id) on delete cascade,
  server_id uuid not null references public.servers (id) on delete cascade,

  x double precision not null,
  y double precision not null,
  z double precision not null,
  dimension text not null check (dimension in ('overworld', 'nether', 'the end')),

  -- Which trusted channel reported this. Never 'client': a companion app is not
  -- an acceptable source for a coordinate that decides who can hear whom.
  reported_by text not null default 'add_on' check (reported_by in ('add_on', 'agent')),

  updated_at timestamptz not null default now()
);

comment on table public.voice_positions is
  'Server-authoritative player coordinates for proximity voice. Written only by the Bedrock add-on via the node-token route; a companion app can never submit its own position.';
comment on column public.voice_positions.dimension is
  'Mandatory. Proximity routing refuses to compute a distance across dimensions, so an unknown dimension means the player is never heard rather than heard incorrectly.';
comment on column public.voice_positions.reported_by is
  'Restricted to trusted server-side channels. A client-supplied position would let a player teleport their audio next to anyone.';

alter table public.voice_positions enable row level security;
-- No policy: reachable only through API routes that verify the node token or the
-- device session. An owner reads the derived player list, not raw coordinates.

-- The proximity query is always "every position on this server, fresh enough to
-- trust", so this is the access path that matters.
create index if not exists voice_positions_server_updated_idx
  on public.voice_positions (server_id, updated_at desc);

-- Migration 007 fixed the default ACL, so this table should already inherit no
-- dangerous privileges. Revoked explicitly anyway: the sweep in 007 has run, but
-- a table created later must not depend on someone remembering to re-run it.
revoke all on table public.voice_positions from anon, authenticated;
