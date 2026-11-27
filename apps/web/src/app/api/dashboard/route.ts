import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';
import { discoverLatestBdsVersion } from '@/lib/bds/version-discovery';

export const runtime = 'nodejs';

/**
 * GET /api/dashboard
 * Aggregated, real data only. Every field is either a measured value, an
 * explicit null, or a state label. No fabricated statistics.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const [{ data: nodes }, { data: servers }, { data: events }] = await Promise.all([
    supabase.from('nodes').select('*').order('created_at', { ascending: false }),
    supabase.from('servers').select('*').order('created_at', { ascending: false }),
    supabase.from('node_events').select('*').order('created_at', { ascending: false }).limit(20),
  ]);

  const now = Date.now();
  const nodeList = (nodes ?? []).map((n) => ({
    ...n,
    computed_status: n.revoked_at
      ? 'revoked'
      : n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000
        ? 'online'
        : 'offline',
  }));

  const onlineNodes = nodeList.filter((n) => n.computed_status === 'online');
  const runningServers = (servers ?? []).filter((s) => s.status === 'running');
  // Online players is only meaningful for running servers; agent-reported.
  const onlinePlayers = runningServers.reduce((sum, s) => sum + (s.online_players ?? 0), 0);

  // Only count players on servers whose networking has actually been verified,
  // otherwise the number would imply reachable multiplayer that we have not proven.
  const verifiedServers = runningServers.filter((s) => s.networking_verified);

  const latestBds = await discoverLatestBdsVersion('stable');

  return NextResponse.json({
    totals: {
      servers: (servers ?? []).length,
      nodes: nodeList.length,
      nodes_online: onlineNodes.length,
      servers_running: runningServers.length,
      online_players: onlinePlayers,
      // Players whose servers have verified public networking.
      online_players_verified_networking: verifiedServers.reduce(
        (sum, s) => sum + (s.online_players ?? 0),
        0,
      ),
    },
    nodes: nodeList,
    servers: servers ?? [],
    events: events ?? [],
    latest_bds_version: latestBds,
    version_discovery_failed: latestBds === null,
    generated_at: new Date().toISOString(),
  });
}
