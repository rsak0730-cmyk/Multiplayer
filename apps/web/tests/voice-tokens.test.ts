import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { PERMISSION_STATES, VOICE_TOKEN_TTL_SECONDS_DEFAULT, type PermissionState } from '@oghost/shared';
import {
  MAX_VOICE_TOKEN_TTL_SECONDS,
  MIN_VOICE_TOKEN_TTL_SECONDS,
  VOICE_ENV_VARS,
  decodeTokenClaimsUnverified,
  mintVoiceToken,
  readVoiceServiceConfig,
  voiceConfigStatus,
  type VoiceConfigResult,
  type VoiceEnv,
} from '../src/lib/voice/tokens';

const SERVER_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const EXPECTED_ROOM = 'oghost-a1b2c3d4-1111-4111-8111-111111111111';
const EXPECTED_IDENTITY = `p-${SESSION_ID}`;

const API_KEY = 'APItestkey';
const API_SECRET = 'super-secret-value-that-must-never-leak';

/**
 * Typed as `VoiceEnv`, the narrow shape `readVoiceServiceConfig` declares.
 *
 * Typing it as a literal object and casting at each call site does not work: a
 * spread with a computed key (`{ ...VALID_ENV, [name]: 'x' }`) collapses to a
 * single-property type that cannot be cast to an environment without
 * `as unknown as`. Declaring the type once here keeps every call site clean.
 */
const VALID_ENV: VoiceEnv = {
  LIVEKIT_URL: 'wss://voice.example.com',
  LIVEKIT_API_KEY: API_KEY,
  LIVEKIT_API_SECRET: API_SECRET,
};

type ValidConfig = Extract<VoiceConfigResult, { ok: true }>;

function configured(): ValidConfig {
  const result = readVoiceServiceConfig(VALID_ENV);
  if (!result.ok) throw new Error(`expected a valid config, got ${result.reason}`);
  return result;
}

type Claims = {
  name?: string;
  sub?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  video?: Record<string, unknown>;
};

describe('readVoiceServiceConfig', () => {
  it('accepts a complete wss configuration', () => {
    const result = configured();
    expect(result.config.url).toBe('wss://voice.example.com');
    expect(result.config.tokenTtlSeconds).toBe(VOICE_TOKEN_TTL_SECONDS_DEFAULT);
  });

  it.each([
    ['LIVEKIT_URL', 'missing_url'],
    ['LIVEKIT_API_KEY', 'missing_api_key'],
    ['LIVEKIT_API_SECRET', 'missing_api_secret'],
  ] as const)('reports %s when absent', (name, reason) => {
    const env = { ...VALID_ENV };
    delete env[name];
    expect(readVoiceServiceConfig(env)).toEqual({ ok: false, reason });
  });

  it.each([['LIVEKIT_URL'], ['LIVEKIT_API_KEY'], ['LIVEKIT_API_SECRET']])('treats a blank %s as missing', (name) => {
    expect(readVoiceServiceConfig({ ...VALID_ENV, [name]: '   ' }).ok).toBe(false);
  });

  it('names every required variable so the dashboard can say what to set', () => {
    expect(VOICE_ENV_VARS).toEqual(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']);
  });

  it.each(['https://voice.example.com', 'voice.example.com', 'wss://', 'ftp://x', 'wss://exa mple.com'])(
    'rejects the malformed url %j',
    (url) => {
      expect(readVoiceServiceConfig({ ...VALID_ENV, LIVEKIT_URL: url })).toEqual({
        ok: false,
        reason: 'malformed_url',
      });
    },
  );

  it('accepts a wss url with a port and path', () => {
    expect(readVoiceServiceConfig({ ...VALID_ENV, LIVEKIT_URL: 'wss://voice.example.com:7880/livekit' }).ok).toBe(true);
  });

  it('allows cleartext ws only for loopback development', () => {
    // §9 requires encrypted transport. A phone on mobile data must never be
    // pointed at an unencrypted endpoint, but a local dev server is fine.
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(
        readVoiceServiceConfig({ ...VALID_ENV, LIVEKIT_URL: `ws://${host}:7880` }).ok,
        `ws://${host} should be allowed for development`,
      ).toBe(true);
    }
    for (const host of ['voice.example.com', '192.168.1.50', '10.0.0.4']) {
      expect(readVoiceServiceConfig({ ...VALID_ENV, LIVEKIT_URL: `ws://${host}:7880` })).toEqual({
        ok: false,
        reason: 'insecure_url',
      });
    }
  });

  it.each([
    ['0', false],
    ['59', false],
    [String(MIN_VOICE_TOKEN_TTL_SECONDS), true],
    ['3600', true],
    [String(MAX_VOICE_TOKEN_TTL_SECONDS), true],
    [String(MAX_VOICE_TOKEN_TTL_SECONDS + 1), false],
    ['abc', false],
    ['3600.5', false],
    ['-1', false],
  ])('ttl %j accepted=%s', (ttl, accepted) => {
    const result = readVoiceServiceConfig({ ...VALID_ENV, VOICE_TOKEN_TTL_SECONDS: ttl });
    if (accepted) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.tokenTtlSeconds).toBe(Number(ttl));
    } else {
      expect(result).toEqual({ ok: false, reason: 'invalid_ttl' });
    }
  });

  it('ignores a blank ttl and uses the default', () => {
    const result = readVoiceServiceConfig({ ...VALID_ENV, VOICE_TOKEN_TTL_SECONDS: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.tokenTtlSeconds).toBe(VOICE_TOKEN_TTL_SECONDS_DEFAULT);
  });
});

