import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { requireVoiceOwnerContext, logVoiceEvent, type VoiceSessionRow } from '@/lib/api/voice-context';
import { isExpired } from '@/lib/voice/credentials';
import { isPlayerTransmitting } from '@/lib/voice/proximity';
import { readVoiceServiceConfig, voiceConfigStatus } from '@/lib/voice/tokens';
import { voiceConfigPatchSchema, validationError } from '@/lib/voice/validation';
import {
  MAX_VOICE_RANGE,
  MIN_VOICE_RANGE,
  permissionStateLabel,
  type PermissionState,
} from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * GET   /api/voice/:serverId — the owner's voice dashboard state
 * PATCH /api/voice/:serverId — the owner's voice configuration
 *
 * Owner-authenticated via `loadServerContext`; another user's server is a 404.
 *
 * §13 lists what an owner may control, and the schema in `validation.ts` is what
 * enforces the limit: there is no field for another player's microphone, volume
 * or recording. An owner can disable voice for the whole server and can
 * disconnect a session, but cannot make a player's microphone active. The
 * absence of a field is the enforcement, not a comment.
 */
export async function GET(_request: Request, { params }: { params: { serverId: string } }) {
  const loaded = await requireVoiceOwnerContext(params.serverId);
  if ('error' in loaded) return loaded.error;
  const { ctx, config, room } = loaded;

  const admin = createAdminClient();
  const now = new Date();
  const configState = readVoiceServiceConfig();

  const [{ data: sessions }, { data: links }, { data: health }, { data: recentEvents }, { data: groups }] =
    await Promise.all([
      admin.from('voice_device_sessions').select('*').eq('server_id', params.serverId),
      admin.from('voice_player_links').select('*').eq('server_id', params.serverId).is('revoked_at', null),
      admin.from('voice_service_health').select('*').eq('server_id', params.serverId).maybeSingle(),
      admin
        .from('voice_connection_events')
        .select('event_type, detail, created_at')
        .eq('server_id', params.serverId)
        .order('created_at', { ascending: false })
        .limit(50),
      admin.from('voice_groups').select('*').eq('server_id', params.serverId).is('disbanded_at', null),
    ]);

  const rows = (sessions ?? []) as VoiceSessionRow[];
  const live = rows.filter((row) => row.revoked_at === null && !isExpired(row.expires_at, now));
  const connected = live.filter((row) => row.connected);
  const transmitting = connected.filter((row) => isPlayerTransmitting(row));
  const playerNameByLink = new Map((links ?? []).map((link) => [link.id as string, link.player_name as string]));

  const events = (recentEvents ?? []) as { event_type: string; created_at: string }[];
  const failureTypes = new Set([
    'code_rejected',
    'code_expired',
    'code_attempt_limit',
    'unauthorized_link_attempt',
    'unauthorized_room_access',
    'cross_server_attempt',
    'position_update_rejected',
    'room_provision_failed',
    'add_on_failed',
    'add_on_incompatible',
  ]);

  const healthRow = health as Record<string, unknown> | null;

  return NextResponse.json({
    server_id: ctx.server.id,
    server_name: ctx.server.name,

    // --- configuration -------------------------------------------------------
    provisioned: config !== null,
    enabled: config?.enabled ?? false,
    mode: config?.mode ?? 'proximity',
    voice_range: config?.voice_range ?? 32,
    range_limits: { min: MIN_VOICE_RANGE, max: MAX_VOICE_RANGE },
    falloff_start: Number(config?.falloff_start ?? 0.5),
    ignore_altitude: config?.ignore_altitude ?? false,
    push_to_talk_available: config?.push_to_talk_available ?? true,
    default_push_to_talk: config?.default_push_to_talk ?? true,
    max_participants: config?.max_participants ?? 10,

    // --- privacy defaults, surfaced so an owner can see them rather than assume
    recording_enabled: config?.recording_enabled ?? false,
    audio_storage_enabled: config?.audio_storage_enabled ?? false,

    // --- Bedrock integration status, reported not assumed -------------------
    add_on: {
      status: config?.add_on_status ?? 'not_installed',
      version: config?.add_on_version ?? null,
      error: config?.add_on_error ?? null,
      installed_at: null,
      detected_engine_version: config?.detected_engine_version ?? null,
      detected_script_api_version: config?.detected_script_api_version ?? null,
      // Null means never probed. The UI must show "unknown", not "yes".
      server_net_available: config?.server_net_available ?? null,
      last_position_sync_at: config?.last_position_sync_at ?? null,
      position_sync_stale:
        config?.last_position_sync_at === null ||
        config?.last_position_sync_at === undefined ||
        isExpired(new Date(new Date(config.last_position_sync_at).getTime() + 30_000), now),
    },

    // --- voice service -------------------------------------------------------
    service: {
      configured: configState.ok,
      status: voiceConfigStatus(configState),
      required_env: configState.ok ? [] : ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
      room_name: room?.room_name ?? null,
      // A public endpoint, not a credential — safe to show the owner.
      sfu_url: room?.sfu_url ?? null,
      room_status: room?.status ?? 'not_provisioned',
      health: healthRow
        ? {
            status: healthRow.status,
            sfu_reachable: healthRow.sfu_reachable,
            cpu_percent: healthRow.cpu_percent,
            memory_used_mb: healthRow.memory_used_mb,
            memory_total_mb: healthRow.memory_total_mb,
            active_rooms: healthRow.active_rooms,
            active_participants: healthRow.active_participants,
            // §10: reported as measured. 'unknown' means untested, and must be
            // displayed as unknown rather than as "direct".
            relay_mode: healthRow.relay_mode,
            turn_servers_configured: healthRow.turn_servers_configured,
            last_check_at: healthRow.last_check_at,
            last_error: healthRow.last_error,
          }
        : null,
    },

    // --- players -------------------------------------------------------------
    // Microphone permission is included because the device reported it about
    // itself, which is the only legitimate source. It is a status, not a control:
    // there is no corresponding write.
    connected_players: connected.length,
    active_speakers: transmitting.length,
    linked_players: (links ?? []).length,
    sessions: live.map((row) => ({
      id: row.id,
      player_name: playerNameByLink.get(row.link_id) ?? 'unknown',
      platform: row.platform,
      device_name: row.device_name,
      connected: row.connected,
      mic_permission_state: row.mic_permission_state,
      mic_permission_label: permissionStateLabel(row.mic_permission_state as PermissionState),
      // Kept separate from the permission state on purpose: an OS grant is not a
      // live microphone, and the dashboard must not conflate them.
      transmitting: isPlayerTransmitting(row),
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      // Never serialised: session_token_hash stays in the database.
    })),

    // --- groups and failures -------------------------------------------------
    groups: (groups ?? []).map((group) => ({
      id: (group as { id: string }).id,
      name: (group as { name: string }).name,
      kind: (group as { kind: string }).kind,
      created_by: (group as { created_by: string }).created_by,
      expires_at: (group as { expires_at: string | null }).expires_at,
    })),
    recent_events: events.slice(0, 20).map((event) => ({
      event_type: event.event_type,
      created_at: event.created_at,
      is_failure: failureTypes.has(event.event_type),
    })),
    connection_failures: events.filter((event) => failureTypes.has(event.event_type)).length,
  });
}

