import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { ENGINE_ID_VALUES, isValidServerName, isValidWorldName } from '@oghost/shared';
import { engineInstallCommand, resolveEngineForNode } from '@/lib/servers/engine-selection';
import { z } from 'zod';

export const runtime = 'nodejs';

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  node_id: z.string().uuid(),
  world_name: z.string().trim().min(1).max(64).default('world'),
  description: z.string().trim().max(255).default(''),
  max_players: z.number().int().min(1).max(100).default(10),
  // Optional so the port can follow the engine: Bedrock defaults to 19132/udp and
  // Java to 25565/tcp. Hardcoding 19132 here would hand a Java server the wrong
  // port and the wrong protocol.
  port: z.number().int().min(1024).max(65535).optional(),
  engine_id: z.enum(ENGINE_ID_VALUES).default('bds'),
  gamemode: z.enum(['survival', 'creative', 'adventure']).default('survival'),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']).default('easy'),
  enable_cheats: z.boolean().default(true),
  pvp: z.boolean().default(true),
  network_provider: z.enum(['direct', 'playit', 'manual', 'custom']).default('direct'),
  auto_update: z.boolean().default(false),
  auto_start_on_node_boot: z.boolean().default(false),
  minecraft_version: z.string().trim().max(32).optional(),
});

/**
 * GET  /api/servers — list caller's servers with node + config joined
 * POST /api/servers — create a server on one of the caller's own nodes
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data, error: queryError } = await supabase
    .from('servers')
    .select('*')
    .order('created_at', { ascending: false });
  if (queryError) {
    return NextResponse.json({ error: queryError.message }, { status: 500 });
  }

  const { data: nodes } = await supabase.from('nodes').select('*');
  const nodeById = new Map((nodes ?? []).map((n) => [n.id, n]));

  const now = Date.now();
  const servers = (data ?? []).map((s) => {
    const node = nodeById.get(s.node_id);
    const nodeOnline =
      node && !node.revoked_at && node.last_seen_at
        ? now - new Date(node.last_seen_at).getTime() < 90_000
        : false;
    return {
      ...s,
      node: node
        ? {
            id: node.id,
            name: node.name,
            computed_status: nodeOnline ? 'online' : 'offline',
            cpu_percent: node.cpu_percent,
            ram_available_mb: node.ram_available_mb,
            storage_available_mb: node.storage_available_mb,
          }
        : null,
    };
  });

  return NextResponse.json({ servers });
}

export async function POST(request: Request) {
  if (!checkRateLimit(`servers-create:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const { user, error } = await requireUser();
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;
  if (!isValidServerName(input.name)) {
    return NextResponse.json(
      { error: 'Server name may only contain letters, numbers, spaces, hyphens and underscores.' },
      { status: 400 },
    );
  }
  if (!isValidWorldName(input.world_name)) {
    return NextResponse.json({ error: 'Invalid world name.' }, { status: 400 });
  }

  // CRITICAL: verify the node belongs to this user. RLS protects reads, but
  // the write goes through the service role, so we re-check ownership here.
  const admin = createAdminClient();
  const { data: node } = await admin
    .from('nodes')
    .select('*')
    .eq('id', input.node_id)
    .eq('owner_id', user!.id)
    .is('revoked_at', null)
    .maybeSingle();
  if (!node) {
    return NextResponse.json(
      { error: 'You can only create servers on your own connected devices.' },
      { status: 403 },
    );
  }

  // Engine and platform compatibility are decided from the catalog, never from
  // what the client asserts about the device. game_type is derived here, so it
  // cannot contradict engine_id.
  const selection = resolveEngineForNode({ engineId: input.engine_id, node });
  if (!selection.ok) {
    return NextResponse.json(
      {
        error: selection.error,
        reason: selection.reason,
        detail: selection.detail,
        requires_verification: selection.requiresVerification,
      },
      { status: selection.status },
    );
  }

  // Refuse before creating any row. Queueing an install command no adapter can
  // fulfil would leave a server that can never start and an error the owner
  // cannot act on.
  const installCommand = engineInstallCommand(selection.engine.id);
  if (!installCommand) {
    return NextResponse.json(
      {
        error: `${selection.engine.displayName} has no install adapter in the agent yet, so a server cannot be created for it.`,
        reason: 'no_engine_adapter',
        detail: 'Only official Bedrock Dedicated Server can be installed today.',
      },
      { status: 400 },
    );
  }

  const port = input.port ?? selection.defaultPort;

  const { data: server, error: serverError } = await admin
    .from('servers')
    .insert({
      owner_id: user!.id,
      node_id: node.id,
      name: input.name,
      description: input.description,
      engine_id: selection.engine.id,
      game_type: selection.gameType,
      runtime_kind: selection.engine.runtime.kind,
      world_name: input.world_name,
      minecraft_version: input.minecraft_version ?? null,
      status: 'stopped',
      max_players: input.max_players,
      port,
      network_provider: input.network_provider,
      auto_update: input.auto_update,
      auto_start_on_node_boot: input.auto_start_on_node_boot,
    })
    .select('*')
    .single();
  if (serverError || !server) {
    return NextResponse.json(
      { error: serverError?.message ?? 'Failed to create server' },
      { status: 500 },
    );
  }

  // Create the matching BDS server.properties config row. This block is
  // BDS-specific (scripting, command blocks, the IPv6 companion port); other
  // engines are refused above until they have their own config writer.
  const { error: cfgError } = await admin.from('server_configs').insert({
    server_id: server.id,
    owner_id: user!.id,
    server_name: input.name,
    gamemode: input.gamemode,
    difficulty: input.difficulty,
    pvp: input.pvp,
    max_players: input.max_players,
    server_port: port,
    server_portv6: port + 1,
    level_name: input.world_name,
    // enable_cheats maps to BDS: scripting + command blocks + operator default
    enable_scripting: input.enable_cheats,
    enable_command_blocking: input.enable_cheats,
    default_player_permission_level: input.enable_cheats ? 'operator' : 'member',
  });
  if (cfgError) {
    return NextResponse.json(
      { error: `Server created but config failed: ${cfgError.message}`, server },
      { status: 500 },
    );
  }

  // Ask the node to install the engine for this server. If the node is offline the
  // command stays pending and runs when it reconnects.
  await admin.from('node_commands').insert({
    node_id: node.id,
    server_id: server.id,
    command_type: installCommand,
    payload: {
      world_name: input.world_name,
      minecraft_version: input.minecraft_version ?? null,
      channel: 'stable',
      auto_discover_version: true,
    },
    status: 'pending',
  });

  await admin.from('node_events').insert({
    node_id: node.id,
    event_type: 'server_created',
    message: `Server "${input.name}" created`,
  });

  await auditLog({
    ownerId: user!.id,
    actorType: 'user',
    action: 'server.created',
    targetType: 'server',
    targetId: server.id,
    details: { node_id: node.id, name: input.name, engine_id: selection.engine.id },
    ipAddress: clientIp(request),
  });

  // caveats are returned so the UI can show the engine's limitations at the moment
  // of creation rather than only on a details page (§25).
  return NextResponse.json(
    {
      server,
      engine: {
        id: selection.engine.id,
        display_name: selection.engine.displayName,
        edition: selection.gameType,
        official: selection.engine.official,
        caveats: selection.caveats,
      },
    },
    { status: 201 },
  );
}
