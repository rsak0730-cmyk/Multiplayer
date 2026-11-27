import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { discoverLatestBdsVersion } from '@/lib/bds/version-discovery';
import { DashboardClient } from '@/components/dashboard/DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: nodes }, { data: servers }, { data: events }] = await Promise.all([
    supabase.from('nodes').select('*').order('created_at', { ascending: false }),
    supabase.from('servers').select('*').order('created_at', { ascending: false }),
    supabase.from('node_events').select('*').order('created_at', { ascending: false }).limit(20),
  ]);

  const latest = await discoverLatestBdsVersion('stable');

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

  const totals = {
    servers: (servers ?? []).length,
    nodes: nodeList.length,
    nodes_online: onlineNodes.length,
    servers_running: runningServers.length,
    online_players: runningServers.reduce((sum, s) => sum + (s.online_players ?? 0), 0),
    online_players_verified_networking: runningServers
      .filter((s) => s.networking_verified)
      .reduce((sum, s) => sum + (s.online_players ?? 0), 0),
  };

  return (
    <DashboardClient
      email={user.email ?? ''}
      totals={totals}
      nodes={nodeList}
      servers={servers ?? []}
      events={events ?? []}
      latestVersion={latest}
      versionDiscoveryFailed={latest === null}
    />
  );
}
