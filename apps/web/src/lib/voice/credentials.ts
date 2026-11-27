/**
 * Voice credential primitives — generation, hashing and comparison.
 *
 * Deliberately pure: no environment access, no database, no network, and no
 * `server-only` marker. That keeps the security-critical arithmetic testable in
 * isolation. The module that reads secrets and mints LiveKit tokens is
 * `./tokens.ts`, which is server-only.
 *
 * Nothing in here is itself a secret. It contains the functions that *produce*
 * and *compare* secrets.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  VOICE_CODE_ALPHABET,
  VOICE_CODE_LENGTH,
  VOICE_CODE_MAX_ATTEMPTS,
  VOICE_CODE_TTL_SECONDS,
  isValidVoiceCode,
  normaliseVoiceCode,
  type PermissionState,
} from '@oghost/shared';

/**
 * Prefix for companion device session tokens.
 *
 * Mirrors the existing `ogt_` node-token convention so a leaked string is
 * recognisable and revocable by type, and so log scanners can spot one.
 */
export const SESSION_TOKEN_PREFIX = 'ogv_';

/** Session tokens are 32 random bytes → 256 bits, base64url without padding. */
const SESSION_TOKEN_BYTES = 32;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Generate a one-time verification code and its hash.
 *
 * Uses `crypto.randomInt`, which is a CSPRNG and unbiased — unlike
 * `Math.random() % n`, which is both predictable and modulo-biased.
 *
 * The plaintext is returned exactly once, to be shown in Minecraft or on the
 * owner dashboard. Only `codeHash` is persisted.
 */
export function generateVerificationCode(): { code: string; codeHash: string } {
  let code = '';
  for (let i = 0; i < VOICE_CODE_LENGTH; i += 1) {
    code += VOICE_CODE_ALPHABET[randomInt(0, VOICE_CODE_ALPHABET.length)];
  }
  return { code, codeHash: verificationCodeHash(code) };
}

/**
 * Hash a candidate code for storage or comparison.
 *
 * Normalises first, so a player typing lowercase or with spaces still matches.
 * Plain SHA-256 rather than a slow KDF: an 8-character code has only ~39.7 bits
 * of entropy, so a slow hash would not meaningfully protect it anyway. What
 * actually protects it is that the hash column is unreadable from a browser,
 * the code expires in 120 seconds, and redemption is capped at 5 attempts.
 */
export function verificationCodeHash(code: string): string {
  return sha256Hex(normaliseVoiceCode(code));
}

/**
 * Generate a companion device session token and its hash.
 *
 * 256 bits of entropy, so SHA-256 at rest is appropriate here (unlike the
 * short verification code). The plaintext is returned once to the companion app
 * and is not recoverable afterwards.
 */
export function generateSessionToken(): { token: string; tokenHash: string } {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  // randomInt is used per byte to avoid pulling in webcrypto; 32 calls is cheap
  // and this runs once per device pairing, not per audio frame.
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = randomInt(0, 256);
  const token = `${SESSION_TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
  return { token, tokenHash: sessionTokenHash(token) };
}

export function sessionTokenHash(token: string): string {
  return sha256Hex(token.trim());
}

export function isValidSessionToken(token: string): boolean {
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return false;
  const body = token.slice(SESSION_TOKEN_PREFIX.length);
  // 32 bytes → 43 base64url characters without padding.
  return /^[A-Za-z0-9_-]{43}$/.test(body);
}

/** Mask a token for logs: prefix, first two and last two characters only. */
export function maskToken(token: string): string {
  if (token.length <= 8) return `${SESSION_TOKEN_PREFIX}****`;
  return `${token.slice(0, SESSION_TOKEN_PREFIX.length + 2)}****${token.slice(-2)}`;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Comparison is done on hashes, so the timing signal is already far weaker than
 * comparing a secret directly. This is belt-and-braces: `timingSafeEqual` throws
 * on length mismatch, so the lengths are checked first to avoid turning a
 * mismatch into an exception an attacker could use as an oracle.
 */
export function hashesMatch(candidateHex: string, expectedHex: string): boolean {
  // Reject empty input before anything else. Two empty strings are trivially
  // "equal", and a security primitive that returns true for an empty digest
  // would match any row whose hash column was never populated.
  if (!candidateHex || !expectedHex) return false;
  if (candidateHex.length !== expectedHex.length) return false;
  const a = Buffer.from(candidateHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** True when a candidate code matches a stored hash. */
export function codeMatchesHash(candidateCode: string, expectedHash: string): boolean {
  if (!isValidVoiceCode(normaliseVoiceCode(candidateCode))) return false;
  return hashesMatch(verificationCodeHash(candidateCode), expectedHash);
}

/** True when a stored session token hash matches a presented token. */
export function sessionTokenMatchesHash(presentedToken: string, expectedHash: string): boolean {
  if (!isValidSessionToken(presentedToken)) return false;
  return hashesMatch(sessionTokenHash(presentedToken), expectedHash);
}

/** Expiry for a code issued at `issuedAt`. */
export function codeExpiresAt(issuedAt: Date, ttlSeconds: number = VOICE_CODE_TTL_SECONDS): Date {
  return new Date(issuedAt.getTime() + ttlSeconds * 1000);
}

/**
 * Whether a timestamp has passed.
 *
 * Accepts what Postgres returns (an ISO string) as well as a Date, because the
 * driver hands back strings for timestamptz and silently comparing one to a
 * Date would always be false.
 */
export function isExpired(expiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (expiresAt === null || expiresAt === undefined) return true;
  const when = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return true; // unparseable ⇒ treat as expired, fail closed
  return when.getTime() <= now.getTime();
}

/**
 * Whether a code may still be attempted.
 *
 * `>=` not `>`: after the fifth failure the code is dead even if it has not yet
 * expired. Combined with a 120-second lifetime this makes brute force pointless
 * — 5 tries against a 31^8 space.
 */
export function attemptsExhausted(attempts: number): boolean {
  // Fail closed. A negative or non-finite count is corrupted data, and treating
  // it as "fresh" would hand out unlimited guesses against a 39.7-bit code.
  if (!Number.isFinite(attempts) || attempts < 0) return true;
  return attempts >= VOICE_CODE_MAX_ATTEMPTS;
}

/**
 * Which publish capability a LiveKit token should carry for a permission state.
 *
 * This is the server-side half of §4. It cannot grant a microphone — only the
 * operating system and the player can do that — but it can refuse the capability
 * outright, so a player whose permission is denied or revoked cannot transmit
 * even if the companion app is buggy or tampered with.
 *
 * `mic_muted` still receives publish capability: muting is the player's own
 * control, and removing the capability would force a token round-trip every time
 * they unmuted. Muted means the device is not sending, not that it is forbidden.
 *
 * `permission_granted` also receives it — the OS has allowed capture and the
 * player may activate the mic. Granting the capability is not the same as
 * starting capture, and the companion must still wait for the player.
 */
export function canPublishForState(state: PermissionState): boolean {
  return state === 'permission_granted' || state === 'mic_active' || state === 'mic_muted';
}
