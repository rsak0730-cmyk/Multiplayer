import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { auditLog, clientIp } from '@/lib/audit';
import { checkRateLimit, rateLimitResponse, rateLimitRetryAfterSeconds } from '@/lib/rate-limit';
import { generateSessionToken, verificationCodeHash } from '@/lib/voice/credentials';
import {
  classifyCodeAttempt,
  pairingEventType,
  pairingFailureMessage,
  type CodeCandidate,
} from '@/lib/voice/pairing';
import { logVoiceEvent, type VoiceLinkRow } from '@/lib/api/voice-context';
import { redeemCodeSchema, validationError } from '@/lib/voice/validation';
import { VOICE_SESSION_TTL_DAYS, voiceRoomName } from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * Tighter than the global limiter, and honest about what it does.
 *
 * The real defence against guessing a code is arithmetic, not this bucket: 8
 * characters from a 31-symbol alphabet is ~39.7 bits, and the code dies after
 * 120 seconds, so even 1000 guesses a second for the full lifetime lands a hit
 * with probability around 1 in 7 million. This limit exists to make abuse loud
 * and cheap to stop, not to be the thing that makes brute force infeasible.
 *
 * It is also in-memory per serverless instance, so on Vercel it bounds one
 * instance rather than the whole deployment. That limitation is documented in
 * the rate limiter itself and applies to every endpoint using it.
 */
const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_MAX_ATTEMPTS = 10;

/**
 * POST /api/voice/link
 *
 * Redeem a one-time verification code and create a companion device session.
 *
 * This is the only voice endpoint a stranger can call with no prior credential,
 * and it is the point where a Minecraft player becomes an authorised voice
 * participant. Three properties are load-bearing:
 *
 *   1. The player name is NEVER taken from this request. The code row carries
 *      `player_link_id`, created when the add-on — running inside the server
 *      process, authenticated by node token — asked for a code. §12's "never
 *      trust a player-supplied username alone" is satisfied structurally: there
 *      is no username field here to supply.
 *   2. The code is consumed in the same step that creates the session, so it
 *      cannot be redeemed twice.
 *   3. Microphone permission is not requested, granted or implied. The session
 *      starts at `not_requested`, and only the player's device can move it.
 */