describe('voiceConfigStatus', () => {
  it('reports success without implying more than configuration', () => {
    expect(voiceConfigStatus(configured())).toBe('Voice service configured.');
  });

  it('names the missing variable so an owner can fix it', () => {
    for (const reason of ['missing_url', 'missing_api_key', 'missing_api_secret'] as const) {
      expect(voiceConfigStatus({ ok: false, reason })).toContain('not configured');
    }
    expect(voiceConfigStatus({ ok: false, reason: 'missing_url' })).toContain('LIVEKIT_URL');
    expect(voiceConfigStatus({ ok: false, reason: 'missing_api_key' })).toContain('LIVEKIT_API_KEY');
    expect(voiceConfigStatus({ ok: false, reason: 'missing_api_secret' })).toContain('LIVEKIT_API_SECRET');
  });

  it('explains why an insecure url is refused', () => {
    expect(voiceConfigStatus({ ok: false, reason: 'insecure_url' })).toContain('unencrypted');
  });

  it('never echoes a secret value into a status string', () => {
    for (const reason of [
      'missing_url',
      'missing_api_key',
      'missing_api_secret',
      'insecure_url',
      'malformed_url',
      'invalid_ttl',
    ] as const) {
      expect(voiceConfigStatus({ ok: false, reason })).not.toContain(API_SECRET);
    }
  });
});

