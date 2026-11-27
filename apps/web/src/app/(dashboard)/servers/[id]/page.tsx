import { createClient } from '@/lib/supabase/server';
import { notFound, redirect } from 'next/navigation';
import { ServerDetailClient } from '@/components/servers/ServerDetailClient';

export const dynamic = 'force-dynamic';

export default async function ServerDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: server } = await supabase
    .from('servers')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!server) notFound();

  const [{ data: node }, { data: config }] = await Promise.all([
    supabase.from('nodes').select('*').eq('id', server.node_id).maybeSingle(),
    supabase.from('server_configs').select('*').eq('server_id', server.id).maybeSingle(),
  ]);

  const now = Date.now();
  const nodeOnline =
    node && !node.revoked_at && node.last_seen_at
      ? now - new Date(node.last_seen_at).getTime() < 90_000
      : false;

  return (
    <ServerDetailClient
      server={server}
      node={node ? { ...node, computed_status: nodeOnline ? 'online' : 'offline' } : null}
      config={config}
    />
  );
}
