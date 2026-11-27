import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { renderServerProperties } from '@/lib/bds/server-properties';
import { NODE_COMMANDS } from '@oghost/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const configSchema = z.object({
  server_name: z.string().trim().min(1).max(64).optional(),
  gamemode: z.enum(['survival', 'creative', 'adventure']).optional(),
  force_gamemode: z.boolean().optional(),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']).optional(),
  spawn_monsters: z.boolean().optional(),
  spawn_animals: z.boolean().optional(),
  spawn_npcs: z.boolean().optional(),
  pvp: z.boolean().optional(),
  command_block_output: z.boolean().optional(),
  force_command_block_output: z.boolean().optional(),
  function_command_limit: z.number().int().min(0).max(10000).optional(),
  max_players: z.number().int().min(1).max(100).optional(),
  online_mode: z.boolean().optional(),
  allow_list: z.boolean().optional(),
  server_port: z.number().int().min(1024).max(65535).optional(),
  server_portv6: z.number().int().min(1024).max(65535).optional(),
  enable_lan_transfer: z.boolean().optional(),
  enable_command_blocking: z.boolean().optional(),
  compression_threshold: z.number().int().min(0).max(65535).optional(),
  compression_algorithm: z.enum(['deflate', 'none']).optional(),
  tick_command_redstone_conduction: z.number().int().min(1).max(20).optional(),
  enable_scripting: z.boolean().optional(),
  enable_external_server_requests: z.boolean().optional(),
  level_name: z.string().trim().min(1).max(64).optional(),
  level_seed: z.string().trim().max(64).optional(),
  default_player_permission_level: z.enum(['visitor', 'member', 'operator']).optional(),
  texture_pack_required: z.boolean().optional(),
  synced_skins_required: z.boolean().optional(),
});

/**
 * GET /api/servers/:id/config      — read the server config
 * PUT /api/servers/:id/config      — update config and queue a write to the node
 * GET /api/servers/:id/config?raw=1 — the exact server.properties text
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const { data: config, error } = await supabase
    .from('server_configs')
    .select('*')
    .eq('server_id', ctx.server.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!config) {
    return NextResponse.json({ error: 'Config not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get('raw') === '1') {
    return new NextResponse(renderServerProperties(config as never), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return NextResponse.json({ config });
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`config:${clientIp(request) ?? 'unknown'}`)) {
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
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid configuration', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const changes = parsed.data;

  // Refuse to change a running server's properties file behind its back.
  if (ctx.server.status === 'running' && (changes.server_port || changes.level_name)) {
    return NextResponse.json(
      { error: 'Stop the server before changing its port or world name.' },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data: updated, error: updateError } = await admin
    .from('server_configs')
    .update(changes)
    .eq('server_id', ctx.server.id)
    .select('*')
    .single();
  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message ?? 'Failed to update config' },
      { status: 500 },
    );
  }

  // Keep servers.max_players in sync (it is the UI-facing copy).
  if (changes.max_players !== undefined) {
    await admin.from('servers').update({ max_players: changes.max_players }).eq('id', ctx.server.id);
  }

  // Queue the properties write. If the node is offline the command waits.
  const { data: command } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.APPLY_CONFIG,
      payload: { properties: renderServerProperties(updated as never) },
      status: 'pending',
    })
    .select('*')
    .single();

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'server.config_updated',
    targetType: 'server',
    targetId: ctx.server.id,
    details: { fields: Object.keys(changes) },
    ipAddress: clientIp(request),
  });

  return NextResponse.json({
    config: updated,
    queued: Boolean(command),
    node_offline: !ctx.nodeOnline,
    message: ctx.nodeOnline
      ? 'Configuration saved. The node will apply it on the next poll.'
      : 'Configuration saved. It will be applied automatically when the node comes back online.',
  });
}
