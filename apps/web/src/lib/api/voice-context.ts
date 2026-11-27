/**
 * Voice request context — SERVER ONLY.
 *
 * Voice has two callers the rest of OG HOST does not:
 *
 *   * a **guest companion app** with no Supabase account, authenticated by its
 *     device session token; and
 *   * the **Bedrock add-on**, authenticated by the node token of the machine the
 *     server runs on.
 *
 * Owner-facing routes reuse `loadServerContext`, which already scopes by
 * ownership through RLS and returns 404 — never 403 — for another user's server.
 *
 * All reads here go through the admin client, because the credential tables are
 * deliberately unreadable by the `authenticated` role (migration 006 revokes
 * SELECT and defines no policy). That means ownership must be re-checked in this
 * module; RLS will not do it for us.
 */
import 'server-only';

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadServerContext, type ServerContext } from '@/lib/api/server-context';
import { isValidSessionToken, isExpired, sessionTokenHash } from '@/lib/voice/credentials';
import { readVoiceServiceConfig } from '@/lib/voice/tokens';
import { voiceRoomName } from '@oghost/shared';

export interface VoiceSessionRow {
  id: string;
  link_id: string;
  server_id: string;
  identity: string;
  platform: string;
  device_name: string | null;
  app_version: string | null;
  mic_permission_state: string;
  connected: boolean;
  transmitting: boolean;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export interface VoiceLinkRow {
  id: string;
  server_id: string;
  player_name: string;
  xuid: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface VoiceConfigRow {
  server_id: string;
  owner_id: string;
  enabled: boolean;
  mode: string;
  voice_range: number;
  falloff_start: number | string;
  ignore_altitude: boolean;
  push_to_talk_available: boolean;
  default_push_to_talk: boolean;
  max_participants: number;
  recording_enabled: boolean;
  audio_storage_enabled: boolean;
  add_on_status: string;
  add_on_version: string | null;
  add_on_error: string | null;
  detected_engine_version: string | null;
  detected_script_api_version: string | null;
  server_net_available: boolean | null;
  last_position_sync_at: string | null;
}

export interface VoiceRoomRow {
  id: string;
  server_id: string;
  room_name: string;
  sfu_url: string;
  status: string;
  participant_count: number;
  last_error: string | null;
}

export interface VoiceSessionContext {
  session: VoiceSessionRow;
  link: VoiceLinkRow;
  serverId: string;
  config: VoiceConfigRow | null;
  room: VoiceRoomRow | null;
}

type ErrorResult = { error: NextResponse };

/**
 * Authenticate a companion app by its device session token.
 *
 * The token is looked up by hash, so the plaintext is never compared and never
 * stored. A revoked, expired or unknown token is refused with the same 401 — the
 * caller gains nothing from learning which of the three it was.
 */
export async function authenticateVoiceSession(
  request: Request,
): Promise<{ ctx: VoiceSessionContext } | ErrorResult> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !isValidSessionToken(token)) {
    return { error: NextResponse.json({ error: 'Missing or malformed voice session token.' }, { status: 401 }) };
  }

  const admin = createAdminClient();
  const { data: session } = await admin
    .from('voice_device_sessions')
    .select('*')
    .eq('session_token_hash', sessionTokenHash(token))
    .maybeSingle();

  if (!session) {
    return { error: NextResponse.json({ error: 'Invalid voice session.' }, { status: 401 }) };
  }
  const row = session as VoiceSessionRow;
  if (row.revoked_at !== null || isExpired(row.expires_at)) {
    return { error: NextResponse.json({ error: 'Voice session has ended. Pair again from Minecraft.' }, { status: 401 }) };
  }

  const { data: link } = await admin
    .from('voice_player_links')
    .select('*')
    .eq('id', row.link_id)
    .maybeSingle();
  const linkRow = link as VoiceLinkRow | null;
  if (!linkRow || linkRow.revoked_at !== null) {
    // The device was unlinked while the session was live. Stopping immediately
    // is the point of unlinking.
    return { error: NextResponse.json({ error: 'This device has been unlinked from the server.' }, { status: 401 }) };
  }

  const { data: config } = await admin
    .from('voice_server_configs')
    .select('*')
    .eq('server_id', row.server_id)
    .maybeSingle();
  const { data: room } = await admin.from('voice_rooms').select('*').eq('server_id', row.server_id).maybeSingle();

  return {
    ctx: {
      session: row,
      link: linkRow,
      serverId: row.server_id,
      config: (config as VoiceConfigRow | null) ?? null,
      room: (room as VoiceRoomRow | null) ?? null,
    },
  };
}

/**
 * Guard a `[serverId]` route reached by a companion app.
 *
 * A session is bound to exactly one Minecraft server. Without this check a
 * companion paired with server A could request server B's positions or player
 * list by swapping the path parameter — the cross-server voice access §12
 * requires preventing.
 */
export function assertSessionOwnsServer(
  ctx: VoiceSessionContext,
  serverId: string,
): NextResponse | null {
  if (ctx.serverId === serverId) return null;
  // 404, not 403: revealing that the server exists would leak another owner's
  // configuration to a guest.
  return NextResponse.json({ error: 'Server not found' }, { status: 404 });
}

/** Owner-scoped voice context, reusing the existing server-context loader. */
export async function requireVoiceOwnerContext(
  serverId: string,
): Promise<{ ctx: ServerContext; config: VoiceConfigRow | null; room: VoiceRoomRow | null } | ErrorResult> {
  const loaded = await loadServerContext(serverId);
  if ('error' in loaded) return { error: loaded.error };

  const admin = createAdminClient();
  const { data: config } = await admin
    .from('voice_server_configs')
    .select('*')
    .eq('server_id', serverId)
    .maybeSingle();
  const { data: room } = await admin.from('voice_rooms').select('*').eq('server_id', serverId).maybeSingle();

  return {
    ctx: loaded.ctx,
    config: (config as VoiceConfigRow | null) ?? null,
    room: (room as VoiceRoomRow | null) ?? null,
  };
}

