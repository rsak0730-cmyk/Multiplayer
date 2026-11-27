import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { TerminalSquare, ArrowRight } from 'lucide-react';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { StatusDot, statusToDot } from '@/components/ui/StatusDot';

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: servers }, { data: nodes }] = await Promise.all([
    supabase.from('servers').select('*').order('created_at', { ascending: false }),
    supabase.from('nodes').select('*'),
  ]);

  const now = Date.now();
  const nodeById = new Map(
    (nodes ?? []).map((n) => [
      n.id,
      {
        name: n.name,
        online: Boolean(
          !n.revoked_at && n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000,
        ),
      },
    ]),
  );

  const serverList = servers ?? [];
  const running = serverList.filter((s) => s.status === 'running');

  return (
    <div className="fade-in flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Console</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Live server console
        </h1>
        <p className="mt-1 text-xs text-white/45">
          {running.length} of {serverList.length} servers running · pick one to open its console
        </p>
      </header>

      {serverList.length === 0 ? (
        <EmptyState
          icon={<TerminalSquare className="h-6 w-6" />}
          title="No servers yet"
          description="The console shows real Bedrock Dedicated Server output streamed from your Windows device. Create a server first."
          action={
            <Link href="/servers/new" className="btn-primary">
              Create a server
            </Link>
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {serverList.map((s) => {
            const node = nodeById.get(s.node_id);
            return (
              <Card key={s.id} hover>
                <CardHeader
                  icon={<TerminalSquare className="h-[18px] w-[18px]" />}
                  title={s.name}
                  subtitle={`${node ? `${node.name} · ${node.online ? 'online' : 'offline'}` : 'no device'} · world ${s.world_name ?? 'world'}`}
                  right={<StatusDot kind={statusToDot(s.status)} label={s.status} />}
                />
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone={s.status === 'running' ? 'green' : 'slate'}>
                    {s.online_players}/{s.max_players} players
                  </Badge>
                  <Badge tone="violet">
                    {s.installed_version ?? s.minecraft_version ?? 'BDS not installed'}
                  </Badge>
                  {node && !node.online ? <Badge tone="amber">device offline</Badge> : null}
                </div>
                <p className="mb-3 text-[11px] leading-relaxed text-white/40">
                  {s.status === 'running'
                    ? 'Console is live. Commands are checked against the Bedrock allowlist before they reach your device.'
                    : 'Start the server to stream its console output and send commands.'}
                </p>
                <Link
                  href={`/servers/${s.id}?tab=console`}
                  className="btn-primary w-full !min-h-10 !px-3.5 !py-2 text-xs"
                >
                  Open console <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader icon={<TerminalSquare className="h-[18px] w-[18px]" />} title="What the console can and cannot do" />
        <div className="grid gap-3 text-[11px] leading-relaxed text-white/55 sm:grid-cols-2">
          <p>
            Output is the real stdout and stderr of bedrock_server.exe, pushed by the agent in
            batches and tailed here every few seconds. Timestamps, copy, clear-view, auto-scroll and
            command history (per server, stored in your browser) are all supported, and the layout is
            built to be usable on a phone.
          </p>
          <p>
            Input is restricted to official Bedrock console commands from an allowlist, enforced both
            here and again on the device. There is no remote shell: you cannot run Windows commands,
            PowerShell or arbitrary executables through this panel. That is a deliberate security
            boundary, not a missing feature.
          </p>
        </div>
      </Card>
    </div>
  );
}
