import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex, generateNodeToken } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { isValidPairingCode } from '@oghost/shared';
import { auditLog, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';

/**
 * POST /api/agent/pairing/claim
 * The Windows agent exchanges a short-lived pairing code (shown in the
 * web UI) for a long-lived node token. Only the hash of the code is
 * stored in the database.
 *
 * Body: { code: "XXXXXX-XXXXXX", hostname, operating_system, agent_version }
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`pairing:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }

  let body: {
    code?: string;
    hostname?: string;
    operating_system?: string;
    agent_version?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const code = (body.code ?? '').trim().toUpperCase();
  if (!isValidPairingCode(code)) {
    return NextResponse.json({ error: 'Invalid pairing code format' }, { status: 400 });
  }

  const admin = createAdminClient();
  const codeHash = sha256Hex(code);

  const { data: pairing } = await admin
    .from('pairing_codes')
    .select('*')
    .eq('code_hash', codeHash)
    .is('claimed_at', null)
    .is('invalidated_at', null)
    .maybeSingle();

  if (!pairing) {
    return NextResponse.json({ error: 'Pairing code not found or already used' }, { status: 404 });
  }
  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'Pairing code expired' }, { status: 410 });
  }
  if ((pairing.attempts ?? 0) >= 5) {
    await admin
      .from('pairing_codes')
      .update({ invalidated_at: new Date().toISOString() })
      .eq('id', pairing.id);
    return NextResponse.json({ error: 'Too many attempts. Generate a new code.' }, { status: 429 });
  }

  // Issue the node token (plaintext returned ONCE).
  const token = generateNodeToken();
  const tokenHash = sha256Hex(token);
  const nodeName = body.hostname?.trim() || 'Windows Node';

  const { data: node, error: nodeError } = await admin
    .from('nodes')
    .insert({
      owner_id: pairing.owner_id,
      name: nodeName,
      hostname: body.hostname ?? null,
      operating_system: body.operating_system ?? 'Windows',
      agent_version: body.agent_version ?? null,
      agent_platform: 'windows',
      status: 'online',
      token_hash: tokenHash,
      token_created_at: new Date().toISOString(),
      pairing_code_id: pairing.id,
      last_seen_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (nodeError || !node) {
    return NextResponse.json(
      { error: nodeError?.message ?? 'Failed to register node' },
      { status: 500 },
    );
  }

  await admin
    .from('pairing_codes')
    .update({
      claimed_at: new Date().toISOString(),
      claimed_node_id: node.id,
    })
    .eq('id', pairing.id);

  await admin.from('node_tokens').insert({
    node_id: node.id,
    token_hash: tokenHash,
    label: 'agent',
  });

  await admin.from('node_events').insert({
    node_id: node.id,
    event_type: 'paired',
    message: `Node "${nodeName}" paired successfully`,
  });

  await auditLog({
    ownerId: pairing.owner_id,
    actorType: 'agent',
    action: 'node.paired',
    targetType: 'node',
    targetId: node.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({
    node_id: node.id,
    token,
    message: 'Store this token in the agent config now. It will not be shown again.',
  });
}
