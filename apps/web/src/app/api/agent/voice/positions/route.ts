import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { logVoiceEvent } from '@/lib/api/voice-context';
import { positionsSchema, validationError } from '@/lib/voice/validation';
import { z } from 'zod';

export const runtime = 'nodejs';

/** Agent variant: the server id travels in the body, as with every agent route. */
const agentPositionsSchema = positionsSchema.extend({ server_id: z.string().uuid() });

/**
 * POST /api/agent/voice/positions — authoritative coordinates from the add-on
 *
 * This is the write path for proximity voice, and the only one. Coordinates are
 * accepted exclusively from a node-token-authenticated caller, which is what
 * makes them authoritative: a companion app cannot submit its own position, so a
 * modified client cannot claim to be standing next to a player it is far from.
 * That is the "unauthorized position updates" attack §12 requires preventing.
 *
 * §17 asks that this stay off the game loop. The route does two set-based
 * queries (one upsert, one delete) rather than one per player, and stores one row
 * per player instead of appending history, so a full 10-player report is a
 * constant amount of work regardless of player count.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`agent-voice-positions:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }

  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = agentPositionsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationError(parsed.error), { status: 400 });
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const { data: server } = await admin
    .from('servers')
    .select('id')
    .eq('id', input.server_id)
    .eq('node_id', node!.id)
    .maybeSingle();
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const { data: config } = await admin
    .from('voice_server_configs')
    .select('enabled, mode')
    .eq('server_id', input.server_id)
    .maybeSingle();

  // Report compatibility honestly rather than pretending the add-on is running.
  const configRow = config as { enabled: boolean; mode: string } | null;
  if (!configRow || !configRow.enabled || configRow.mode === 'disabled') {
    // 200 with ok:false, not an error status: the add-on polls, and a 4xx would
    // read as a failure and invite retries for a state that is intentional.
    return NextResponse.json({
      ok: false,
      reason: configRow ? 'voice_disabled' : 'voice_not_configured',
      tracked: 0,
    });
  }

  const reported = input.players;
  const names = [...new Set(reported.map((player) => player.player_name))];

  // Only players who have paired a companion can be heard, so only they need a
  // position row. Resolving names to links in one query keeps this O(1) round
  // trips rather than one per player.
  const { data: links } = await admin
    .from('voice_player_links')
    .select('id, player_name')
    .eq('server_id', input.server_id)
    .is('revoked_at', null)
    .in('player_name', names);

  const linkByName = new Map((links ?? []).map((link) => [link.player_name as string, link.id as string]));
  const now = new Date().toISOString();

  const rows = reported.flatMap((player) => {
    const linkId = linkByName.get(player.player_name);
    if (!linkId) return [];
    return [
      {
        link_id: linkId,
        server_id: input.server_id,
        x: player.x,
        y: player.y,
        z: player.z,
        dimension: player.dimension,
        reported_by: 'add_on',
        updated_at: now,
      },
    ];
  });

  let ignored = 0;
  if (rows.length > 0) {
    const { error: upsertError } = await admin
      .from('voice_positions')
      .upsert(rows, { onConflict: 'link_id' });
    if (upsertError) {
      await logVoiceEvent({
        serverId: input.server_id,
        eventType: 'position_update_rejected',
        detail: { reason: upsertError.message },
      });
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }
  }
  ignored = reported.length - rows.length;

  // Clear players who are no longer in the report. Without this a player who
  // leaves stays audible at their last coordinate until the freshness window
  // expires, which would be ten seconds of ghost audio.
  // The builder is thenable, so it must not be awaited until every filter is
  // attached — awaiting early returns the response and leaves nothing to chain.
  const trackedLinkIds = rows.map((row) => row.link_id);
  let staleQuery = admin.from('voice_positions').select('link_id').eq('server_id', input.server_id);
  if (trackedLinkIds.length > 0) {
    staleQuery = staleQuery.not('link_id', 'in', `(${trackedLinkIds.join(',')})`);
  }
  const { data: stale } = await staleQuery;
  const staleIds = (stale ?? []).map((row) => row.link_id as string);
  if (staleIds.length > 0) {
    await admin.from('voice_positions').delete().eq('server_id', input.server_id).in('link_id', staleIds);
  }

  // Record what the add-on actually detected, so the dashboard can show real
  // version compatibility and whether server-net is available instead of
  // assuming either.
  await admin
    .from('voice_server_configs')
    .update({
      last_position_sync_at: now,
      ...(input.engine_version ? { detected_engine_version: input.engine_version } : {}),
      ...(input.script_api_version ? { detected_script_api_version: input.script_api_version } : {}),
      ...(typeof input.server_net_available === 'boolean'
        ? { server_net_available: input.server_net_available }
        : {}),
    })
    .eq('server_id', input.server_id);

  return NextResponse.json({
    ok: true,
    tracked: rows.length,
    ignored,
    removed: staleIds.length,
    server_time: now,
  });
}
