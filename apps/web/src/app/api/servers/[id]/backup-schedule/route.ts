import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { z } from 'zod';

export const runtime = 'nodejs';

const scheduleSchema = z.object({
  enabled: z.boolean(),
  interval_hours: z.number().int().min(1).max(168),
  keep_count: z.number().int().min(1).max(50),
  safe_stop_server: z.boolean(),
  upload_to_drive: z.boolean().optional(),
});

/**
 * GET /api/servers/:id/backup-schedule
 * PUT /api/servers/:id/backup-schedule
 *
 * The schedule itself is executed by the Windows agent (it keeps running even
 * when nobody has the website open). This route only stores the settings and
 * pushes them to the node.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const { data, error } = await supabase
    .from('backup_schedules')
    .select('*')
    .eq('server_id', ctx.server.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    schedule: data ?? {
      enabled: false,
      interval_hours: 24,
      keep_count: 7,
      safe_stop_server: false,
      upload_to_drive: false,
      last_run_at: null,
      next_run_at: null,
    },
  });
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`backup-schedule:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid schedule' }, { status: 400 });
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const nextRun = input.enabled
    ? new Date(Date.now() + input.interval_hours * 3_600_000).toISOString()
    : null;

  const { data: existing } = await admin
    .from('backup_schedules')
    .select('id')
    .eq('server_id', ctx.server.id)
    .maybeSingle();

  const row = {
    server_id: ctx.server.id,
    owner_id: ctx.userId,
    enabled: input.enabled,
    interval_hours: input.interval_hours,
    keep_count: input.keep_count,
    safe_stop_server: input.safe_stop_server,
    upload_to_drive: input.upload_to_drive ?? false,
    next_run_at: nextRun,
  };

  const { data: saved, error } = existing
    ? await admin.from('backup_schedules').update(row).eq('id', existing.id).select('*').single()
    : await admin.from('backup_schedules').insert(row).select('*').single();
  if (error || !saved) {
    return NextResponse.json({ error: error?.message ?? 'Failed to save schedule' }, { status: 500 });
  }

  // Push the schedule to the node so it can run it locally.
  if (ctx.nodeOnline) {
    await admin.from('node_commands').insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: 'schedule_backups',
      payload: {
        enabled: saved.enabled,
        interval_hours: saved.interval_hours,
        keep_count: saved.keep_count,
        safe_stop_server: saved.safe_stop_server,
        upload_to_drive: saved.upload_to_drive,
      },
      status: 'pending',
    });
  }

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'backup.schedule_updated',
    targetType: 'server',
    targetId: ctx.server.id,
    details: { enabled: saved.enabled, interval_hours: saved.interval_hours },
    ipAddress: clientIp(request),
  });

  return NextResponse.json({
    schedule: saved,
    node_offline: !ctx.nodeOnline,
    message: ctx.nodeOnline
      ? 'Schedule saved and sent to your device.'
      : 'Schedule saved. It will be applied automatically when your device reconnects.',
  });
}