export async function POST(request: Request) {
  const ip = clientIp(request) ?? 'unknown';
  const rateKey = `voice-link:${ip}`;
  if (!checkRateLimit(rateKey, { windowMs: REDEEM_WINDOW_MS, maxRequests: REDEEM_MAX_ATTEMPTS })) {
    return rateLimitResponse(
      'Too many pairing attempts. Wait a few minutes, then enter the code again.',
      rateLimitRetryAfterSeconds(rateKey),
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = redeemCodeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationError(parsed.error), { status: 400 });
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const presentedHash = verificationCodeHash(input.code);

  // Lookup is by hash and deliberately not filtered by server: the player types
  // a code and nothing else, so the code identifies the server.
  const { data: rows, error: lookupError } = await admin
    .from('voice_verification_codes')
    .select('id, server_id, player_link_id, code_hash, attempts, consumed, expires_at, redeemed_at, created_at')
    .eq('code_hash', presentedHash)
    .order('created_at', { ascending: false })
    .limit(5);

  if (lookupError) {
    return NextResponse.json({ error: 'Could not check that code.' }, { status: 500 });
  }

  const candidates = (rows ?? []) as (CodeCandidate & { server_id: string; player_link_id: string | null })[];
  const outcome = classifyCodeAttempt(candidates, presentedHash);

  if (outcome.outcome !== 'live') {
    const matched = 'candidate' in outcome ? outcome.candidate : undefined;
    const serverId = (matched as { server_id?: string } | undefined)?.server_id;
    if (serverId) {
      await logVoiceEvent({
        serverId,
        eventType: pairingEventType(outcome),
        linkId: (matched as { player_link_id?: string | null }).player_link_id ?? null,
        detail: { reason: outcome.outcome, ip },
      });
    }
    return NextResponse.json({ error: pairingFailureMessage(outcome) }, { status: 401 });
  }

  const code = candidates.find((candidate) => candidate.id === outcome.candidate.id)!;

  // A cross-server binding check, when the companion told us which server it
  // thinks it is pairing with. Refused as 404 so the existence of another
  // owner's server is not confirmed to a guest.
  if (input.server_id && input.server_id !== code.server_id) {
    await logVoiceEvent({
      serverId: code.server_id,
      eventType: 'cross_server_attempt',
      linkId: code.player_link_id,
      detail: { claimed_server_id: input.server_id, ip },
    });
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  if (!code.player_link_id) {
    // Issuance always sets this. Its absence means a malformed row, and guessing
    // a player name here is precisely what this route must never do.
    await logVoiceEvent({
      serverId: code.server_id,
      eventType: 'code_rejected',
      detail: { reason: 'code_has_no_player_link', ip },
    });
    return NextResponse.json({ error: 'That code is not valid. Ask the server owner for a new one.' }, { status: 401 });
  }

  const { data: link } = await admin
    .from('voice_player_links')
    .select('*')
    .eq('id', code.player_link_id)
    .maybeSingle();
  const linkRow = link as VoiceLinkRow | null;
  if (!linkRow || linkRow.revoked_at !== null) {
    await logVoiceEvent({
      serverId: code.server_id,
      eventType: 'unauthorized_link_attempt',
      detail: { reason: 'link_missing_or_revoked', ip },
    });
    return NextResponse.json({ error: 'This device has been unlinked. Ask the server owner for a new code.' }, { status: 401 });
  }

  const { data: server } = await admin
    .from('servers')
    .select('id, name, owner_id')
    .eq('id', code.server_id)
    .maybeSingle();
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const { data: config } = await admin
    .from('voice_server_configs')
    .select('*')
    .eq('server_id', code.server_id)
    .maybeSingle();
  if (!config) {
    return NextResponse.json(
      { error: 'Voice is not set up on this server yet. Ask the owner to enable it.' },
      { status: 409 },
    );
  }
  if (!(config as { enabled: boolean }).enabled || (config as { mode: string }).mode === 'disabled') {
    await logVoiceEvent({ serverId: code.server_id, eventType: 'code_rejected', linkId: linkRow.id, detail: { reason: 'voice_disabled', ip } });
    return NextResponse.json(
      { error: 'Voice chat is disabled on this server.' },
      { status: 409 },
    );
  }

  // §17: a configurable ceiling on simultaneous sessions, so one server cannot
  // exhaust the voice host. Counted before creating anything.
  const maxParticipants = (config as { max_participants: number }).max_participants;
  const { count: liveSessions } = await admin
    .from('voice_device_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('server_id', code.server_id)
    .eq('revoked_at', null)
    .gt('expires_at', new Date().toISOString());
  if ((liveSessions ?? 0) >= maxParticipants) {
    return NextResponse.json(
      { error: `Voice on this server is full (${maxParticipants} players). Ask the owner to raise the limit.` },
      { status: 409 },
    );
  }

  // §22: a reconnect from the same device must not leave a zombie session behind.
  // Matched on platform and device name so a player using a phone and a PC keeps
  // both, while a phone that dropped and came back replaces its old session.
  await admin
    .from('voice_device_sessions')
    .update({ revoked_at: new Date().toISOString(), revoke_reason: 'superseded_by_reconnect', connected: false, transmitting: false })
    .eq('link_id', linkRow.id)
    .eq('revoked_at', null)
    .eq('platform', input.platform)
    .eq('device_name', input.device_name ?? null);

  const { token, tokenHash } = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VOICE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const sessionId = crypto.randomUUID();

  const { error: sessionError } = await admin.from('voice_device_sessions').insert({
    // Supplied explicitly rather than relying on the column default, so the
    // identity the companion is told and the identity in the row cannot diverge.
    id: sessionId,
    link_id: linkRow.id,
    server_id: code.server_id,
    session_token_hash: tokenHash,
    identity: `p-${sessionId}`,
    platform: input.platform,
    device_name: input.device_name ?? null,
    app_version: input.app_version ?? null,
    // THE PRIVACY DEFAULT. Not 'permission_granted': nothing has been asked yet,
    // and joining Minecraft must never imply microphone access.
    mic_permission_state: 'not_requested',
    connected: false,
    transmitting: false,
    expires_at: expiresAt.toISOString(),
    last_seen_at: now.toISOString(),
  });
  if (sessionError) {
    return NextResponse.json({ error: 'Could not create the voice session.' }, { status: 500 });
  }

  // Consume the code. Done after the session insert succeeds, so a failure above
  // does not burn a code the player never got to use.
  await admin
    .from('voice_verification_codes')
    .update({ consumed: true, redeemed_at: now.toISOString(), attempts: code.attempts + 1 })
    .eq('id', code.id);

  await admin.from('voice_player_links').update({ last_seen_at: now.toISOString() }).eq('id', linkRow.id);

  const { data: room } = await admin.from('voice_rooms').select('*').eq('server_id', code.server_id).maybeSingle();
  const roomRow = room as { room_name: string; sfu_url: string } | null;

  await logVoiceEvent({ serverId: code.server_id, eventType: 'link_created', linkId: linkRow.id, detail: { ip } });
  await logVoiceEvent({ serverId: code.server_id, eventType: 'session_created', linkId: linkRow.id, sessionId, detail: { platform: input.platform } });
  await logVoiceEvent({ serverId: code.server_id, eventType: 'code_redeemed', linkId: linkRow.id, sessionId });
  await auditLog({
    ownerId: (server as { owner_id: string }).owner_id,
    actorType: 'system',
    action: 'voice.device_paired',
    targetType: 'server',
    targetId: code.server_id,
    details: { platform: input.platform, link_id: linkRow.id },
    ipAddress: ip,
  });

  return NextResponse.json(
    {
      // Returned once. Only its hash is stored, so it cannot be recovered later
      // and the player must pair again if they lose it.
      session_token: token,
      session_id: sessionId,
      expires_at: expiresAt.toISOString(),
      player_name: linkRow.player_name,
      server_id: code.server_id,
      server_name: (server as { name: string }).name,
      room_name: roomRow?.room_name ?? voiceRoomName(code.server_id),
      // Null when the owner has not pointed this deployment at a voice server.
      // The companion must show that honestly instead of appearing connected.
      sfu_url: roomRow?.sfu_url ?? null,
      voice_service_ready: roomRow !== null,
      mode: (config as { mode: string }).mode,
      voice_range: (config as { voice_range: number }).voice_range,
      push_to_talk_available: (config as { push_to_talk_available: boolean }).push_to_talk_available,
      default_push_to_talk: (config as { default_push_to_talk: boolean }).default_push_to_talk,
      mic_permission_state: 'not_requested',
    },
    { status: 201 },
  );
}
