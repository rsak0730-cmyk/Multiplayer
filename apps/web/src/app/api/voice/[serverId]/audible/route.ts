import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  authenticateVoiceSession,
  assertSessionOwnsServer,
  type VoiceConfigRow,
} from '@/lib/api/voice-context';
import {
  buildVoiceParticipants,
  finalVolume,
  resolveAudibleSpeakers,
  type ActiveGroupRow,
  type GroupMemberRow,
  type LinkRow,
  type PositionRow,
  type PreferenceRow,
  type SessionRow,
} from '@/lib/voice/proximity';
import { isValidVoiceMode, type PermissionState, type VoiceMode } from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * GET /api/voice/:serverId/audible — who this player can hear, and how loudly
 *
 * Authenticated by device session token and bound to the session's own server,
 * so a companion paired with one server cannot read another server's player
 * positions.
 *
 * The gain is computed here, on authoritative coordinates, and the companion only
 * applies it. That ordering is the point: if the client decided who it could
 * hear, a modified app could place itself next to any player.
 *
 * Polled rather than pushed. A few hertz is enough for a fade to feel smooth, and
 * polling keeps the control plane stateless — which matters because this runs on
 * Vercel, where there is no process to hold a subscription open. §10's requirement
 * that voice never depend on a permanently running Vercel process is respected by
 * the fact that audio itself flows directly between companion and SFU; this
 * endpoint only carries routing metadata, and if it is briefly unavailable the
 * last received gains keep working.
 */
export async function GET(request: Request, { params }: { params: { serverId: string } }) {
  if (!checkRateLimit(`voice-audible:${request.headers.get('x-forwarded-for') ?? 'unknown'}`)) {
    return rateLimitResponse();
  }

  const authed = await authenticateVoiceSession(request);
  if ('error' in authed) return authed.error;
  const { ctx } = authed;

  const mismatch = assertSessionOwnsServer(ctx, params.serverId);
  if (mismatch) return mismatch;

  const admin = createAdminClient();
  const config = ctx.config as VoiceConfigRow | null;

  if (!config || !config.enabled) {
    // Voice off means nobody is routed. Returning an empty list rather than an
    // error keeps the companion stable while the owner toggles the setting.
    return NextResponse.json({ mode: 'disabled', voice_range: 0, deafened: false, speakers: [] });
  }

  const mode: VoiceMode = isValidVoiceMode(config.mode) ? config.mode : 'proximity';
  const falloffStart = Number(config.falloff_start);

  const [{ data: positions }, { data: links }, { data: sessions }, { data: prefs }, { data: groups }, { data: members }] =
    await Promise.all([
      admin.from('voice_positions').select('*').eq('server_id', params.serverId),
      admin.from('voice_player_links').select('*').eq('server_id', params.serverId).is('revoked_at', null),
      admin.from('voice_device_sessions').select('*').eq('server_id', params.serverId),
      admin.from('voice_player_preferences').select('*').eq('server_id', params.serverId),
      admin.from('voice_groups').select('*').eq('server_id', params.serverId),
      admin
        .from('voice_group_members')
        .select('group_id, link_id, voice_groups!inner(server_id, disbanded_at)')
        .eq('voice_groups.server_id', params.serverId),
    ]);

  const participants = buildVoiceParticipants({
    links: (links ?? []) as LinkRow[],
    sessions: (sessions ?? []) as SessionRow[],
    positions: (positions ?? []) as PositionRow[],
    preferences: (prefs ?? []) as PreferenceRow[],
    // Filtered to groups that are still standing; buildVoiceParticipants ignores
    // disbanded or expired ones.
    activeGroups: (groups ?? []) as ActiveGroupRow[],
    groupMembers: (members ?? []).map((row) => ({
      group_id: row.group_id as string,
      link_id: row.link_id as string,
    })) as GroupMemberRow[],
  });

  const speakers = resolveAudibleSpeakers({
    listenerSessionId: ctx.session.id,
    participants,
    config: {
      mode,
      voiceRange: config.voice_range,
      falloffStart: Number.isFinite(falloffStart) ? falloffStart : undefined,
      ignoreAltitude: config.ignore_altitude,
    },
  });

  const ownPrefs = (prefs ?? []).find((row) => row.link_id === ctx.link.id) as PreferenceRow | undefined;
  const identityBySession = new Map(participants.map((p) => [p.sessionId, p.playerName]));

  return NextResponse.json({
    mode,
    voice_range: config.voice_range,
    deafened: ownPrefs?.deafened === true,
    listener: {
      player_name: ctx.link.player_name,
      mic_permission_state: ctx.session.mic_permission_state as PermissionState,
      transmitting: ctx.session.transmitting,
    },
    speakers: speakers.map((speaker) => ({
      player_name: speaker.playerName,
      session_id: speaker.sessionId,
      gain: speaker.gain,
      // The single number the companion applies. Already includes the listener's
      // own per-player and global volume, so a mute the player set cannot be
      // overridden by a proximity gain of 1.
      volume: finalVolume({ gain: speaker.gain, playerName: speaker.playerName, preferences: ownPrefs }),
      reason: speaker.reason,
      distance_blocks: speaker.distance === null ? null : Math.round(speaker.distance * 10) / 10,
    })),
    // Present so diagnostics can distinguish "nobody is transmitting" from
    // "nobody is in range" without exposing other players' coordinates.
    participants_present: participants.length,
    participants_transmitting: participants.filter((p) => p.micActive).length,
    unknown_identity_count: speakers.filter((s) => !identityBySession.has(s.sessionId)).length,
  });
}
