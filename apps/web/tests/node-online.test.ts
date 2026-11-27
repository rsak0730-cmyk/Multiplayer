import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNodeOnline } from '@/lib/commands';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const seenAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('isNodeOnline', () => {
  it('is true for a node that just sent a heartbeat', () => {
    expect(isNodeOnline({ last_seen_at: seenAgo(0), revoked_at: null })).toBe(true);
  });

  it.each([1_000, 15_000, 30_000, 60_000, 89_000])(
    'is true %d ms after the last heartbeat',
    (ms) => {
      expect(isNodeOnline({ last_seen_at: seenAgo(ms), revoked_at: null })).toBe(true);
    },
  );

  it.each([91_000, 120_000, 600_000, 86_400_000])(
    'is false %d ms after the last heartbeat',
    (ms) => {
      expect(isNodeOnline({ last_seen_at: seenAgo(ms), revoked_at: null })).toBe(false);
    },
  );

  it('is false for a node that has never reported', () => {
    expect(isNodeOnline({ last_seen_at: null, revoked_at: null })).toBe(false);
  });

  it('is false for a revoked node even if it just sent a heartbeat', () => {
    // Revocation must win immediately. A revoked device that is still talking to
    // the control plane must never be shown as usable.
    expect(
      isNodeOnline({ last_seen_at: seenAgo(0), revoked_at: seenAgo(0) }),
    ).toBe(false);
  });

  it('is false for a revoked node that went quiet long ago', () => {
    expect(
      isNodeOnline({ last_seen_at: seenAgo(600_000), revoked_at: seenAgo(300_000) }),
    ).toBe(false);
  });

  it('survives several missed heartbeats before flipping offline', () => {
    // Heartbeats arrive every 15s and the window is 90s, so a node must miss
    // roughly six before the UI says offline. One dropped packet must not do it.
    const oneHeartbeat = 15_000;
    expect(isNodeOnline({ last_seen_at: seenAgo(oneHeartbeat * 3), revoked_at: null })).toBe(true);
    expect(isNodeOnline({ last_seen_at: seenAgo(oneHeartbeat * 5), revoked_at: null })).toBe(true);
    expect(isNodeOnline({ last_seen_at: seenAgo(oneHeartbeat * 7), revoked_at: null })).toBe(false);
  });

  it('is false for an unparseable timestamp rather than guessing', () => {
    expect(isNodeOnline({ last_seen_at: 'not-a-date', revoked_at: null })).toBe(false);
  });
});

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first request for a key', () => {
    expect(checkRateLimit(`first-${Date.now()}`)).toBe(true);
  });

  it('tracks keys independently', () => {
    expect(checkRateLimit('user-a')).toBe(true);
    expect(checkRateLimit('user-b')).toBe(true);
    expect(checkRateLimit('user-a')).toBe(true);
  });

  it('blocks once the per-window budget is exhausted', () => {
    const key = 'budget-test';
    const max = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);

    for (let i = 0; i < max; i += 1) {
      expect(checkRateLimit(key), `request ${i + 1} of ${max} should be allowed`).toBe(true);
    }
    expect(checkRateLimit(key), 'the request after the budget should be blocked').toBe(false);
    expect(checkRateLimit(key)).toBe(false);
  });

  it('resets after the window elapses', () => {
    const key = 'window-reset';
    const max = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);
    const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);

    for (let i = 0; i < max + 5; i += 1) checkRateLimit(key);
    expect(checkRateLimit(key)).toBe(false);

    vi.advanceTimersByTime(windowSeconds * 1000 + 1);
    expect(checkRateLimit(key), 'a new window must start with a fresh budget').toBe(true);
  });

  it('does not reset before the window elapses', () => {
    const key = 'no-early-reset';
    const max = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);
    const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);

    for (let i = 0; i < max + 1; i += 1) checkRateLimit(key);
    vi.advanceTimersByTime(windowSeconds * 1000 - 1_000);
    expect(checkRateLimit(key)).toBe(false);
  });
});

describe('rateLimitResponse', () => {
  it('answers 429 with a message a person can act on', async () => {
    const response = rateLimitResponse();
    expect(response.status).toBe(429);

    const body = (await response.json()) as { error?: string };
    expect(typeof body.error).toBe('string');
    expect(body.error!.length).toBeGreaterThan(0);
    // It must not leak implementation detail or blame the user.
    expect(body.error).not.toMatch(/redis|upstash|bucket|internal/i);
  });
});
