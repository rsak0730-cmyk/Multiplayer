/**
 * Verification code issuance — SERVER ONLY.
 *
 * Shared by the owner-facing dashboard route and the agent-facing route the
 * Bedrock add-on reaches through the local agent, so both produce codes with
 * identical guarantees.
 *
 * The credential chain, and why it is safe:
 *
 *   add-on (inside BDS) → local agent on the same machine → control plane
 *
 * The add-on never holds the node token. It talks to the agent over localhost
 * and the agent forwards with its own token, so no long-lived credential is ever
 * placed inside a behavior pack or printed into Minecraft chat. The player name
 * arrives from inside the server process, which is what makes it trustworthy —
 * §12's "never trust a player-supplied username alone" is satisfied because the
 * name does not come from the player.
 */
import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { logVoiceEvent, provisionVoiceForServer, type VoiceConfigRow } from '@/lib/api/voice-context';
import { codeExpiresAt, generateVerificationCode } from '@/lib/voice/credentials';
import { VOICE_CODE_TTL_SECONDS } from '@oghost/shared';

export type IssueCodeResult =
  | { ok: true; code: string; expiresAt: string; playerName: string; linkId: string; ttlSeconds: number }
  | { ok: false; status: number; error: string };

/**
 * Issue a one-time code that binds a Minecraft player to a companion device.
 *
 * Creates the player link if this is the player's first pairing, invalidates any
 * code still outstanding for them so only the newest one on screen works, and
 * returns the plaintext exactly once — only its hash is stored.
 */
export async function issueVoiceCode(params: {
  serverId: string;
  playerName: string;
  issuedVia: 'in_game' | 'dashboard' | 'agent';
}): Promise<IssueCodeResult> {
  const admin = createAdminClient();

  const { data: server } = await admin
    .from('servers')
    .select('id, name, owner_id')
    .eq('id', params.serverId)
    .maybeSingle();
  if (!server) {
    return { ok: false, status: 404, error: 'Server not found' };
  }
  const ownerId = (server as { owner_id: string }).owner_id;

  // Auto-prepare on first use (§3) rather than failing and asking the owner to
  // click something. Idempotent, and it never overwrites settings that exist.
  const { data: existingConfig } = await admin
    .from('voice_server_configs')
    .select('*')
    .eq('server_id', params.serverId)
    .maybeSingle();

  let config = existingConfig as VoiceConfigRow | null;
  if (!config) {
    const provisioned = await provisionVoiceForServer({ serverId: params.serverId, ownerId });
    if (!provisioned.configCreated) {
      return { ok: false, status: 500, error: provisioned.status };
    }
    const { data: created } = await admin
      .from('voice_server_configs')
      .select('*')
      .eq('server_id', params.serverId)
      .maybeSingle();
    config = created as VoiceConfigRow | null;
  }
  if (!config) {
    return { ok: false, status: 500, error: 'Voice configuration could not be read.' };
  }

  if (!config.enabled || config.mode === 'disabled') {
    // Refuse rather than issue a code that cannot work. Issuing one would show a
    // player a code and then reject it, which reads as a broken app.
    await logVoiceEvent({
      serverId: params.serverId,
      eventType: 'code_rejected',
      detail: { reason: 'voice_disabled', issued_via: params.issuedVia },
    });
    return { ok: false, status: 409, error: 'Voice chat is disabled on this server.' };
  }

  // Resolve or create the player link. A revoked link is left alone and a new
  // one is created, so unlinking a device really does end that binding.
  const { data: existingLink } = await admin
    .from('voice_player_links')
    .select('id')
    .eq('server_id', params.serverId)
    .eq('player_name', params.playerName)
    .is('revoked_at', null)
    .maybeSingle();

  let linkId = (existingLink as { id: string } | null)?.id ?? null;
  if (!linkId) {
    const { data: inserted, error: linkError } = await admin
      .from('voice_player_links')
      .insert({ server_id: params.serverId, player_name: params.playerName })
      .select('id')
      .single();
    if (linkError || !inserted) {
      return { ok: false, status: 500, error: 'Could not create the player link.' };
    }
    linkId = (inserted as { id: string }).id;
  }

  // Only the newest code for this player stays valid, so the one shown on screen
  // is unambiguous and a stale code cannot be redeemed later.
  await admin
    .from('voice_verification_codes')
    .update({ consumed: true })
    .eq('player_link_id', linkId)
    .eq('consumed', false);

  const { code, codeHash } = generateVerificationCode();
  const now = new Date();
  const expiresAt = codeExpiresAt(now, VOICE_CODE_TTL_SECONDS);

  const { error: codeError } = await admin.from('voice_verification_codes').insert({
    server_id: params.serverId,
    player_link_id: linkId,
    code_hash: codeHash,
    expires_at: expiresAt.toISOString(),
    issued_via: params.issuedVia,
  });
  if (codeError) {
    return { ok: false, status: 500, error: 'Could not store the verification code.' };
  }

  // The event records that a code was issued, never its value or hash.
  await logVoiceEvent({
    serverId: params.serverId,
    eventType: 'code_issued',
    linkId,
    detail: { issued_via: params.issuedVia, ttl_seconds: VOICE_CODE_TTL_SECONDS },
  });

  return {
    ok: true,
    code,
    expiresAt: expiresAt.toISOString(),
    playerName: params.playerName,
    linkId,
    ttlSeconds: VOICE_CODE_TTL_SECONDS,
  };
}