export async function PATCH(request: Request, { params }: { params: { serverId: string } }) {
  if (!checkRateLimit(`voice-config:${params.serverId}`)) {
    return rateLimitResponse();
  }

  const loaded = await requireVoiceOwnerContext(params.serverId);
  if ('error' in loaded) return loaded.error;
  const { config } = loaded;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = voiceConfigPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationError(parsed.error), { status: 400 });
  }
  const changes = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from('voice_server_configs')
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq('server_id', params.serverId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // One event per meaningful change, so the audit trail says what actually moved.
  if (changes.enabled !== undefined && changes.enabled !== config?.enabled) {
    await logVoiceEvent({
      serverId: params.serverId,
      eventType: changes.enabled ? 'voice_enabled' : 'voice_disabled',
      detail: { by: 'owner' },
    });
  }
  if (changes.mode !== undefined && changes.mode !== config?.mode) {
    await logVoiceEvent({
      serverId: params.serverId,
      eventType: 'mode_changed',
      detail: { from: config?.mode ?? null, to: changes.mode },
    });
  }
  if (changes.voice_range !== undefined && changes.voice_range !== config?.voice_range) {
    await logVoiceEvent({
      serverId: params.serverId,
      eventType: 'range_changed',
      detail: { from: config?.voice_range ?? null, to: changes.voice_range },
    });
  }

  // Disabling voice must silence routing immediately, which it does: the audible
  // endpoint re-reads this row on every request and returns nobody when the mode
  // is 'disabled' or the config is off.
  return NextResponse.json({ ok: true, updated: changes });
}
