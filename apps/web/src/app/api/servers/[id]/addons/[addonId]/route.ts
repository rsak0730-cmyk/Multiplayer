import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { NODE_COMMANDS } from '@oghost/shared';

export const runtime = 'nodejs';

type Params = { params: { id: string; addonId: string } };

/**
 * POST   /api/servers/:id/addons/:addonId — install the uploaded add-on on the node
 * DELETE /api/servers/:id/addons/:addonId — remove record + storage object
 */
export async function POST(request: Request, { params }: Params) {
  if (!checkRateLimit(`addon-install:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline — cannot install add-ons.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data: addon } = await admin
    .from('server_addons')
    .select('*')
    .eq('id', params.addonId)
    .eq('server_id', ctx.server.id)
    .maybeSingle();
  if (!addon) {
    return NextResponse.json({ error: 'Add-on not found' }, { status: 404 });
  }

  const storagePath = `${ctx.userId}/${ctx.server.id}/${addon.id}-${addon.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const { data: signed, error: signError } = await admin.storage
    .from('oghost-addons')
    .createSignedUrl(storagePath, 60 * 15); // 15 minutes
  if (signError || !signed) {
    return NextResponse.json(
      {
        error: `File is not in storage yet (upload may not have finished): ${signError?.message ?? 'unknown'}`,
        code: 'UPLOAD_NOT_FOUND',
      },
      { status: 409 },
    );
  }

  await admin.from('server_addons').update({ status: 'installing' }).eq('id', addon.id);
  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.ADDON_INSTALL,
      payload: {
        addon_id: addon.id,
        file_name: addon.file_name,
        addon_type: addon.addon_type,
        download_url: signed.signedUrl,
        expected_size_bytes: addon.size_bytes,
      },
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
    action: 'addon.install_requested',
    targetType: 'addon',
    targetId: addon.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ queued: true, command_id: command.id });
}

export async function DELETE(request: Request, { params }: Params) {
  if (!checkRateLimit(`addon-delete:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const admin = createAdminClient();
  const { data: addon } = await admin
    .from('server_addons')
    .select('*')
    .eq('id', params.addonId)
    .eq('server_id', ctx.server.id)
    .maybeSingle();
  if (!addon) {
    return NextResponse.json({ error: 'Add-on not found' }, { status: 404 });
  }

  const storagePath = `${ctx.userId}/${ctx.server.id}/${addon.id}-${addon.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  await admin.storage.from('oghost-addons').remove([storagePath]);

  if (ctx.nodeOnline && addon.installed_path) {
    await admin.from('node_commands').insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: 'addon_remove',
      payload: { addon_id: addon.id, installed_path: addon.installed_path },
      status: 'pending',
    });
  }
  await admin.from('server_addons').delete().eq('id', addon.id);

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'addon.deleted',
    targetType: 'addon',
    targetId: addon.id,
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ ok: true });
}
