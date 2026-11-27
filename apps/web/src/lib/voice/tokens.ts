/**
 * Voice token minting — SERVER ONLY.
 *
 * The `server-only` import makes a client-side import fail the build rather than
 * silently shipping secret handling into a browser bundle. This module is the
 * only place in the repository that touches `LIVEKIT_API_SECRET`.
 *
 * Two rules that are not negotiable:
 *   - The SFU API key and secret live in environment variables on the control
 *     plane. They are never written to the database, never returned by an API
 *     route, and never logged. `voice_rooms.sfu_url` is a public endpoint, not a
 *     credential.
 *   - A minted token is short-lived and scoped to one room and one participant
 *     identity. It carries publish capability only when the player's reported
 *     permission state allows it.
 */
import 'server-only';

import { AccessToken } from 'livekit-server-sdk';
import {
  VOICE_TOKEN_TTL_SECONDS_DEFAULT,
  isValidPermissionState,
  voiceParticipantIdentity,
  voiceRoomName,
  type PermissionState,
} from '@oghost/shared';
import { canPublishForState } from './credentials';

export const VOICE_ENV_VARS = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

export const MIN_VOICE_TOKEN_TTL_SECONDS = 60;
export const MAX_VOICE_TOKEN_TTL_SECONDS = 86_400;

export type VoiceServiceConfig = {
  /** Public WebSocket endpoint of the self-hosted SFU. Not a secret. */
  url: string;
  apiKey: string;
  apiSecret: string;
  tokenTtlSeconds: number;
};

/**
 * A result rather than a throw.
 *
 * §10 requires that voice failure never takes down OG HOST. A missing SFU
 * configuration is an expected state on a fresh install, not an exceptional one,
 * so callers branch on it and the dashboard reports "not configured" instead of
 * a 500 or a blank panel.
 */
export type VoiceConfigResult =
  | { ok: true; config: VoiceServiceConfig }
  | { ok: false; reason: VoiceConfigFailure };

export type VoiceConfigFailure =
  | 'missing_url'
  | 'missing_api_key'
  | 'missing_api_secret'
  | 'insecure_url'
  | 'malformed_url'
  | 'invalid_ttl';

export type MintResult =
  | { ok: true; token: string; expiresInSeconds: number; canPublish: boolean }
  | { ok: false; reason: 'voice_not_configured' | 'invalid_room' | 'invalid_identity' | 'mint_failed'; detail?: string };

/**
 * Extract the host from a ws/wss URL.
 *
 * Written out rather than using `new URL(...).hostname` because the URL parser
 * and this module need to agree on what counts as loopback, and an IPv6 literal
 * defeats the naive `authority.split(':')[0]` — for `ws://[::1]:7880` that
 * returns `[`, which is neither a host nor loopback, so a local dev server was
 * being rejected as insecure.
 */
function urlHost(url: string): string {
  const authority = url.replace(/^wss?:\/\//, '').split('/')[0];
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? authority : authority.slice(1, end);
  }
  return authority.split(':')[0];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * The environment this module reads, declared explicitly.
 *
 * Narrower than `NodeJS.ProcessEnv` on purpose: it documents exactly which
 * variables matter, and it lets a caller pass a small object in tests without
 * satisfying every key Node's type declares (Next.js makes `NODE_ENV`
 * required on `ProcessEnv`).
 */
export type VoiceEnv = {
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  VOICE_TOKEN_TTL_SECONDS?: string;
  /**
   * Present so `process.env` stays assignable.
   *
   * A type whose properties are all optional is "weak" in TypeScript's eyes, and
   * assigning `process.env` to it fails with "no properties in common" because
   * none of these four names are declared on `ProcessEnv` — they only arrive via
   * its index signature. Mirroring that signature here fixes the default
   * parameter without weakening what callers may read.
   */
  [key: string]: string | undefined;
};

/**
 * Read and validate the voice service configuration.
 *
 * `env` is injectable so this can be tested without mutating `process.env`.
 */
export function readVoiceServiceConfig(env: VoiceEnv = process.env): VoiceConfigResult {
  const url = (env.LIVEKIT_URL ?? '').trim();
  const apiKey = (env.LIVEKIT_API_KEY ?? '').trim();
  const apiSecret = (env.LIVEKIT_API_SECRET ?? '').trim();

  if (!url) return { ok: false, reason: 'missing_url' };
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };
  if (!apiSecret) return { ok: false, reason: 'missing_api_secret' };

  if (!/^wss?:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/.test(url)) {
    return { ok: false, reason: 'malformed_url' };
  }

  // §9 requires encrypted transport. Cleartext ws:// is tolerated only for a
  // loopback dev server, never for a host a phone has to reach.
  if (url.startsWith('ws://') && !LOOPBACK_HOSTS.has(urlHost(url))) {
    return { ok: false, reason: 'insecure_url' };
  }

  const rawTtl = (env.VOICE_TOKEN_TTL_SECONDS ?? '').trim();
  let tokenTtlSeconds = VOICE_TOKEN_TTL_SECONDS_DEFAULT;
  if (rawTtl) {
    const parsed = Number(rawTtl);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_VOICE_TOKEN_TTL_SECONDS ||
      parsed > MAX_VOICE_TOKEN_TTL_SECONDS
    ) {
      return { ok: false, reason: 'invalid_ttl' };
    }
    tokenTtlSeconds = parsed;
  }

  return { ok: true, config: { url, apiKey, apiSecret, tokenTtlSeconds } };
}

