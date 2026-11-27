import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import type { HeartbeatPayload } from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * POST /api/agent/heartbeat
 * Agent reports hardware stats + per-server status. Outbound-only,
 * works behind NAT/CGNAT. Authenticated via node token.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`heartbeat:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }
  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  let body: HeartbeatPayload;
  try {
    body = (await request.json()) as HeartbeatPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { error: updateError } = await admin
    .from('nodes')
    .update({
      hostname: body.hostname ?? node.hostname,
      operating_system: body.operating_system ?? node.operating_system,
      agent_version: body.agent_version ?? node.agent_version,
      agent_platform: body.agent_platform ?? 'windows',
      status: 'online',
      cpu_percent: body.cpu_percent ?? null,
      ram_total_mb: body.ram_total_mb ?? null,
      ram_available_mb: body.ram_available_mb ?? null,
      storage_total_mb: body.storage_total_mb ?? null,
      storage_available_mb: body.storage_available_mb ?? null,
      disk_used_mb: body.disk_used_mb ?? null,
      uptime_seconds: body.uptime_seconds ?? null,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', node.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Update per-server status reported by the agent.
  if (Array.isArray(body.servers) && body.servers.length > 0) {
    for (const s of body.servers) {
      await admin
        .from('servers')
        .update({
          status: s.status,
          installed_version: s.installed_version ?? undefined,
          online_players: s.online_players ?? 0,
          public_address: s.public_address ?? undefined,
          public_port: s.public_port ?? undefined,
          networking_verified: s.networking_verified ?? undefined,
          last_error: s.last_error ?? null,
        })
        .eq('id', s.server_id)
        .eq('node_id', node.id);
    }
  }

  await admin
    .from('node_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('node_id', node.id)
    .is('revoked_at', null);

  return NextResponse.json({ ok: true, server_time: new Date().toISOString() });
}
