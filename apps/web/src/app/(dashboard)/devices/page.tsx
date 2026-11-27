import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DevicesClient } from '@/components/devices/DevicesClient';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
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
    ...n,
    computed_status: n.revoked_at
      ? 'revoked'
      : n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000
        ? 'online'
        : 'offline',
  }));

  return <DevicesClient initialNodes={nodeList} />;
}
