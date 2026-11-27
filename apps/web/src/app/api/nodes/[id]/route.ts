import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser, generateNodeToken, sha256Hex } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { z } from 'zod';

export const runtime = 'nodejs';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
});

type Params = { params: { id: string } };

/**
 * GET    /api/nodes/:id — node detail (must belong to caller)
 * PATCH  /api/nodes/:id — rename node
 * DELETE /api/nodes/:id — revoke credentials + disconnect node
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data: node, error: nodeError } = await supabase
    .from('nodes')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (nodeError || !node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const { data: servers } = await supabase
    .from('servers')
    .select('id, name, status')
    .eq('node_id', params.id);

  const { data: events } = await supabase
    .from('node_events')
    .select('*')
    .eq('node_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50);

  return NextResponse.json({ node, servers: servers ?? [], events: events ?? [] });
}

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data: node } = await supabase
    .from('nodes')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: updated, error: updateError } = await admin
    .from('nodes')
    .update({ name: parsed.data.name })
    .eq('id', params.id)
    .select('*')
    .single();
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  await auditLog({
    ownerId: user!.id,
    actorType: 'user',
    action: 'node.renamed',
    targetType: 'node',
    targetId: params.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ node: updated });
}

export async function DELETE(request: Request, { params }: Params) {
  if (!checkRateLimit(`node-delete:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data: node } = await supabase
    .from('nodes')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!node) {
    return NextResponse.json({ error: 'Node not found' }, { status: 404 });
  }

  const admin = createAdminClient();
  // Revoke all tokens and mark the node revoked. The agent's next heartbeat
  // will be rejected; the user can re-pair with a fresh code.
  await admin
    .from('node_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('node_id', params.id)
    .is('revoked_at', null);

  await admin
    .from('nodes')
    .update({
      revoked_at: new Date().toISOString(),
      status: 'revoked',
      token_hash: null,
    })
    .eq('id', params.id);

  await admin.from('node_events').insert({
    node_id: params.id,
    event_type: 'revoked',
    message: 'Node credentials revoked by owner',
  });

  await auditLog({
    ownerId: user!.id,
    actorType: 'user',
    action: 'node.revoked',
    targetType: 'node',
    targetId: params.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ ok: true });
}
