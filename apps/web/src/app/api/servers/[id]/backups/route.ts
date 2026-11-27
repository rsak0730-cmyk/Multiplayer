import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { NODE_COMMANDS } from '@oghost/shared';

export const runtime = 'nodejs';

/**
 * GET  /api/servers/:id/backups — list backups (owner only)
 * POST /api/servers/:id/backups — create a manual backup on the node
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const { data, error } = await supabase
    .from('server_backups')
    .select('*')
    .eq('server_id', ctx.server.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ backups: data ?? [] });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`backup:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline — cannot create a backup.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }

  let body: { name?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const name = (body.name ?? '').trim().slice(0, 64) ||
    `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const admin = createAdminClient();
  const { data: backup, error } = await admin
    .from('server_backups')
    .insert({
      server_id: ctx.server.id,
      owner_id: ctx.userId,
      name,
      file_name: `${name}.zip`,
      minecraft_version: ctx.server.installed_version ?? ctx.server.minecraft_version,
      status: 'pending',
      storage_provider: 'local',
    })
    .select('*')
    .single();
  if (error || !backup) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create backup record' }, { status: 500 });
  }

  const { data: command, error: cmdError } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.BACKUP_WORLD,
      payload: {
        backup_id: backup.id,
        name,
        safe_stop_if_running: ctx.server.status === 'running',
      },
      status: 'pending',
    })
    .select('*')
    .single();
  if (cmdError) {
    return NextResponse.json({ error: cmdError.message }, { status: 500 });
  }

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'backup.created',
    targetType: 'backup',
    targetId: backup.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ backup, command_id: command?.id }, { status: 201 });
}
