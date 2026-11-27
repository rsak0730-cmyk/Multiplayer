import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Plus, Server } from 'lucide-react';
import { ServersClient } from '@/components/servers/ServersClient';

export const dynamic = 'force-dynamic';

export default async function ServersPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: servers }, { data: nodes }] = await Promise.all([
    supabase.from('servers').select('*').order('created_at', { ascending: false }),
    supabase.from('nodes').select('*').order('created_at', { ascending: false }),
  ]);

  const now = Date.now();
  const nodeList = (nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    computed_status: n.revoked_at
      ? 'revoked'
      : n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000
        ? 'online'
        : 'offline',
  }));

  return (
    <div className="fade-in flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">My Servers</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Minecraft Bedrock servers
          </h1>
          <p className="mt-1 text-xs text-white/45">
            {nodeList.filter((n) => n.computed_status === 'online').length} of {nodeList.length}{' '}
            devices online · each server runs on one of your own private nodes
          </p>
        </div>
        <Link href="/servers/new" className="btn-primary w-full sm:w-auto">
          <Plus className="h-4 w-4" /> Create server
        </Link>
      </header>

      <ServersClient servers={servers ?? []} nodes={nodeList} />
    </div>
  );
}
