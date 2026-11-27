/**
 * Simple in-memory rate limiter (per serverless instance).
 * For production multi-instance deployments, swap for Upstash Redis —
 * the interface stays the same. See docs/SECURITY.md.
 */

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60) * 1000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);

const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitOptions {
  /** Overrides the global window for this key. */
  windowMs?: number;
  /** Overrides the global request cap for this key. */
  maxRequests?: number;
}

/**
 * Consume one unit from `key`'s bucket.
 *
 * The options are optional so every existing caller keeps the global
 * 60s/120-request behaviour. They exist because some endpoints need a much
 * tighter bound than the default: voice code redemption is a guessing surface
 * and should allow a handful of attempts, not 120.
 */
export function checkRateLimit(key: string, options: RateLimitOptions = {}): boolean {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const maxRequests = options.maxRequests ?? MAX_REQUESTS;

  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxRequests) return false;
  bucket.count += 1;
  return true;
}

/** Seconds until `key`'s bucket resets, for a Retry-After header. 0 if unknown. */
export function rateLimitRetryAfterSeconds(key: string): number {
  const bucket = buckets.get(key);
  if (!bucket) return 0;
  return Math.max(0, Math.ceil((bucket.resetAt - Date.now()) / 1000));
}

export function rateLimitResponse(message?: string, retryAfterSeconds?: number) {
  const headers = new Headers({ 'content-type': 'application/json' });
  const seconds = retryAfterSeconds ?? 0;
  if (seconds > 0) headers.set('retry-after', String(seconds));
  return new Response(
    JSON.stringify({ error: message ?? 'Too many requests. Please slow down.' }),
    { status: 429, headers },
  );
}
