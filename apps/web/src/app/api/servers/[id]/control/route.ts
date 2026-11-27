import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext, nodeOfflineResponse } from '@/lib/api/server-context';
import { NODE_COMMANDS, isAllowedBdsCommand } from '@oghost/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const controlSchema = z.object({
  action: z.enum([
    'start',
    'stop',
    'restart',
    'force_stop',
    'install',
    'update',
    'rollback',
    'backup',
    'restore',
    'console_command',
    'apply_config',
    'networking_start',
    'networking_stop',
    'check_versions',
  ]),
  command: z.string().trim().max(500).optional(),
  backup_id: z.string().uuid().optional(),
  version: z.string().trim().max(32).optional(),
  force: z.boolean().optional(),
});

/**
 * POST /api/servers/:id/control
 * Single entry point for all lifecycle operations. Every action:
 *   1. verifies ownership (RLS read on servers + nodes)
 *   2. verifies the node is actually online (no fake success)
 *   3. checks resources where relevant
 *   4. enqueues an allowlisted command for the agent
 *   5. records an audit log entry
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`control:${clientIp(request) ?? 'unknown'}`)) {
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
  const parsed = controlSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid action', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { action } = parsed.data;

  const admin = createAdminClient();

  // Offline nodes cannot execute anything — refuse rather than pretend.
  if (!ctx.nodeOnline) {
    return nodeOfflineResponse(ctx.node.name);
  }

  const enqueue = async (
    commandType: string,
    payload: Record<string, unknown>,
    statusUpdate?: Record<string, unknown>,
  ) => {
    const { data: command, error } = await admin
      .from('node_commands')
      .insert({
        node_id: ctx.node.id,
        server_id: ctx.server.id,
        command_type: commandType,
        payload,
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    if (statusUpdate) {
      await admin.from('servers').update(statusUpdate).eq('id', ctx.server.id);
    }
    await auditLog({
      ownerId: ctx.userId,
      actorType: 'user',
      action: `server.${action}`,
      targetType: 'server',
      targetId: ctx.server.id,
      details: { command_id: command.id },
      ipAddress: clientIp(request),
    });
    return command;
  };

  switch (action) {
    case 'start': {
      // Resource pre-flight on the owner's own node.
      const availableRam = ctx.node.ram_available_mb ?? 0;
      if (availableRam > 0 && availableRam < 1024) {
        return NextResponse.json(
          {
            error: `Not enough free RAM on "${ctx.node.name}" (${availableRam} MB available). Bedrock Dedicated Server needs roughly 1 GB. Close other programs and retry.`,
            code: 'INSUFFICIENT_RAM',
          },
          { status: 409 },
        );
      }
      const availableDisk = ctx.node.storage_available_mb ?? 0;
      if (availableDisk > 0 && availableDisk < 2048) {
        return NextResponse.json(
          {
            error: `Not enough free storage on "${ctx.node.name}" (${availableDisk} MB available). At least 2 GB is required.`,
            code: 'INSUFFICIENT_STORAGE',
          },
          { status: 409 },
        );
      }
      if (!ctx.server.installed_version) {
        // BDS not installed yet — install first, then start.
        const install = await enqueue(
          NODE_COMMANDS.INSTALL_BDS,
          {
            world_name: ctx.server.world_name,
            auto_discover_version: true,
            then_start: true,
          },
          { status: 'installing', last_error: null },
        );
        return NextResponse.json({
          queued: true,
          command_id: install.id,
          message:
            'BDS is not installed on this node yet. An install command was queued; the server will start automatically once installation succeeds.',
        });
      }
      const command = await enqueue(
        NODE_COMMANDS.START_SERVER,
        {
          world_name: ctx.server.world_name,
          port: ctx.server.port,
          max_players: ctx.server.max_players,
          network_provider: ctx.server.network_provider,
          establish_networking: true,
        },
        { status: 'starting', last_error: null },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'stop': {
      const command = await enqueue(
        NODE_COMMANDS.STOP_SERVER,
        { graceful: true, timeout_seconds: 30 },
        { status: 'stopping' },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'restart': {
      const command = await enqueue(
        NODE_COMMANDS.RESTART_SERVER,
        { graceful: true, timeout_seconds: 30 },
        { status: 'stopping' },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'force_stop': {
      if (!parsed.data.force) {
        return NextResponse.json(
          { error: 'Force stop requires explicit confirmation (force: true).' },
          { status: 400 },
        );
      }
      const command = await enqueue(
        NODE_COMMANDS.FORCE_STOP,
        {},
        { status: 'stopping' },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'install': {
      const command = await enqueue(
        NODE_COMMANDS.INSTALL_BDS,
        {
          world_name: ctx.server.world_name,
          minecraft_version: parsed.data.version ?? null,
          auto_discover_version: !parsed.data.version,
        },
        { status: 'installing', last_error: null },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'update': {
      if (ctx.server.status === 'running') {
        return NextResponse.json(
          {
            error: 'Stop the server before updating. Updates never silently replace a running server.',
            code: 'SERVER_RUNNING',
          },
          { status: 409 },
        );
      }
      const command = await enqueue(
        NODE_COMMANDS.UPDATE_BDS,
        {
          target_version: parsed.data.version ?? null,
          auto_discover_version: !parsed.data.version,
          backup_before_update: true,
          restart_after_update: false,
          rollback_on_failure: true,
        },
        { status: 'updating', last_error: null },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'rollback': {
      if (!parsed.data.version) {
        return NextResponse.json({ error: 'version is required for rollback' }, { status: 400 });
      }
      const command = await enqueue(
        NODE_COMMANDS.ROLLBACK_BDS,
        { target_version: parsed.data.version },
        { status: 'updating', last_error: null },
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'backup': {
      const command = await enqueue(
        NODE_COMMANDS.BACKUP_WORLD,
        { safe_stop_if_running: ctx.server.status === 'running' },
        {},
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'restore': {
      if (!parsed.data.backup_id) {
        return NextResponse.json({ error: 'backup_id is required' }, { status: 400 });
      }
      // Verify the backup belongs to this server (and therefore this owner).
      const { data: backup } = await admin
        .from('server_backups')
        .select('*')
        .eq('id', parsed.data.backup_id)
        .eq('server_id', ctx.server.id)
        .maybeSingle();
      if (!backup) {
        return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
      }
      if (ctx.server.status === 'running') {
        return NextResponse.json(
          { error: 'Stop the server before restoring a backup.', code: 'SERVER_RUNNING' },
          { status: 409 },
        );
      }
      const command = await enqueue(
        NODE_COMMANDS.RESTORE_BACKUP,
        { backup_id: backup.id, file_name: backup.file_name },
        {},
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'console_command': {
      const raw = (parsed.data.command ?? '').trim();
      if (!raw) {
        return NextResponse.json({ error: 'command is required' }, { status: 400 });
      }
      // Allowlist enforcement happens here AND in the agent (defence in depth).
      // Never a shell — BDS stdin only, no & | ; ` $ > < and no newlines.
      if (!isAllowedBdsCommand(raw)) {
        return NextResponse.json(
          {
            error:
              'That command is not on the Bedrock allowlist. Only official BDS console commands are permitted; remote shell access is never available.',
            code: 'COMMAND_NOT_ALLOWED',
          },
          { status: 403 },
        );
      }
      if (ctx.server.status !== 'running') {
        return NextResponse.json(
          { error: 'The server must be running to accept console commands.', code: 'SERVER_NOT_RUNNING' },
          { status: 409 },
        );
      }
      const command = await enqueue(NODE_COMMANDS.CONSOLE_COMMAND, { command: raw }, {});
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'apply_config': {
      const command = await enqueue(NODE_COMMANDS.APPLY_CONFIG, {}, {});
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'networking_start': {
      const command = await enqueue(
        NODE_COMMANDS.NETWORKING_START,
        { provider: ctx.server.network_provider, port: ctx.server.port },
        {},
      );
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'networking_stop': {
      const command = await enqueue(NODE_COMMANDS.NETWORKING_STOP, {}, {});
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    case 'check_versions': {
      const command = await enqueue(NODE_COMMANDS.CHECK_VERSIONS, {}, {});
      return NextResponse.json({ queued: true, command_id: command.id });
    }

    default:
      return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }
}
