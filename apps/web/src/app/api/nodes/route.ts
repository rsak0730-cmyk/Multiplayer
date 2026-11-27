import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser, sha256Hex, generatePairingCode } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { PAIRING_CODE_TTL_MINUTES } from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * GET /api/nodes — list the caller's own nodes.
 * POST /api/nodes/pairing — generate a short-lived pairing code.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data, error: queryError } = await supabase
    .from('nodes')
    .select('*')
    .order('created_at', { ascending: false });
  if (queryError) {
    return NextResponse.json({ error: queryError.message }, { status: 500 });
  }
  // Compute online status from last_seen_at (90s window).
  const now = Date.now();
  const nodes = (data ?? []).map((n) => ({
    ...n,
    computed_status:
      n.revoked_at
        ? 'revoked'
        : n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000
          ? 'online'
          : 'offline',
  }));
  return NextResponse.json({ nodes });
}

/**
 * POST /api/nodes — create a pairing code for the authenticated user.
 * Only the hash is stored; the plaintext code is returned once.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`nodes-create:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const { user, error } = await requireUser();
  if (error) return error;

  const code = generatePairingCode();
  const codeHash = sha256Hex(code);
  const admin = createAdminClient();

  const { data, error: insertError } = await admin
    .from('pairing_codes')
    .insert({
      owner_id: user!.id,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60_000).toISOString(),
    })
    .select('*')
    .single();
  if (insertError || !data) {
    return NextResponse.json(
      { error: insertError?.message ?? 'Failed to create pairing code' },
      { status: 500 },
    );
  }

  await auditLog({
    ownerId: user!.id,
    actorType: 'user',
    action: 'pairing_code.created',
    targetType: 'pairing_code',
    targetId: data.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({
    pairing_code_id: data.id,
    code,
    expires_at: data.expires_at,
    message: `Enter this code in the OG HOST Windows Agent within ${PAIRING_CODE_TTL_MINUTES} minutes.`,
  });
}