describe('mintVoiceToken', () => {
  beforeEach(() => {
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    for (const key of [...Object.keys(VALID_ENV), 'VOICE_TOKEN_TTL_SECONDS']) delete process.env[key];
  });

  async function mint(overrides: Partial<Parameters<typeof mintVoiceToken>[0]> = {}) {
    const result = await mintVoiceToken({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      displayName: 'Steve',
      permissionState: 'mic_active',
      ...overrides,
    });
    if (!result.ok) throw new Error(`mint failed: ${result.reason}`);
    return result;
  }

  it('produces a real three-segment JWT', async () => {
    const { token } = await mint();
    expect(token.split('.')).toHaveLength(3);
    expect(token.length).toBeGreaterThan(100);
  });

  it('DERIVES the room from the server id rather than accepting one', async () => {
    // §12: cross-server voice access must be impossible. A caller cannot ask for
    // another server's room because the room name is never an input.
    const { token } = await mint();
    const claims = decodeTokenClaimsUnverified(token) as Claims;
    expect(claims.video?.room).toBe(EXPECTED_ROOM);
    expect(claims.video?.roomJoin).toBe(true);
  });

  it('DERIVES the participant identity from the session id', async () => {
    const { token } = await mint();
    const claims = decodeTokenClaimsUnverified(token) as Claims;
    expect(claims.sub).toBe(EXPECTED_IDENTITY);
  });

  it('a different server id produces a different room', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const a = decodeTokenClaimsUnverified((await mint()).token) as Claims;
    const b = decodeTokenClaimsUnverified(
      (await mint({ serverId: other, sessionId: '44444444-4444-4444-8444-444444444444' })).token,
    ) as Claims;
    expect(a.video?.room).not.toBe(b.video?.room);
    expect(a.sub).not.toBe(b.sub);
  });

  it('sets the expiry from the configured ttl', async () => {
    const { token, expiresInSeconds } = await mint();
    const claims = decodeTokenClaimsUnverified(token) as Claims;
    expect(expiresInSeconds).toBe(VOICE_TOKEN_TTL_SECONDS_DEFAULT);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(VOICE_TOKEN_TTL_SECONDS_DEFAULT);
  });

  it('lets a caller shorten a token but never lengthen it', async () => {
    expect((await mint({ ttlSeconds: 300 })).expiresInSeconds).toBe(300);
    // Asking for a day on an hour-configured service must not succeed.
    expect((await mint({ ttlSeconds: 86_400 })).expiresInSeconds).toBe(VOICE_TOKEN_TTL_SECONDS_DEFAULT);
    expect((await mint({ ttlSeconds: 999_999 })).expiresInSeconds).toBe(VOICE_TOKEN_TTL_SECONDS_DEFAULT);
  });

  it('carries the display name, capped and trimmed', async () => {
    const claims = decodeTokenClaimsUnverified((await mint({ displayName: '  Steve  ' })).token) as Claims;
    expect(claims.name).toBe('Steve');

    const long = decodeTokenClaimsUnverified((await mint({ displayName: 'x'.repeat(200) })).token) as Claims;
    expect((long.name ?? '').length).toBe(32);
  });

  it('grants subscribe always, and publish only where the state allows', async () => {
    const expectedPublish: Record<PermissionState, boolean> = {
      not_requested: false,
      permission_required: false,
      permission_granted: true,
      permission_denied: false,
      permission_permanently_denied: false,
      permission_revoked: false,
      mic_active: true,
      mic_muted: true,
      device_unavailable: false,
      disconnected: false,
    };

    for (const state of PERMISSION_STATES) {
      const result = await mint({ permissionState: state });
      const claims = decodeTokenClaimsUnverified(result.token) as Claims;
      expect(result.canPublish, `result.canPublish for ${state}`).toBe(expectedPublish[state]);
      expect(claims.video?.canPublish, `token grant for ${state}`).toBe(expectedPublish[state]);
      // Listening is always allowed: §4 requires a player whose mic is denied to
      // stay in Minecraft and still hear others.
      expect(claims.video?.canSubscribe, `canSubscribe for ${state}`).toBe(true);
    }
  });

  it('issues a listen-only token when the mic was denied', async () => {
    // This is what makes §20's "deny mic on one device, verify it cannot
    // transmit" a server-enforced property rather than a client-side promise.
    const { token, canPublish } = await mint({ permissionState: 'permission_denied' });
    expect(canPublish).toBe(false);
    expect((decodeTokenClaimsUnverified(token) as Claims).video?.canPublish).toBe(false);
    expect((decodeTokenClaimsUnverified(token) as Claims).video?.canSubscribe).toBe(true);
  });

  it('issues a listen-only token after a mid-session revocation', async () => {
    const { canPublish } = await mint({ permissionState: 'permission_revoked' });
    expect(canPublish).toBe(false);
  });

  it('never grants data channels or metadata writes', async () => {
    const claims = decodeTokenClaimsUnverified((await mint()).token) as Claims;
    // Unused capabilities are left off so a stolen token cannot rename itself or
    // inject data messages into the room.
    expect(claims.video?.canPublishData).toBe(false);
    expect(claims.video?.canUpdateOwnMetadata).toBe(false);
  });

  it('uses the api key as issuer and never embeds the api secret', async () => {
    const { token } = await mint();
    const claims = decodeTokenClaimsUnverified(token) as Claims;
    // The key is an identifier, not a secret: JWTs carry it as `iss` and that is
    // expected. The secret only ever appears as the signature.
    expect(claims.iss).toBe(API_KEY);
    expect(token).not.toContain(API_SECRET);
    expect(JSON.stringify(claims)).not.toContain(API_SECRET);
  });

  it('refuses a malformed server id instead of building a room name from it', async () => {
    for (const bad of ['not-a-uuid', '', '../../etc', 'oghost-evil']) {
      const result = await mintVoiceToken({
        serverId: bad,
        sessionId: SESSION_ID,
        displayName: 'Steve',
        permissionState: 'mic_active',
      });
      expect(result.ok, `serverId ${JSON.stringify(bad)} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_room');
    }
  });

  it('refuses a malformed session id instead of building an identity from it', async () => {
    const result = await mintVoiceToken({
      serverId: SERVER_ID,
      sessionId: 'Steve',
      displayName: 'Steve',
      permissionState: 'mic_active',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_identity');
  });

  it('reports not-configured rather than throwing when the SFU is unset', async () => {
    // §10: voice failure must never crash OG HOST. A fresh install with no voice
    // server is an expected state.
    delete process.env.LIVEKIT_URL;
    const result = await mintVoiceToken({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      displayName: 'Steve',
      permissionState: 'mic_active',
    });
    expect(result).toEqual({ ok: false, reason: 'voice_not_configured' });
  });

  it('produces a token the SFU can verify with the same key pair', async () => {
    // Minting is only half the contract: the self-hosted server has to accept it.
    // Verifying here catches a key/grant mismatch before it becomes a room that
    // silently refuses every player.
    const { token } = await mint();
    const verifier = new TokenVerifier(API_KEY, API_SECRET);
    const claims = await verifier.verify(token);
    // LiveKit carries the participant identity in the standard JWT `sub` claim.
    expect(claims.sub).toBe(EXPECTED_IDENTITY);
    expect(claims.video?.room).toBe(EXPECTED_ROOM);
    expect(claims.video?.roomJoin).toBe(true);
  });

  it('rejects verification under a different api secret', async () => {
    const { token } = await mint();
    await expect(new TokenVerifier(API_KEY, 'a-different-secret').verify(token)).rejects.toThrow();
  });

  it('binds the room and identity cryptographically, so a captured token cannot be redirected', async () => {
    // §12 requires preventing cross-server voice access and session hijacking.
    // Rewriting the room in the payload must break the signature rather than
    // quietly succeed.
    const { token } = await mint();
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    claims.video = { ...claims.video, room: 'oghost-someone-elses-server' };
    claims.sub = 'p-another-player';
    const tampered = `${header}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    const verifier = new TokenVerifier(API_KEY, API_SECRET);
    await expect(verifier.verify(tampered)).rejects.toThrow();
    // And the untampered token still verifies, so the rejection was the
    // signature and not a broken token.
    await expect(verifier.verify(token)).resolves.toBeTruthy();
  });
});

describe('decodeTokenClaimsUnverified', () => {
  it('returns null for anything that is not a JWT', () => {
    expect(decodeTokenClaimsUnverified('')).toBeNull();
    expect(decodeTokenClaimsUnverified('abc')).toBeNull();
    expect(decodeTokenClaimsUnverified('a.b')).toBeNull();
    expect(decodeTokenClaimsUnverified('a.!!!.c')).toBeNull();
  });

  it('is documented as unverified', () => {
    // The function name carries the warning: no authorisation decision may rest
    // on its output, because nothing here checks the signature.
    expect(decodeTokenClaimsUnverified.name).toBe('decodeTokenClaimsUnverified');
  });
});
