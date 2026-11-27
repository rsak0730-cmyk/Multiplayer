import { NextResponse } from 'next/server';
import { loadServerContext } from '@/lib/api/server-context';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { issueVoiceCode } from '@/lib/voice/issue-code';
import { issueCodeSchema, validationError } from '@/lib/voice/validation';

export const runtime = 'nodejs';

/**
 * POST /api/voice/:serverId/code — owner issues a pairing code from the dashboard
 *
 * Owner-authenticated through `loadServerContext`, which scopes by ownership via
 * RLS and returns 404 for another user's server. The add-on does not use this
 * route; it goes through /api/agent/voice/code so that no long-lived credential
 * is ever needed inside a behavior pack.
 */
export async function POST(request: Request, { params }: { params: { serverId: string } }) {
  if (!checkRateLimit(`voice-code:${params.serverId}`)) {
    return rateLimitResponse();
  }

  const loaded = await loadServerContext(params.serverId);
  if ('error' in loaded) return loaded.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = issueCodeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationError(parsed.error), { status: 400 });
  }

  const result = await issueVoiceCode({
    serverId: loaded.ctx.server.id,
    playerName: parsed.data.player_name,
    // An owner issuing from the panel is still 'dashboard', whatever the body
    // claimed: the field is set by the route, not by the caller.
    issuedVia: 'dashboard',
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    {
      // Shown once. The dashboard should present this with its countdown rather
      // than persisting it anywhere.
      code: result.code,
      player_name: result.playerName,
      expires_at: result.expiresAt,
      ttl_seconds: result.ttlSeconds,
    },
    { status: 201 },
  );
}
