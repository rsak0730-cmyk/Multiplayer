import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser, generateNodeToken, sha256Hex } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';

/**
 * POST /api/nodes/:id/rotate-token
 * Issue a fresh node token and revoke the old one. The plaintext token is
 * returned once so the user can paste it into the agent config.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`rotate-token:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data: node } = await supabase
    .from('nodes')
    .select('id, revoked_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }
  if (node.revoked_at) {
    return NextResponse.json(
      { error: 'Node is revoked. Re-pair it with a new pairing code.' },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  await admin
    .from('node_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('node_id', params.id)
    .is('revoked_at', null);

  const token = generateNodeToken();
  const tokenHash = sha256Hex(token);
  await admin
    .from('nodes')
    .update({ token_hash: tokenHash, token_created_at: new Date().toISOString() })
    .eq('id', params.id);

  await admin.from('node_tokens').insert({
    node_id: params.id,
    token_hash: tokenHash,
    label: 'agent (rotated)',
  });

  await admin.from('node_events').insert({
    node_id: params.id,
    event_type: 'token_rotated',
    message: 'Node token rotated by owner',
  });

  await auditLog({
    ownerId: user!.id,
    actorType: 'user',
    action: 'node.token_rotated',
    targetType: 'node',
    targetId: params.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({
    token,
    message: 'Replace the token in your agent config file now. The old token no longer works.',
  });
}
