import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { isPlausiblePublicAddress } from '@/lib/networking/verify';
import { NODE_COMMANDS } from '@oghost/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const bodySchema = z.object({
  action: z.enum(['set_provider', 'start', 'stop', 'set_manual', 'save_node_settings']),
  provider: z.enum(['direct', 'playit', 'manual', 'custom']).optional(),
  address: z.string().trim().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  playit_secret: z.string().trim().max(512).optional(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * GET  /api/servers/:id/networking — endpoints + provider settings + honest status
 * POST /api/servers/:id/networking — configure / start / stop the tunnel
 *
 * HONESTY CONTRACT
 * ----------------
 * A server is only reported as reachable when a real check succeeded:
 *   status "verified"  -> an actual RakNet unconnected-ping/pong round trip
 *                         succeeded against the public address (performed by
 *                         the agent on the node, result reported back).
 *   status "active"    -> the provider reports a tunnel is up and gave us an
 *                         address, but no Bedrock protocol round trip has
 *                         succeeded yet. The UI labels this UNVERIFIED.
 *   status "unknown"   -> nothing established. No address is shown at all.
 * We never invent an IP address or a port.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const [{ data: endpoints }, { data: settings }, { data: providers }] = await Promise.all([
    supabase
      .from('network_endpoints')
      .select('*')
      .eq('server_id', ctx.server.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('node_network_settings')
      .select('id, playit_agent_installed, playit_tunnel_id, custom_provider_name, notes, updated_at')
      .eq('node_id', ctx.node.id)
      .maybeSingle(),
    supabase.from('network_providers').select('*'),
  ]);

  const active = (endpoints ?? []).find(
    (e) => e.status === 'verified' || e.status === 'active',
  );

  return NextResponse.json({
    server_provider: ctx.server.network_provider,
    endpoints: endpoints ?? [],
    active_endpoint: active ?? null,
    // Deliberately explicit so the UI cannot show a fake "online" state.
    reachable_and_verified: Boolean(active && active.verified),
    address_known: Boolean(active?.address),
    node_settings: settings ?? null,
    providers: providers ?? [],
    node_online: ctx.nodeOnline,
  });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`networking:${clientIp(request) ?? 'unknown'}`)) {
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
  const input = parsed.data;
  const admin = createAdminClient();

  if (input.action === 'save_node_settings') {
    const existing = await admin
      .from('node_network_settings')
      .select('*')
      .eq('node_id', ctx.node.id)
      .maybeSingle();
    const payload = {
      node_id: ctx.node.id,
      owner_id: ctx.userId,
      playit_secret: input.playit_secret ?? existing.data?.playit_secret ?? null,
      notes: input.notes ?? existing.data?.notes ?? null,
    };
    const { error } = existing.data
      ? await admin.from('node_network_settings').update(payload).eq('id', existing.data.id)
      : await admin.from('node_network_settings').insert(payload);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await auditLog({
      ownerId: ctx.userId,
      actorType: 'user',
      action: 'networking.node_settings_saved',
      targetType: 'node',
      targetId: ctx.node.id,
      ipAddress: clientIp(request),
    });
    return NextResponse.json({
      ok: true,
      message:
        'Tunnel settings saved. The secret is stored on the node record and is only ever sent to your own agent.',
    });
  }

  if (input.action === 'set_provider') {
    if (!input.provider) {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 });
    }
    await admin.from('servers').update({ network_provider: input.provider }).eq('id', ctx.server.id);
    // Changing provider invalidates any previously claimed endpoint.
    await admin
      .from('network_endpoints')
      .update({ status: 'stopped', verified: false })
      .eq('server_id', ctx.server.id)
      .in('status', ['active', 'verified', 'pending']);
    await admin
      .from('servers')
      .update({ public_address: null, public_port: null, networking_verified: false })
      .eq('id', ctx.server.id);

    await auditLog({
      ownerId: ctx.userId,
      actorType: 'user',
      action: 'networking.provider_changed',
      targetType: 'server',
      targetId: ctx.server.id,
      details: { provider: input.provider },
      ipAddress: clientIp(request),
    });
    return NextResponse.json({
      ok: true,
      provider: input.provider,
      message:
        input.provider === 'direct'
          ? 'Direct mode: your node must have a public IPv4 address or port forwarding. On Airtel/Jio/Vi mobile broadband this usually fails because of CGNAT — use Playit or Manual instead.'
          : 'Provider updated. Start networking to establish the tunnel.',
    });
  }

  if (input.action === 'set_manual') {
    const address = (input.address ?? '').trim();
    const port = input.port ?? ctx.server.port;
    if (!address) {
      return NextResponse.json({ error: 'address is required' }, { status: 400 });
    }
    if (!isPlausiblePublicAddress(address)) {
      return NextResponse.json(
        {
          error:
            'That does not look like a public address (localhost/private ranges are rejected). Enter the real public host or IP your friends will use in Minecraft.',
          code: 'IMPLAUSIBLE_ADDRESS',
        },
        { status: 400 },
      );
    }
    const { data: endpoint, error } = await admin
      .from('network_endpoints')
      .insert({
        server_id: ctx.server.id,
        owner_id: ctx.userId,
        provider: 'manual',
        address,
        port,
        status: 'pending',
        verified: false,
        notes: input.notes ?? 'Entered manually — awaiting verification.',
      })
      .select('*')
      .single();
    if (error || !endpoint) {
      return NextResponse.json({ error: error?.message ?? 'Failed to save endpoint' }, { status: 500 });
    }
    await admin
      .from('servers')
      .update({
        network_provider: 'manual',
        public_address: address,
        public_port: port,
        networking_verified: false,
        networking_verified_at: null,
      })
      .eq('id', ctx.server.id);

    return NextResponse.json({
      endpoint,
      verified: false,
      message:
        'Saved as UNVERIFIED. The agent will attempt a real RakNet ping against this address; it is only marked verified after a genuine Bedrock protocol response. Until then, do not share it as working.',
    });
  }

  // start / stop
  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline — networking cannot be established.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }

  if (input.action === 'stop') {
    const { data: command, error } = await admin
      .from('node_commands')
      .insert({
        node_id: ctx.node.id,
        server_id: ctx.server.id,
        command_type: NODE_COMMANDS.NETWORKING_STOP,
        payload: {},
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await admin
      .from('network_endpoints')
      .update({ status: 'stopped', verified: false })
      .eq('server_id', ctx.server.id)
      .in('status', ['active', 'verified', 'pending']);
    await admin
      .from('servers')
      .update({ networking_verified: false, networking_verified_at: null })
      .eq('id', ctx.server.id);
    return NextResponse.json({ queued: true, command_id: command.id });
  }

  // start
  if (ctx.server.status !== 'running') {
    return NextResponse.json(
      {
        error:
          'Start the Minecraft server first. The tunnel is established against a live BDS process so the connectivity check is real.',
        code: 'SERVER_NOT_RUNNING',
      },
      { status: 409 },
    );
  }

  const provider = ctx.server.network_provider;
  if (provider === 'playit') {
    const { data: settings } = await admin
      .from('node_network_settings')
      .select('playit_secret')
      .eq('node_id', ctx.node.id)
      .maybeSingle();
    if (!settings?.playit_secret) {
      return NextResponse.json(
        {
          error:
            'Playit is selected but no Playit secret is configured for this node. Create a free UDP tunnel at playit.gg, copy the secret, and save it here first. See docs/NETWORKING.md.',
          code: 'PLAYIT_SECRET_MISSING',
        },
        { status: 412 },
      );
    }
  }

  const { data: endpoint } = await admin
    .from('network_endpoints')
    .insert({
      server_id: ctx.server.id,
      owner_id: ctx.userId,
      provider,
      status: 'pending',
      verified: false,
      notes: 'Tunnel start requested — awaiting agent report.',
    })
    .select('*')
    .single();

  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.NETWORKING_START,
      payload: {
        provider,
        local_port: ctx.server.port,
        endpoint_id: endpoint?.id ?? null,
        // The agent must run a real RakNet unconnected ping and only then
        // report verified=true. See docs/NETWORKING.md §Verification.
        verify_with_raknet_ping: true,
      },
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'networking.start_requested',
    targetType: 'server',
    targetId: ctx.server.id,
    details: { provider },
    ipAddress: clientIp(request),
  });

  return NextResponse.json({
    queued: true,
    command_id: command.id,
    endpoint_id: endpoint?.id ?? null,
    message: `Networking start queued for provider "${provider}". The address shown on this page only becomes "verified" after a real Bedrock protocol round trip succeeds.`,
  });
}