export type VoiceEventType =
  | 'code_issued'
  | 'code_redeemed'
  | 'code_expired'
  | 'code_rejected'
  | 'code_attempt_limit'
  | 'link_created'
  | 'link_revoked'
  | 'session_created'
  | 'session_connected'
  | 'session_disconnected'
  | 'session_revoked'
  | 'session_expired'
  | 'reconnect_attempt'
  | 'mic_permission_changed'
  | 'mic_started'
  | 'mic_stopped'
  | 'mic_revoked'
  | 'mode_changed'
  | 'range_changed'
  | 'voice_enabled'
  | 'voice_disabled'
  | 'add_on_installed'
  | 'add_on_failed'
  | 'add_on_incompatible'
  | 'unauthorized_link_attempt'
  | 'unauthorized_room_access'
  | 'cross_server_attempt'
  | 'position_update_rejected'
  | 'room_provision_failed'
  | 'service_restarted'
  | 'quality_degraded'
  | 'reported_by_player';

/**
 * Record a voice event.
 *
 * Best effort and never throws: an audit insert failing must not turn a
 * successful pairing into a 500, and must not stop a player's audio. The
 * trade-off is accepted deliberately and logged nowhere else, so a persistently
 * failing insert shows up as missing history rather than as broken voice.
 */
export async function logVoiceEvent(params: {
  serverId: string;
  eventType: VoiceEventType;
  linkId?: string | null;
  sessionId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('voice_connection_events').insert({
      server_id: params.serverId,
      link_id: params.linkId ?? null,
      session_id: params.sessionId ?? null,
      event_type: params.eventType,
      // Never put a code, token or coordinate in here: this table is the audit
      // trail, and it must stay free of anything that would let a reader
      // reconstruct a session or trace a player's movement.
      detail: params.detail ?? {},
    });
  } catch {
    // Swallowed on purpose. See the doc comment.
  }
}

export interface ProvisionResult {
  configCreated: boolean;
  roomCreated: boolean;
  /** True when the owner's voice settings exist and a room is mapped. */
  ready: boolean;
  /** Honest status for the dashboard — §3 requires showing the real state. */
  status: string;
  roomName: string | null;
  sfuUrl: string | null;
}

/**
 * Idempotently prepare voice for a server: configuration row, then room mapping.
 *
 * Called on server creation and again from the dashboard, so it must be safe to
 * repeat and must never overwrite settings an owner already chose.
 *
 * The room is only created when a voice server is actually configured. Creating
 * a room row pointing at a non-existent SFU would make the dashboard report a
 * ready service that cannot carry audio — which is the "never pretend it
 * installed" failure §3 warns about.
 */
export async function provisionVoiceForServer(params: {
  serverId: string;
  ownerId: string;
}): Promise<ProvisionResult> {
  const admin = createAdminClient();
  const roomName = voiceRoomName(params.serverId);

  const { data: existingConfig } = await admin
    .from('voice_server_configs')
    .select('server_id')
    .eq('server_id', params.serverId)
    .maybeSingle();

  let configCreated = false;
  if (!existingConfig) {
    const { error } = await admin.from('voice_server_configs').insert({
      server_id: params.serverId,
      owner_id: params.ownerId,
      // §3 defaults: enabled, proximity, push-to-talk available, microphone off
      // until the player grants permission and activates it, recording and audio
      // storage off.
      enabled: true,
      mode: 'proximity',
      voice_range: 32,
      falloff_start: 0.5,
      push_to_talk_available: true,
      default_push_to_talk: true,
      recording_enabled: false,
      audio_storage_enabled: false,
    });
    if (error) {
      return {
        configCreated: false,
        roomCreated: false,
        ready: false,
        status: `Voice configuration could not be saved: ${error.message}`,
        roomName: null,
        sfuUrl: null,
      };
    }
    configCreated = true;
  }

  const { data: existingRoom } = await admin
    .from('voice_rooms')
    .select('id, sfu_url')
    .eq('server_id', params.serverId)
    .maybeSingle();
  if (existingRoom) {
    return {
      configCreated,
      roomCreated: false,
      ready: true,
      status: 'Voice room already provisioned.',
      roomName,
      sfuUrl: (existingRoom as { sfu_url: string }).sfu_url,
    };
  }

  const config = readVoiceServiceConfig();
  if (!config.ok) {
    return {
      configCreated,
      roomCreated: false,
      ready: false,
      status:
        'Voice settings saved, but no voice server is configured yet. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on a machine you control, then provision again.',
      roomName,
      sfuUrl: null,
    };
  }

  const { error } = await admin.from('voice_rooms').insert({
    server_id: params.serverId,
    owner_id: params.ownerId,
    room_name: roomName,
    sfu_url: config.config.url,
    status: 'provisioned',
  });
  if (error) {
    await logVoiceEvent({
      serverId: params.serverId,
      eventType: 'room_provision_failed',
      detail: { reason: error.message },
    });
    return {
      configCreated,
      roomCreated: false,
      ready: false,
      status: `Voice room could not be created: ${error.message}`,
      roomName,
      sfuUrl: config.config.url,
    };
  }

  return {
    configCreated,
    roomCreated: true,
    ready: true,
    status: 'Voice room created and bound to this server.',
    roomName,
    sfuUrl: config.config.url,
  };
}
