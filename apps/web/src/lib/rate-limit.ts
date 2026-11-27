/**
 * Simple in-memory rate limiter (per serverless instance).
 * For production multi-instance deployments, swap for Upstash Redis —
 * the interface stays the same. See docs/SECURITY.md.
 */

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60) * 1000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);

const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

export function rateLimitResponse() {
  return Response.json(
    { error: 'Too many requests. Please slow down.' },
    { status: 429 },
  );
}
