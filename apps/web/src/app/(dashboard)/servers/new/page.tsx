import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { discoverLatestBdsVersion } from '@/lib/bds/version-discovery';
import { NewServerForm } from '@/components/servers/NewServerForm';

export const dynamic = 'force-dynamic';

export default async function NewServerPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: nodes } = await supabase
    .from('nodes')
    .select('*')
    .order('created_at', { ascending: false });

  const now = Date.now();
  const nodeList = (nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    operating_system: n.operating_system,
    agent_platform: n.agent_platform,
    revoked: Boolean(n.revoked_at),
    online: Boolean(
      !n.revoked_at && n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000,
    ),
    ram_available_mb: n.ram_available_mb,
    storage_available_mb: n.storage_available_mb,
  }));

  const latest = await discoverLatestBdsVersion('stable');

  return (
    <NewServerForm
      nodes={nodeList}
      latestVersion={latest}
      versionDiscoveryFailed={latest === null}
    />
  );
}
