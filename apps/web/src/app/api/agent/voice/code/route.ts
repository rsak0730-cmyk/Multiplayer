import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { issueVoiceCode } from '@/lib/voice/issue-code';
import { agentIssueCodeSchema, validationError } from '@/lib/voice/validation';

export const runtime = 'nodejs';

/**
 * POST /api/agent/voice/code — the Bedrock add-on asks for a pairing code
 *
 * Authenticated by node token, like every other /api/agent route. The add-on
 * itself never holds that token: it runs inside BDS and reaches the agent on the
 * same machine, which forwards the request here. That keeps a long-lived
 * credential out of the behavior pack and out of Minecraft chat.
 *
 * The player name is trusted because it arrives through this authenticated
 * channel from inside the server process — not because the player supplied it.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`agent-voice-code:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }

  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = agentIssueCodeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationError(parsed.error), { status: 400 });
  }

  const admin = createAdminClient();
  // Scoped to this node: an agent may only act for servers it actually hosts.
  // Without the node_id predicate a stolen token could issue codes for any server.
  const { data: server } = await admin
    .from('servers')
    .select('id')
    .eq('id', parsed.data.server_id)
    .eq('node_id', node!.id)
    .maybeSingle();

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const result = await issueVoiceCode({
    serverId: (server as { id: string }).id,
    playerName: parsed.data.player_name,
    issuedVia: parsed.data.issued_via === 'in_game' ? 'in_game' : 'agent',
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    {
      // Returned to the agent, which passes it to the add-on for display on a
      // server-ui screen. It is single-use and expires in two minutes, so it is
      // not the "long-lived credential in chat" that §12 forbids.
      code: result.code,
      player_name: result.playerName,
      expires_at: result.expiresAt,
      ttl_seconds: result.ttlSeconds,
    },
    { status: 201 },
  );
}
