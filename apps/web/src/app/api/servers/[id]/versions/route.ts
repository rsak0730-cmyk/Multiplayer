import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { NODE_COMMANDS } from '@oghost/shared';
import { discoverLatestBdsVersion, compareVersions } from '@/lib/bds/version-discovery';
import { z } from 'zod';

export const runtime = 'nodejs';

const bodySchema = z.object({
  action: z.enum(['check', 'update', 'rollback']),
  channel: z.enum(['stable', 'preview']).default('stable'),
  version: z.string().trim().max(32).optional(),
});

/**
 * GET  /api/servers/:id/versions — version history + latest discovered version
 * POST /api/servers/:id/versions — { action: 'check'|'update'|'rollback' }
 *
 * No Minecraft version number is ever hard-coded here. "Latest" is always
 * discovered at runtime; if discovery fails we report unknown rather than
 * inventing a version.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const { data: history, error } = await supabase
    .from('server_versions')
    .select('*')
    .eq('server_id', ctx.server.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const latest = await discoverLatestBdsVersion('stable');
  const installed = ctx.server.installed_version;

  return NextResponse.json({
    installed_version: installed,
    latest,
    discovery_failed: latest === null,
    update_available:
      latest && installed ? compareVersions(latest.version, installed) > 0 : null,
    history: history ?? [],
  });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`versions:${clientIp(request) ?? 'unknown'}`)) {
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
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { action, channel, version } = parsed.data;

  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }

  const admin = createAdminClient();

  if (action === 'check') {
    const { data: command, error } = await admin
      .from('node_commands')
      .insert({
        node_id: ctx.node.id,
        server_id: ctx.server.id,
        command_type: NODE_COMMANDS.CHECK_VERSIONS,
        payload: { channel },
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ queued: true, command_id: command.id });
  }

  if (action === 'update') {
    if (ctx.server.status === 'running') {
      return NextResponse.json(
        { error: 'Stop the server before updating.', code: 'SERVER_RUNNING' },
        { status: 409 },
      );
    }
    const target = version ?? (await discoverLatestBdsVersion(channel))?.version ?? null;
    const { data: versionRow } = await admin
      .from('server_versions')
      .insert({
        server_id: ctx.server.id,
        owner_id: ctx.userId,
        version: target ?? 'unknown',
        channel,
        action: 'updated',
        status: 'pending',
      })
      .select('*')
      .single();

    const { data: command, error } = await admin
      .from('node_commands')
      .insert({
        node_id: ctx.node.id,
        server_id: ctx.server.id,
        command_type: NODE_COMMANDS.UPDATE_BDS,
        payload: {
          target_version: target,
          channel,
          auto_discover_version: target === null,
          backup_before_update: true,
          rollback_on_failure: true,
          version_row_id: versionRow?.id ?? null,
        },
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await admin.from('servers').update({ status: 'updating', last_error: null }).eq('id', ctx.server.id);
    await auditLog({
      ownerId: ctx.userId,
      actorType: 'user',
      action: 'server.update_requested',
      targetType: 'server',
      targetId: ctx.server.id,
      details: { target_version: target, channel },
      ipAddress: clientIp(request),
    });
    return NextResponse.json({
      queued: true,
      command_id: command.id,
      target_version: target,
      note: target
        ? undefined
        : 'Latest version could not be discovered from here — the node will discover and verify it locally before installing.',
    });
  }

  // rollback
  if (!version) {
    return NextResponse.json({ error: 'version is required for rollback' }, { status: 400 });
  }
  const { data: previous } = await admin
    .from('server_versions')
    .select('*')
    .eq('server_id', ctx.server.id)
    .eq('version', version)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!previous) {
    return NextResponse.json(
      { error: `No completed installation of version "${version}" was found on this server. Rollback is only possible to a version that was previously installed successfully.` },
      { status: 404 },
    );
  }

  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.ROLLBACK_BDS,
      payload: { target_version: version, install_path: previous.install_path },
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from('servers').update({ status: 'updating', last_error: null }).eq('id', ctx.server.id);
  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'server.rollback_requested',
    targetType: 'server',
    targetId: ctx.server.id,
    details: { target_version: version },
    ipAddress: clientIp(request),
  });
  return NextResponse.json({ queued: true, command_id: command.id });
}
