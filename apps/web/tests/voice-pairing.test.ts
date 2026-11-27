import { describe, expect, it } from 'vitest';
import {
  CODE_CANDIDATE_WINDOW_MS,
  classifyCodeAttempt,
  pairingEventType,
  pairingFailureMessage,
  pairingFailureStatus,
  type CodeCandidate,
} from '../src/lib/voice/pairing';
import { VOICE_CODE_MAX_ATTEMPTS, VOICE_CODE_TTL_SECONDS } from '@oghost/shared';
import { sha256Hex, verificationCodeHash } from '../src/lib/voice/credentials';

const NOW = new Date('2026-11-27T12:00:00.000Z');
const CODE = 'ABCD2345';
const HASH = verificationCodeHash(CODE);

function candidate(overrides: Partial<CodeCandidate> = {}): CodeCandidate {
  return {
    id: 'code-1',
    code_hash: HASH,
    attempts: 0,
    consumed: false,
    expires_at: new Date(NOW.getTime() + VOICE_CODE_TTL_SECONDS * 1000).toISOString(),
    redeemed_at: null,
    ...overrides,
  };
}

describe('classifyCodeAttempt', () => {
  it('accepts a live code', () => {
    const outcome = classifyCodeAttempt([candidate()], HASH, NOW);
    expect(outcome.outcome).toBe('live');
    if (outcome.outcome === 'live') expect(outcome.candidate.id).toBe('code-1');
  });

  it('accepts a code one millisecond before expiry', () => {
    const almostGone = candidate({ expires_at: new Date(NOW.getTime() + 1).toISOString() });
    expect(classifyCodeAttempt([almostGone], HASH, NOW).outcome).toBe('live');
  });

  it('accepts a code with attempts remaining', () => {
    expect(classifyCodeAttempt([candidate({ attempts: VOICE_CODE_MAX_ATTEMPTS - 1 })], HASH, NOW).outcome).toBe('live');
  });

  it('reports not_found when no row matches', () => {
    expect(classifyCodeAttempt([], HASH, NOW).outcome).toBe('not_found');
    expect(classifyCodeAttempt([candidate()], sha256Hex('SOMETHIN'), NOW).outcome).toBe('not_found');
  });

  it('reports not_found for an empty presented hash', () => {
    // Guards against a row whose hash column was never populated matching an
    // empty candidate.
    expect(classifyCodeAttempt([candidate({ code_hash: '' })], '', NOW).outcome).toBe('not_found');
  });

  it('reports REPLAY for a consumed code', () => {
    // §12 requires replay prevention: a code that already worked must never work
    // twice, and the attempt must be recorded as an intrusion signal.
    const outcome = classifyCodeAttempt([candidate({ consumed: true })], HASH, NOW);
    expect(outcome.outcome).toBe('replay');
    expect(pairingEventType(outcome)).toBe('unauthorized_link_attempt');
  });

  it('reports REPLAY for a code with redeemed_at set but consumed false', () => {
    // Belt and braces: the two flags are written together, but a partial write
    // must still be caught rather than treated as live.
    expect(classifyCodeAttempt([candidate({ redeemed_at: NOW.toISOString() })], HASH, NOW).outcome).toBe('replay');
  });

  it('prefers REPLAY over EXPIRED, because reuse is the security-relevant fact', () => {
    const consumedAndExpired = candidate({
      consumed: true,
      redeemed_at: new Date(NOW.getTime() - 60_000).toISOString(),
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });
    expect(classifyCodeAttempt([consumedAndExpired], HASH, NOW).outcome).toBe('replay');
  });

  it('reports expired once the TTL has passed', () => {
    const expired = candidate({ expires_at: new Date(NOW.getTime() - 1).toISOString() });
    const outcome = classifyCodeAttempt([expired], HASH, NOW);
    expect(outcome.outcome).toBe('expired');
    expect(pairingEventType(outcome)).toBe('code_expired');
  });

  it('reports expired at the exact expiry instant', () => {
    const atBoundary = candidate({ expires_at: NOW.toISOString() });
    expect(classifyCodeAttempt([atBoundary], HASH, NOW).outcome).toBe('expired');
  });

  it('reports attempts_exhausted after the cap', () => {
    const exhausted = candidate({ attempts: VOICE_CODE_MAX_ATTEMPTS });
    const outcome = classifyCodeAttempt([exhausted], HASH, NOW);
    expect(outcome.outcome).toBe('attempts_exhausted');
    expect(pairingEventType(outcome)).toBe('code_attempt_limit');
  });

  it('prefers attempts_exhausted over expired', () => {
    // A code killed by guessing is a different story from one that simply ran
    // out of time, and the player needs the right message.
    const both = candidate({
      attempts: VOICE_CODE_MAX_ATTEMPTS,
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });
    expect(classifyCodeAttempt([both], HASH, NOW).outcome).toBe('attempts_exhausted');
  });

  it('treats a corrupted attempt count as exhausted', () => {
    expect(classifyCodeAttempt([candidate({ attempts: -1 })], HASH, NOW).outcome).toBe('attempts_exhausted');
    expect(classifyCodeAttempt([candidate({ attempts: Number.NaN })], HASH, NOW).outcome).toBe('attempts_exhausted');
  });

  it('prefers a live row when several rows match the same hash', () => {
    // Should not happen, but a duplicate must not lock a legitimate player out.
    const rows = [
      candidate({ id: 'consumed', consumed: true }),
      candidate({ id: 'expired', expires_at: new Date(NOW.getTime() - 1).toISOString() }),
      candidate({ id: 'live' }),
    ];
    const outcome = classifyCodeAttempt(rows, HASH, NOW);
    expect(outcome.outcome).toBe('live');
    if (outcome.outcome === 'live') expect(outcome.candidate.id).toBe('live');
  });

  it('falls back sensibly when no row is live', () => {
    const rows = [
      candidate({ id: 'consumed', consumed: true }),
      candidate({ id: 'exhausted', attempts: VOICE_CODE_MAX_ATTEMPTS }),
    ];
    // Exhausted is more informative than replay here, and the precedence inside
    // classifyCodeAttempt picks the non-consumed row first.
    expect(classifyCodeAttempt(rows, HASH, NOW).outcome).toBe('attempts_exhausted');
  });

  it('handles a Date object as well as the ISO string Postgres returns', () => {
    expect(classifyCodeAttempt([candidate({ expires_at: new Date(NOW.getTime() + 60_000) })], HASH, NOW).outcome).toBe(
      'live',
    );
    expect(classifyCodeAttempt([candidate({ expires_at: new Date(NOW.getTime() - 60_000) })], HASH, NOW).outcome).toBe(
      'expired',
    );
  });

  it('has a candidate window wider than the code lifetime', () => {
    // The window exists so a recently consumed or expired code is still
    // recognisable and can be reported accurately rather than as "not found".
    expect(CODE_CANDIDATE_WINDOW_MS).toBeGreaterThan(VOICE_CODE_TTL_SECONDS * 1000);
  });
});

