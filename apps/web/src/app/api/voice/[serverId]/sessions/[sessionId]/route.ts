import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { requireVoiceOwnerContext, logVoiceEvent, type VoiceSessionRow } from '@/lib/api/voice-context';

export const runtime = 'nodejs';

/**
 * DELETE /api/voice/:serverId/sessions/:sessionId — owner disconnects a session
 *
 * §13 allows an owner to disconnect an unauthorized session. It does not allow an
 * owner to touch a player's microphone, and this route is written so that it
 * structurally cannot:
 *
 *   The UPDATE below writes `revoked_at`, `revoke_reason`, `connected` and
 *   `transmitting` — session lifecycle columns only. It deliberately does NOT
 *   write `mic_permission_state`.
 *
 * That column is the player's device permission as their own device reported it,
 * and the only route that writes it is PATCH /api/voice/session, reachable solely
 * with that device's session token. Ending a session does not need to rewrite the
 * permission state, because `isSessionLive` excludes a revoked session from
 * routing whatever the state says — so the player is silenced by losing the
 * session, not by having their permission altered.
 *
 * The player stays in Minecraft. Only their voice access ends, and they can pair
 * again with a fresh code.
 */
export async function DELETE(request: Request, { params }: { params: { serverId: string; sessionId: string } }) {
  if (!checkRateLimit(`voice-revoke:${params.serverId}`)) {
    return rateLimitResponse();
  }

  const loaded = await requireVoiceOwnerContext(params.serverId);
  if ('error' in loaded) return loaded.error;

  const admin = createAdminClient();
  const { data: session } = await admin
    .from('voice_device_sessions')
    .select('*')
    .eq('id', params.sessionId)
    .eq('server_id', params.serverId)
    .maybeSingle();

  const row = session as VoiceSessionRow | null;
  if (!row) {
    // 404 whether the session belongs to another server or never existed: the
    // distinction would confirm that a session id is valid somewhere.
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (row.revoked_at !== null) {
    // Already disconnected. Idempotent rather than an error, so a double-click in
    // the dashboard does not look like a failure.
    return NextResponse.json({ ok: true, already_revoked: true });
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from('voice_device_sessions')
    .update({
      revoked_at: now,
      revoke_reason: 'owner_disconnected',
      connected: false,
      transmitting: false,
      last_seen_at: now,
    })
    .eq('id', row.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Drop the position too, so the disconnected player stops being audible
  // immediately instead of lingering until the freshness window expires.
  await admin.from('voice_positions').delete().eq('link_id', row.link_id);

  await logVoiceEvent({
    serverId: params.serverId,
    eventType: 'session_revoked',
    linkId: row.link_id,
    sessionId: row.id,
    detail: { by: 'owner', platform: row.platform },
  });

  return NextResponse.json({
    ok: true,
    already_revoked: false,
    stopped_transmitting: row.transmitting,
    // The device must re-pair with a new code; the token is now unusable.
    requires_new_pairing: true,
  });
}
