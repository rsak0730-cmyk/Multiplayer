import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { authenticateVoiceSession, logVoiceEvent } from '@/lib/api/voice-context';
import { canPublishForState } from '@/lib/voice/credentials';
import { sessionStateSchema, validationError } from '@/lib/voice/validation';
import { mintVoiceToken, voiceConfigStatus, readVoiceServiceConfig } from '@/lib/voice/tokens';
import {
  canTransitionPermission,
  isTransmitting,
  permissionStateLabel,
  type PermissionState,
} from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * POST   /api/voice/session — exchange a device session for a LiveKit room token
 * PATCH  /api/voice/session — report the device's own microphone state
 * DELETE /api/voice/session — stop transmitting and disconnect immediately
 *
 * All three are authenticated by device session token, which is what makes them
 * safe to expose to a guest with no OG HOST account.
 */

/**
 * Mint a short-lived room token for this device.
 *
 * The room and identity come from the session row, never from the request body,
 * so a companion cannot ask for another server's room. Publish capability is
 * derived from the state this device last reported: a player whose OS permission
 * is denied or revoked receives a listen-only token and cannot transmit even if
 * the app is modified.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`voice-token:${request.headers.get('x-forwarded-for') ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const authed = await authenticateVoiceSession(request);
  if ('error' in authed) return authed.error;
  const { ctx } = authed;

  const admin = createAdminClient();
  await admin
    .from('voice_device_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', ctx.session.id);

  if (!ctx.config || !ctx.config.enabled || ctx.config.mode === 'disabled') {
    return NextResponse.json(
      { error: 'Voice chat is disabled on this server.' },
      { status: 409 },
    );
  }

  if (!ctx.room) {
    // No room means the owner has not pointed this deployment at a voice server.
    // Report that plainly rather than handing back a token for a room that
    // cannot exist.
    const configState = readVoiceServiceConfig();
    return NextResponse.json(
      {
        error: 'This server has no voice room yet.',
        voice_service_status: voiceConfigStatus(configState),
      },
      { status: 409 },
    );
  }

  const minted = await mintVoiceToken({
    serverId: ctx.serverId,
    sessionId: ctx.session.id,
    displayName: ctx.link.player_name,
    permissionState: ctx.session.mic_permission_state as PermissionState,
  });

  if (!minted.ok) {
    return NextResponse.json(
      { error: 'Could not issue a voice token.', reason: minted.reason },
      { status: minted.reason === 'voice_not_configured' ? 503 : 500 },
    );
  }

  return NextResponse.json({
    token: minted.token,
    expires_in_seconds: minted.expiresInSeconds,
    // Returned so the companion can show why the mic button is unavailable
    // instead of appearing broken.
    can_publish: minted.canPublish,
    room_name: ctx.room.room_name,
    sfu_url: ctx.room.sfu_url,
    mode: ctx.config.mode,
    voice_range: ctx.config.voice_range,
    mic_permission_state: ctx.session.mic_permission_state,
    mic_permission_label: permissionStateLabel(ctx.session.mic_permission_state as PermissionState),
  });
}

/**
 * Record a microphone state change reported by the device.
 *
 * This is the ONLY write path to `mic_permission_state`. It is reachable only
 * with the session token of the device that owns the row, which is what makes
 * "the server can never grant or force microphone activation" a structural fact
 * rather than a promise: there is no owner-facing or add-on-facing route that
 * writes this column.
 *
 * Transitions are checked against the shared table, so a state that would imply
 * capture without consent — `not_requested` straight to `mic_active` — is
 * refused with an explanation instead of being recorded.
 */
