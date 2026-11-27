/**
 * Voice pairing decisions — pure, no I/O.
 *
 * Redeeming a verification code is the one voice operation a stranger can
 * attempt without any prior credential, so the decision logic is separated from
 * the route and tested directly. The route's job is to fetch candidate rows and
 * act on the outcome; it makes no security decision of its own.
 */
import { VOICE_CODE_MAX_ATTEMPTS, VOICE_CODE_TTL_SECONDS } from '@oghost/shared';
import { attemptsExhausted, isExpired } from './credentials';

/**
 * How far back to look for candidate codes.
 *
 * A code lives for `VOICE_CODE_TTL_SECONDS`, but the window is wider so that a
 * *recently* consumed or expired code can still be recognised and reported
 * accurately — that is what distinguishes "you mistyped" from "that code was
 * already used", and what makes a replay attempt visible in the audit trail.
 * Bounded so the lookup cannot grow without limit.
 */
export const CODE_CANDIDATE_WINDOW_MS = 15 * 60 * 1000;

/** A row from `voice_verification_codes`, narrowed to what the decision needs. */
export interface CodeCandidate {
  id: string;
  code_hash: string;
  attempts: number;
  consumed: boolean;
  expires_at: string | Date;
  redeemed_at: string | Date | null;
}

export type CodeAttemptOutcome =
  | { outcome: 'live'; candidate: CodeCandidate }
  | { outcome: 'replay'; candidate: CodeCandidate }
  | { outcome: 'expired'; candidate: CodeCandidate }
  | { outcome: 'attempts_exhausted'; candidate: CodeCandidate }
  | { outcome: 'not_found' };

/**
 * Classify a presented code against the candidate rows for one server.
 *
 * `presentedHash` is the SHA-256 of the normalised code the companion sent.
 * Comparison is by hash, never by plaintext, so the plaintext never needs to
 * leave the device that displayed it.
 *
 * Precedence when a matching row is unusable matters:
 *
 *   1. consumed/redeemed → **replay**. Someone is presenting a code that already
 *      worked. This is reported before expiry because a consumed code is also
 *      usually expired, and "replay" is the security-relevant fact.
 *   2. attempts exhausted → the code is dead from guessing, not from the clock.
 *   3. expired → the 120 seconds ran out.
 *   4. otherwise → live, and redeemable exactly once.
 *
 * No match at all is `not_found`: either a typo or a code for a different server.
 * Both are refused identically, since a code is bound to the server it was
 * issued for and cannot be replayed across servers.
 */
export function classifyCodeAttempt(
  candidates: readonly CodeCandidate[],
  presentedHash: string,
  now: Date = new Date(),
): CodeAttemptOutcome {
  if (!presentedHash) return { outcome: 'not_found' };

  const matches = candidates.filter((candidate) => candidate.code_hash === presentedHash);
  if (matches.length === 0) return { outcome: 'not_found' };

  // Should be exactly one, but if a collision or a bug produced several, take the
  // most permissive reading so a legitimate player is not locked out: prefer a
  // live row, then exhausted, then expired, then replay.
  const candidate =
    matches.find((m) => !m.consumed && !m.redeemed_at && !isExpired(m.expires_at, now) && !attemptsExhausted(m.attempts)) ??
    matches.find((m) => !m.consumed && !m.redeemed_at && attemptsExhausted(m.attempts)) ??
    matches.find((m) => !m.consumed && !m.redeemed_at) ??
    matches[0]!;

  if (candidate.consumed || candidate.redeemed_at) {
    return { outcome: 'replay', candidate };
  }
  if (attemptsExhausted(candidate.attempts)) {
    return { outcome: 'attempts_exhausted', candidate };
  }
  if (isExpired(candidate.expires_at, now)) {
    return { outcome: 'expired', candidate };
  }
  return { outcome: 'live', candidate };
}

/**
 * The message a player sees for each outcome.
 *
 * Specific on purpose. A matching-but-consumed code means the presenter already
 * knows the correct value, so telling them it was used leaks nothing — and
 * "invalid code" for a code that expired two seconds ago sends a player to ask
 * the server owner for a new one when all they needed was to type faster.
 */
export function pairingFailureMessage(outcome: CodeAttemptOutcome): string {
  switch (outcome.outcome) {
    case 'live':
      return 'Code accepted.';
    case 'replay':
      return 'That code has already been used. Ask the server owner for a new one.';
    case 'expired':
      return `That code expired. Codes last ${VOICE_CODE_TTL_SECONDS} seconds — ask the server owner for a new one.`;
    case 'attempts_exhausted':
      return `Too many incorrect attempts. Codes stop working after ${VOICE_CODE_MAX_ATTEMPTS} tries — ask the server owner for a new one.`;
    case 'not_found':
      return 'That code is not valid for this server. Check the characters and try again.';
  }
}

/** HTTP status for a failed redemption. All failures are 401: no distinction is worth leaking. */
export function pairingFailureStatus(outcome: CodeAttemptOutcome): number {
  return outcome.outcome === 'live' ? 200 : 401;
}

/** The `voice_connection_events.event_type` to record for an outcome. */
export function pairingEventType(
  outcome: CodeAttemptOutcome,
): 'code_redeemed' | 'code_rejected' | 'code_expired' | 'code_attempt_limit' | 'unauthorized_link_attempt' {
  switch (outcome.outcome) {
    case 'live':
      return 'code_redeemed';
    case 'replay':
      // A reused code is the closest thing to an intrusion attempt this flow has.
      return 'unauthorized_link_attempt';
    case 'expired':
      return 'code_expired';
    case 'attempts_exhausted':
      return 'code_attempt_limit';
    case 'not_found':
      return 'code_rejected';
  }
}
