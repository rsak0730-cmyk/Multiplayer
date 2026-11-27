import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { loadServerContext } from '@/lib/api/server-context';

export const runtime = 'nodejs';

/**
 * GET /api/servers/:id/backups/:backupId/download
 *
 * Backups live on the user's Windows device, not in our storage. We ask the
 * agent to upload the archive to the owner-scoped Supabase Storage bucket and
 * hand back a 15-minute signed URL. That keeps large files out of serverless
 * functions and out of other accounts' reach.
 */
export async function GET(request: Request, { params }: { params: { id: string; backupId: string } }) {
  if (!checkRateLimit(`backup-download:${request.headers.get('x-forwarded-for') ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline — the backup file is on that device.`, code: 'NODE_OFFLINE' },
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
      { error: `Backup status is "${backup.status}" — only completed backups can be downloaded.` },
      { status: 409 },
    );
  }

  const storagePath = `${ctx.userId}/${ctx.server.id}/backups/${backup.id}-${backup.file_name}`;

  // If the agent already uploaded it, just sign a URL for the existing object.
  const { data: existing } = await admin.storage
    .from('oghost-backups')
    .createSignedUrl(storagePath, 60 * 15);
  if (existing?.signedUrl) {
    return NextResponse.json({ download_url: existing.signedUrl, cached: true });
  }

  // Otherwise ask the node to upload it, then poll is done client-side.
  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: 'upload_backup',
      payload: { backup_id: backup.id, file_name: backup.file_name, storage_path: storagePath },
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !command) {
    return NextResponse.json({ error: error?.message ?? 'Failed to queue upload' }, { status: 500 });
  }

  return NextResponse.json({
    queued: true,
    command_id: command.id,
    message:
      'The device is uploading this backup to your private storage now. Poll this endpoint again in a few seconds for the download link.',
  });
}