export async function PATCH(request: Request) {
  if (!checkRateLimit(`voice-state:${request.headers.get('x-forwarded-for') ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const authed = await authenticateVoiceSession(request);
  if ('error' in authed) return authed.error;
  const { ctx } = authed;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = sessionStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationError(parsed.error), { status: 400 });
  }

  const from = ctx.session.mic_permission_state as PermissionState;
  const to = parsed.data.mic_permission_state as PermissionState;

  if (!canTransitionPermission(from, to)) {
    return NextResponse.json(
      {
        error: `Cannot move the microphone from "${permissionStateLabel(from)}" to "${permissionStateLabel(to)}".`,
        code: 'ILLEGAL_MIC_TRANSITION',
        current_state: from,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  // Transmission is the intersection of the device reporting mic_active and the
  // SFU seeing a published track. A state that is not transmitting always clears
  // the flag, so a revoked microphone cannot leave it set.
  const transmitting = to === 'mic_active' ? (parsed.data.transmitting ?? true) : false;
  const connected = to === 'disconnected' ? false : (parsed.data.connected ?? true);

  const admin = createAdminClient();
  const { error } = await admin
    .from('voice_device_sessions')
    .update({
      mic_permission_state: to,
      mic_permission_updated_at: now,
      transmitting,
      connected,
      last_seen_at: now,
    })
    .eq('id', ctx.session.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const wasTransmitting = isTransmitting(from) && ctx.session.transmitting;
  if (to === 'permission_revoked' && wasTransmitting) {
    // §4: revocation mid-session must stop capture and transmission at once,
    // while keeping the player in Minecraft. The session is not revoked here —
    // only the microphone is — so the player can re-request permission.
    await logVoiceEvent({
      serverId: ctx.serverId,
      eventType: 'mic_revoked',
      linkId: ctx.link.id,
      sessionId: ctx.session.id,
      detail: { from },
    });
  } else if (to === 'mic_active' && !wasTransmitting) {
    await logVoiceEvent({
      serverId: ctx.serverId,
      eventType: 'mic_started',
      linkId: ctx.link.id,
      sessionId: ctx.session.id,
    });
  } else if (wasTransmitting && !transmitting) {
    await logVoiceEvent({
      serverId: ctx.serverId,
      eventType: 'mic_stopped',
      linkId: ctx.link.id,
      sessionId: ctx.session.id,
      detail: { to },
    });
  } else if (from !== to) {
    await logVoiceEvent({
      serverId: ctx.serverId,
      eventType: 'mic_permission_changed',
      linkId: ctx.link.id,
      sessionId: ctx.session.id,
      detail: { from, to },
    });
  }

  // Losing or gaining publish capability means the current token no longer
  // matches the player's state, so the companion must fetch a new one. Telling it
  // explicitly avoids a race where a denied player keeps a publishable token.
  const tokenRefreshRequired = canPublishForState(from) !== canPublishForState(to);

  return NextResponse.json({
    mic_permission_state: to,
    mic_permission_label: permissionStateLabel(to),
    transmitting,
    connected,
    token_refresh_required: tokenRefreshRequired,
    // Never conflated with transmission: a grant means the OS allowed capture,
    // not that audio is flowing.
    is_transmitting: isTransmitting(to) && transmitting,
  });
}

/**
 * Disconnect this device and stop transmitting.
 *
 * §18: a player can always stop transmitting immediately. This endpoint has no
 * confirmation step, no cooldown and no owner involvement, and it works whatever
 * the microphone state is. The session token is invalidated so a background
 * process cannot keep capturing after the player asked to stop.
 */
export async function DELETE(request: Request) {
  const authed = await authenticateVoiceSession(request);
  if ('error' in authed) return authed.error;
  const { ctx } = authed;

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await admin
    .from('voice_device_sessions')
    .update({
      connected: false,
      transmitting: false,
      mic_permission_state: 'disconnected',
      mic_permission_updated_at: now,
      revoked_at: now,
      revoke_reason: 'player_disconnected',
      last_seen_at: now,
    })
    .eq('id', ctx.session.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Position is cleared too, so a departed player does not stay audible at their
  // last known coordinates.
  await admin.from('voice_positions').delete().eq('link_id', ctx.link.id);

  await logVoiceEvent({
    serverId: ctx.serverId,
    eventType: 'session_disconnected',
    linkId: ctx.link.id,
    sessionId: ctx.session.id,
    detail: { reason: 'player_initiated' },
  });

  return NextResponse.json({ ok: true, stopped_transmitting: true });
}
