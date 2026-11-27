import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_STATES, VOICE_CODE_ALPHABET, type PermissionState } from '@oghost/shared';
import {
  SESSION_TOKEN_PREFIX,
  attemptsExhausted,
  canPublishForState,
  codeExpiresAt,
  codeMatchesHash,
  generateSessionToken,
  generateVerificationCode,
  hashesMatch,
  isExpired,
  isValidSessionToken,
  maskToken,
  sessionTokenHash,
  sessionTokenMatchesHash,
  sha256Hex,
  verificationCodeHash,
} from '../src/lib/voice/credentials';

describe('verification code generation', () => {
  it('produces codes in exactly the shared format', () => {
    for (let i = 0; i < 50; i += 1) {
      const { code } = generateVerificationCode();
      expect(code).toHaveLength(8);
      for (const char of code) expect(VOICE_CODE_ALPHABET).toContain(char);
    }
  });

  it('never emits the ambiguous characters a player would misread', () => {
    // 0/O and 1/I/L are excluded from the alphabet because this code is read off
    // a Minecraft screen, often small and at a distance.
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const { code } = generateVerificationCode();
      for (const char of code) seen.add(char);
    }
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(seen.has(bad), `code alphabet must never contain ${bad}`).toBe(false);
    }
  });

  it('is actually random — 200 codes are distinct and spread across the alphabet', () => {
    const codes = new Set<string>();
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i += 1) {
      const { code } = generateVerificationCode();
      codes.add(code);
      for (const char of code) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(codes.size, 'generated codes must not repeat').toBe(200);
    // 1600 draws over a 31-symbol alphabet: a modulo-biased or seeded RNG would
    // leave some symbols unused or wildly over-represented.
    expect(counts.size, 'should exercise most of the alphabet').toBeGreaterThan(25);
  });

  it('returns the hash alongside the plaintext, and the hash is stable', () => {
    const { code, codeHash } = generateVerificationCode();
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verificationCodeHash(code)).toBe(codeHash);
  });
});