/**
 * A short human-readable status for the dashboard.
 *
 * §3 requires displaying the actual setup status rather than implying a service
 * is ready. These strings are shown to the owner, so they say what to do.
 */
export function voiceConfigStatus(result: VoiceConfigResult): string {
  if (result.ok) return 'Voice service configured.';
  switch (result.reason) {
    case 'missing_url':
      return 'Voice service not configured: LIVEKIT_URL is missing.';
    case 'missing_api_key':
      return 'Voice service not configured: LIVEKIT_API_KEY is missing.';
    case 'missing_api_secret':
      return 'Voice service not configured: LIVEKIT_API_SECRET is missing.';
    case 'malformed_url':
      return 'Voice service misconfigured: LIVEKIT_URL must be a ws:// or wss:// endpoint.';
    case 'insecure_url':
      return 'Voice service misconfigured: LIVEKIT_URL must use wss:// for any host other than localhost. Audio would otherwise travel unencrypted.';
    case 'invalid_ttl':
      return `Voice service misconfigured: VOICE_TOKEN_TTL_SECONDS must be an integer between ${MIN_VOICE_TOKEN_TTL_SECONDS} and ${MAX_VOICE_TOKEN_TTL_SECONDS}.`;
  }
}

export type MintVoiceTokenParams = {
  /** Minecraft server id; the room name is derived from it, never supplied. */
  serverId: string;
  /** Device session id; the participant identity is derived from it. */
  sessionId: string;
  /** Display name shown to other players. A label, not an identity proof. */
  displayName: string;
  /** The state the companion device reported for its own microphone. */
  permissionState: PermissionState;
  /** Overrides the configured TTL; must be shorter, never longer. */
  ttlSeconds?: number;
};

/**
 * Mint a short-lived LiveKit access token for one participant in one room.
 *
 * The room name and participant identity are *derived* from the server and
 * session ids rather than accepted as arguments. Accepting them would let a
 * caller request a token for another server's room — the cross-server access
 * that §12 requires preventing.
 *
 * Publish capability follows `canPublishForState`, so a player whose OS
 * permission is denied or revoked receives a listen-only token. That cannot
 * grant a microphone, but it does mean a compromised or buggy companion cannot
 * transmit on their behalf.
 */
export async function mintVoiceToken(params: MintVoiceTokenParams): Promise<MintResult> {
  const configResult = readVoiceServiceConfig();
  if (!configResult.ok) return { ok: false, reason: 'voice_not_configured' };
  const { config } = configResult;

  if (!isValidPermissionState(params.permissionState)) {
    return { ok: false, reason: 'invalid_identity', detail: 'unknown permission state' };
  }

  let room: string;
  let identity: string;
  try {
    room = voiceRoomName(params.serverId);
    identity = voiceParticipantIdentity(params.sessionId);
  } catch (error) {
    // voiceRoomName/voiceParticipantIdentity throw on a malformed uuid. That is
    // a caller bug or a tampered request, not a crash-worthy condition.
    return {
      ok: false,
      reason: error instanceof Error && /room/i.test(error.message) ? 'invalid_room' : 'invalid_identity',
      detail: error instanceof Error ? error.message : undefined,
    };
  }

  const ttlSeconds = Math.min(
    params.ttlSeconds ?? config.tokenTtlSeconds,
    config.tokenTtlSeconds, // a caller may shorten a token but never lengthen it
  );
  const canPublish = canPublishForState(params.permissionState);

  try {
    const accessToken = new AccessToken(config.apiKey, config.apiSecret, {
      identity,
      // Trimmed and capped: this is rendered in other players' UIs.
      name: params.displayName.trim().slice(0, 32),
      ttl: ttlSeconds,
    });
    accessToken.addGrant({
      roomJoin: true,
      room,
      canPublish,
      canSubscribe: true,
      // Data channels and metadata writes are not used and are left off, so a
      // stolen token cannot rename itself or inject messages.
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });

    const token = await accessToken.toJwt();
    return { ok: true, token, expiresInSeconds: ttlSeconds, canPublish };
  } catch (error) {
    // Never leak the API secret in an error message.
    return {
      ok: false,
      reason: 'mint_failed',
      detail: error instanceof Error ? error.message.replace(config.apiSecret, '[redacted]') : 'unknown error',
    };
  }
}

/**
 * Decode a minted token's claims WITHOUT verifying the signature.
 *
 * For tests and diagnostics only. Verification is the SFU's job: it holds the
 * secret and rejects a token it did not accept. Nothing here should treat the
 * output as trusted, and no authorisation decision may be based on it.
 */
export function decodeTokenClaimsUnverified(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
