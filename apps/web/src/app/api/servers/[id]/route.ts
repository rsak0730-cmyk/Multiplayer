import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';

/**
 * GET    /api/servers/:id — server detail (+ node, config, endpoint, backups, versions)
 * DELETE /api/servers/:id — delete the server record and tell the node to remove it
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data: server, error: serverError } = await supabase
    .from('servers')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (serverError || !server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const [{ data: node }, { data: config }, { data: endpoints }, { data: backups }, { data: versions }, { data: addons }, { data: players }] =
    await Promise.all([
      supabase.from('nodes').select('*').eq('id', server.node_id).maybeSingle(),
      supabase.from('server_configs').select('*').eq('server_id', server.id).maybeSingle(),
      supabase
        .from('network_endpoints')
        .select('*')
        .eq('server_id', server.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('server_backups')
        .select('*')
        .eq('server_id', server.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('server_versions')
        .select('*')
        .eq('server_id', server.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('server_addons')
        .select('*')
        .eq('server_id', server.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('server_players')
        .select('*')
        .eq('server_id', server.id)
        .order('last_seen_at', { ascending: false })
        .limit(50),
    ]);

  const now = Date.now();
  const nodeOnline =
    node && !node.revoked_at && node.last_seen_at
      ? now - new Date(node.last_seen_at).getTime() < 90_000
      : false;

  return NextResponse.json({
    server,
    node: node ? { ...node, computed_status: nodeOnline ? 'online' : 'offline' } : null,
    config,
    endpoints: endpoints ?? [],
    backups: backups ?? [],
    versions: versions ?? [],
    addons: addons ?? [],
    players: players ?? [],
  });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`server-delete:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data: server } = await supabase
    .from('servers')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const admin = createAdminClient();
  // Tell the node to stop + remove the directory before the row cascades away.
  await admin.from('node_commands').insert({
    node_id: server.node_id,
    server_id: server.id,
    command_type: 'delete_server',
    payload: { remove_files: true },
    status: 'pending',
  });
  await admin.from('servers').delete().eq('id', server.id);

  await auditLog({
    ownerId: user!.id,
    actorType: 'user',
    action: 'server.deleted',
    targetType: 'server',
    targetId: server.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ ok: true });
}