describe('code hashing and comparison', () => {
  const { code, codeHash } = generateVerificationCode();

  it('matches regardless of case, spaces and separators', () => {
    // Players retype what they read; the format must be forgiving on input while
    // the stored hash stays canonical.
    expect(codeMatchesHash(code, codeHash)).toBe(true);
    expect(codeMatchesHash(code.toLowerCase(), codeHash)).toBe(true);
    expect(codeMatchesHash(` ${code} `, codeHash)).toBe(true);
    expect(
      codeMatchesHash(`${code.slice(0, 4)}-${code.slice(4)}`, codeHash),
    ).toBe(true);
  });

  it('rejects a different code', () => {
    const other = generateVerificationCode();
    expect(codeMatchesHash(other.code, codeHash)).toBe(false);
    expect(codeMatchesHash('AAAAAAAA', codeHash)).toBe(false);
  });

  it('rejects malformed input before hashing', () => {
    expect(codeMatchesHash('', codeHash)).toBe(false);
    expect(codeMatchesHash('short', codeHash)).toBe(false);
    // A near-miss that reintroduces an excluded character.
    expect(codeMatchesHash(`${code.slice(0, 7)}O`, codeHash)).toBe(false);
  });

  it('does not leak the code through its hash', () => {
    expect(codeHash).not.toContain(code);
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('constant-time hash comparison', () => {
  it('compares equal hashes', () => {
    const h = sha256Hex('hello');
    expect(hashesMatch(h, sha256Hex('hello'))).toBe(true);
  });

  it('compares unequal hashes', () => {
    expect(hashesMatch(sha256Hex('hello'), sha256Hex('world'))).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    // timingSafeEqual throws when lengths differ. An exception here would be an
    // oracle: an attacker could distinguish "wrong length" from "wrong value".
    expect(() => hashesMatch('abcd', sha256Hex('x'))).not.toThrow();
    expect(hashesMatch('abcd', sha256Hex('x'))).toBe(false);
    expect(hashesMatch('', '')).toBe(false);
  });

  it('is symmetric', () => {
    const a = sha256Hex('a');
    const b = sha256Hex('b');
    expect(hashesMatch(a, b)).toBe(hashesMatch(b, a));
  });
});

describe('device session tokens', () => {
  it('uses the ogv_ prefix and 256 bits of entropy', () => {
    const { token, tokenHash } = generateSessionToken();
    expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(SESSION_TOKEN_PREFIX).toBe('ogv_');
    expect(isValidSessionToken(token)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionTokenHash(token)).toBe(tokenHash);
  });

  it('generates distinct tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i += 1) tokens.add(generateSessionToken().token);
    expect(tokens.size).toBe(200);
  });

  it('validates a presented token against its hash', () => {
    const { token, tokenHash } = generateSessionToken();
    expect(sessionTokenMatchesHash(token, tokenHash)).toBe(true);
    expect(sessionTokenMatchesHash(generateSessionToken().token, tokenHash)).toBe(false);
  });

  it('rejects malformed tokens without hashing them', () => {
    for (const bad of ['', 'ogv_', 'ogv_short', 'ogt_' + 'A'.repeat(43), 'ogv_' + 'A'.repeat(42), `ogv_${'!'.repeat(43)}`]) {
      expect(isValidSessionToken(bad), `must reject ${JSON.stringify(bad)}`).toBe(false);
      expect(sessionTokenMatchesHash(bad, sha256Hex('anything'))).toBe(false);
    }
  });

  it('masks a token so logs cannot leak it', () => {
    const { token } = generateSessionToken();
    const masked = maskToken(token);
    expect(masked).toContain('****');
    expect(masked).not.toBe(token);
    // Only the prefix plus two characters at each end survive.
    const revealed = masked.replace(/\*/g, '');
    expect(revealed.length).toBeLessThanOrEqual(SESSION_TOKEN_PREFIX.length + 4);
    expect(token.includes(masked.replace('****', ''))).toBe(false);
  });

  it('masks a short string without revealing it', () => {
    expect(maskToken('abc')).toBe(`${SESSION_TOKEN_PREFIX}****`);
  });
});

describe('expiry handling', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');

  it('treats a past timestamp as expired', () => {
    expect(isExpired(new Date('2026-11-27T11:59:59.000Z'), now)).toBe(true);
    expect(isExpired('2026-11-27T11:59:59.000Z', now)).toBe(true);
  });

  it('treats a future timestamp as valid', () => {
    expect(isExpired(new Date('2026-11-27T12:00:01.000Z'), now)).toBe(false);
    expect(isExpired('2026-11-27T12:00:01.000Z', now)).toBe(false);
  });

  it('handles the ISO string Postgres actually returns', () => {
    // The driver returns text for timestamptz. Comparing that to a Date with <=
    // would silently be false and let an expired code through.
    const fromDb = '2026-11-27 12:00:01+00';
    expect(isExpired(fromDb, now)).toBe(false);
  });

  it('fails closed on null, undefined and unparseable values', () => {
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired(undefined, now)).toBe(true);
    expect(isExpired('not-a-date', now)).toBe(true);
    expect(isExpired(new Date(Number.NaN), now)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    expect(isExpired(now.toISOString(), now)).toBe(true);
  });

  it('computes a code expiry from the shared TTL', () => {
    const issued = new Date('2026-11-27T12:00:00.000Z');
    expect(codeExpiresAt(issued).toISOString()).toBe('2026-11-27T12:02:00.000Z');
    expect(codeExpiresAt(issued, 60).toISOString()).toBe('2026-11-27T12:01:00.000Z');
  });
});

describe('attempt limiting', () => {
  it('allows four attempts and refuses the fifth', () => {
    expect(attemptsExhausted(0)).toBe(false);
    expect(attemptsExhausted(4)).toBe(false);
    expect(attemptsExhausted(5)).toBe(true);
    expect(attemptsExhausted(99)).toBe(true);
  });

  it('fails closed on a corrupted count', () => {
    // A negative or non-finite attempt count is corrupted data. Treating it as
    // "fresh" would hand out unlimited guesses against a 39.7-bit code.
    expect(attemptsExhausted(-1)).toBe(true);
    expect(attemptsExhausted(Number.NaN)).toBe(true);
    expect(attemptsExhausted(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('canPublishForState — the server-side half of §4', () => {
  it('grants publish capability only for the three states that may transmit', () => {
    const expected: Record<PermissionState, boolean> = {
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
      expect(canPublishForState(state), `canPublishForState(${state})`).toBe(expected[state]);
    }
  });

  it('covers every permission state, so a new state cannot default to publishable', () => {
    // If a state were added to PERMISSION_STATES without updating the mapping,
    // the switch would fall through. Every state is asserted above, so a new one
    // makes that test fail rather than silently granting capability.
    expect(PERMISSION_STATES).toHaveLength(10);
  });

  it('denies capability when permission was revoked mid-session', () => {
    // §4: revocation must immediately stop capture and transmission. The device
    // stops sending; this stops a refreshed token from restoring the capability.
    expect(canPublishForState('permission_revoked')).toBe(false);
    expect(canPublishForState('mic_active')).toBe(true);
  });

  it('denies capability when permission was never requested', () => {
    // Joining Minecraft must not imply microphone access.
    expect(canPublishForState('not_requested')).toBe(false);
  });

  it('keeps capability while muted, so unmuting needs no token round-trip', () => {
    // Muting is the player's own control. Removing the capability would add
    // latency to every unmute; muting itself is enforced by the device not
    // sending, and by transmitting=false in the session row.
    expect(canPublishForState('mic_muted')).toBe(true);
    expect(canPublishForState('permission_granted')).toBe(true);
  });
});
