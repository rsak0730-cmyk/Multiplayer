import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { NODE_COMMANDS } from '@oghost/shared';

export const runtime = 'nodejs';

type Params = { params: { id: string; backupId: string } };

/**
 * POST   /api/servers/:id/backups/:backupId — { action: 'restore' }
 * DELETE /api/servers/:id/backups/:backupId — remove backup file + record
 */
export async function POST(request: Request, { params }: Params) {
  if (!checkRateLimit(`backup-restore:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  let body: { action?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (body.action !== 'restore') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }
  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }
  if (ctx.server.status === 'running') {
    return NextResponse.json(
      { error: 'Stop the server before restoring a backup. Restoring over a live world corrupts it.', code: 'SERVER_RUNNING' },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data: backup } = await admin
    .from('server_backups')
    .select('*')
    .eq('id', params.backupId)
    .eq('server_id', ctx.server.id)
    .maybeSingle();
  if (!backup) {
    return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
  }
  if (backup.status !== 'completed') {
    return NextResponse.json(
      { error: `Backup status is "${backup.status}" — only completed backups can be restored.` },
      { status: 409 },
    );
  }

  await admin.from('server_backups').update({ status: 'restoring' }).eq('id', backup.id);
  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.RESTORE_BACKUP,
      payload: { backup_id: backup.id, file_name: backup.file_name },
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'backup.restore_requested',
    targetType: 'backup',
    targetId: backup.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ queued: true, command_id: command.id });
}

export async function DELETE(request: Request, { params }: Params) {
  if (!checkRateLimit(`backup-delete:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const admin = createAdminClient();
  const { data: backup } = await admin
    .from('server_backups')
    .select('*')
    .eq('id', params.backupId)
    .eq('server_id', ctx.server.id)
    .maybeSingle();
  if (!backup) {
    return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
  }

  if (ctx.nodeOnline) {
    await admin.from('node_commands').insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: 'delete_backup',
      payload: { backup_id: backup.id, file_name: backup.file_name },
      status: 'pending',
    });
  }
  await admin.from('server_backups').delete().eq('id', backup.id);

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'backup.deleted',
    targetType: 'backup',
    targetId: backup.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ ok: true });
}