describe('pairingFailureMessage', () => {
  it('gives a distinct, actionable message per outcome', () => {
    expect(pairingFailureMessage({ outcome: 'not_found' })).toContain('not valid for this server');
    expect(pairingFailureMessage({ outcome: 'expired', candidate: candidate() })).toContain('expired');
    expect(pairingFailureMessage({ outcome: 'replay', candidate: candidate() })).toContain('already been used');
    expect(
      pairingFailureMessage({ outcome: 'attempts_exhausted', candidate: candidate() }),
    ).toContain('Too many incorrect attempts');
  });

  it('mentions the real TTL so a player knows how fast to type', () => {
    expect(pairingFailureMessage({ outcome: 'expired', candidate: candidate() })).toContain(
      String(VOICE_CODE_TTL_SECONDS),
    );
  });

  it('mentions the real attempt cap', () => {
    expect(pairingFailureMessage({ outcome: 'attempts_exhausted', candidate: candidate() })).toContain(
      String(VOICE_CODE_MAX_ATTEMPTS),
    );
  });

  it('never includes the code itself', () => {
    for (const outcome of [
      { outcome: 'not_found' } as const,
      { outcome: 'expired', candidate: candidate() } as const,
      { outcome: 'replay', candidate: candidate() } as const,
      { outcome: 'attempts_exhausted', candidate: candidate() } as const,
      { outcome: 'live', candidate: candidate() } as const,
    ]) {
      expect(pairingFailureMessage(outcome)).not.toContain(CODE);
      expect(pairingFailureMessage(outcome)).not.toContain(HASH);
    }
  });
});

describe('pairingFailureStatus', () => {
  it('is 200 only for a live code', () => {
    expect(pairingFailureStatus({ outcome: 'live', candidate: candidate() })).toBe(200);
  });

  it('is 401 for every failure, so outcomes are not distinguishable by status', () => {
    for (const outcome of ['not_found', 'expired', 'replay', 'attempts_exhausted'] as const) {
      expect(
        pairingFailureStatus(
          outcome === 'not_found' ? { outcome } : { outcome, candidate: candidate() },
        ),
      ).toBe(401);
    }
  });
});

describe('pairingEventType', () => {
  it('maps each outcome to a real voice_connection_events type', () => {
    expect(pairingEventType({ outcome: 'live', candidate: candidate() })).toBe('code_redeemed');
    expect(pairingEventType({ outcome: 'not_found' })).toBe('code_rejected');
    expect(pairingEventType({ outcome: 'expired', candidate: candidate() })).toBe('code_expired');
    expect(pairingEventType({ outcome: 'attempts_exhausted', candidate: candidate() })).toBe('code_attempt_limit');
    expect(pairingEventType({ outcome: 'replay', candidate: candidate() })).toBe('unauthorized_link_attempt');
  });

  it('produces only values the database check constraint accepts', () => {
    // The event_type column has a CHECK listing 32 values. An unmapped string
    // would fail the insert and silently lose the audit entry.
    const allowed = [
      'code_issued', 'code_redeemed', 'code_expired', 'code_rejected', 'code_attempt_limit',
      'unauthorized_link_attempt',
    ];
    for (const outcome of [
      { outcome: 'live', candidate: candidate() },
      { outcome: 'not_found' },
      { outcome: 'expired', candidate: candidate() },
      { outcome: 'attempts_exhausted', candidate: candidate() },
      { outcome: 'replay', candidate: candidate() },
    ] as const) {
      expect(allowed).toContain(pairingEventType(outcome));
    }
  });
});
