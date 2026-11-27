import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Globe2, ShieldAlert, CheckCircle2, ArrowRight, Info, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';

export const dynamic = 'force-dynamic';

export default async function NetworkingPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: servers }, { data: nodes }, { data: endpoints }] = await Promise.all([
    supabase.from('servers').select('*').order('created_at', { ascending: false }),
    supabase.from('nodes').select('*'),
    supabase
      .from('network_endpoints')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(100),
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
  const verifiedCount = serverList.filter((s) => s.networking_verified && s.status === 'running').length;

  return (
    <div className="fade-in flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Networking</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Multiplayer connectivity
        </h1>
        <p className="mt-1 text-xs text-white/45">
          {verifiedCount} of {serverList.filter((s) => s.status === 'running').length} running{' '}
          servers have a verified public address
        </p>
      </header>

      <Card className="border-amber-400/25">
        <CardHeader
          icon={<ShieldAlert className="h-[18px] w-[18px]" />}
          title="Read this before sharing an address"
        />
        <div className="grid gap-3 text-[11px] leading-relaxed text-white/55 sm:grid-cols-2">
          <p>
            A working dashboard is not the same as a working Minecraft server. Bedrock gameplay is
            UDP using the RakNet protocol, so ordinary HTTPS tunnels (ngrok HTTP, cloudflared http,
            localtunnel) cannot carry it and will never make your server joinable.
          </p>
          <p>
            Mobile broadband from Airtel, Jio and Vi usually sits behind CGNAT, which means there is
            no public IPv4 address to connect to. Direct mode will fail on those networks — use a
            UDP-capable tunnel such as Playit, or a manual endpoint you control.
          </p>
          <p>
            OG HOST only labels an address <span className="text-emerald-300">verified</span> after a
            genuine Bedrock protocol round trip succeeds. Anything else is shown as{' '}
            <span className="text-amber-300">unverified</span>, and no address at all is shown when
            nothing has been established. No IP is ever invented.
          </p>
          <p>
            The final confirmation is always a real client: open Minecraft Bedrock on your phone, add
            the server as an external server, and join. Until that succeeds, treat the address as
            untested.
          </p>
        </div>
      </Card>

      {serverList.length === 0 ? (
        <EmptyState
          icon={<Globe2 className="h-6 w-6" />}
          title="No servers to network yet"
          description="Create a Minecraft Bedrock server first, then choose its networking provider from the server’s Networking tab."
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
            const serverEndpoints = (endpoints ?? []).filter((e) => e.server_id === s.id);
            const activeEndpoint = serverEndpoints.find(
              (e) => e.status === 'verified' || e.status === 'active',
            );
            return (
              <Card key={s.id} hover className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/servers/${s.id}?tab=networking`}
                      className="block truncate text-sm font-semibold text-white/90 hover:text-violet-200"
                    >
                      {s.name}
                    </Link>
                    <p className="mt-1 truncate text-[11px] text-white/40">
                      {node ? `${node.name} · ${node.online ? 'online' : 'offline'}` : 'no device'} ·
                      provider {s.network_provider} · local port {s.port}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge tone={s.status === 'running' ? 'green' : 'slate'}>{s.status}</Badge>
                    {s.networking_verified ? (
                      <Badge tone="cyan">
                        <CheckCircle2 className="h-3 w-3" /> verified
                      </Badge>
                    ) : activeEndpoint ? (
                      <Badge tone="amber">
                        <ShieldAlert className="h-3 w-3" /> unverified
                      </Badge>
                    ) : (
                      <Badge tone="slate">
                        <WifiOff className="h-3 w-3" /> none
                      </Badge>
                    )}
                  </div>
                </div>

                {activeEndpoint?.address ? (
                  <div
                    className={`rounded-xl border px-3.5 py-3 ${
                      activeEndpoint.verified
                        ? 'border-emerald-400/25 bg-emerald-500/8'
                        : 'border-amber-400/25 bg-amber-500/8'
                    }`}
                  >
                    <p
                      className={`text-[10px] uppercase tracking-wider ${
                        activeEndpoint.verified ? 'text-emerald-200/60' : 'text-amber-200/60'
                      }`}
                    >
                      {activeEndpoint.verified ? 'Verified address' : 'Reported address — unverified'}
                    </p>
                    <p className="mt-1 font-mono text-base font-bold text-white">
                      {activeEndpoint.address}:{activeEndpoint.port ?? s.port}
                    </p>
                    {activeEndpoint.verified_at ? (
                      <p className="mt-1 text-[10px] text-white/40">
                        verified {new Date(activeEndpoint.verified_at).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="rounded-xl border border-white/8 bg-black/25 px-3.5 py-3 text-[11px] leading-relaxed text-white/40">
                    No public address known. Start the server, then start networking from this
                    server’s Networking tab.
                  </p>
                )}

                <Link
                  href={`/servers/${s.id}?tab=networking`}
                  className="btn-ghost mt-auto !min-h-9 !px-3 !py-1.5 text-xs"
                >
                  Configure <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader icon={<Info className="h-[18px] w-[18px]" />} title="Provider comparison" />
        <div className="grid gap-2.5 sm:grid-cols-3">
          {[
            {
              name: 'Direct',
              cgnat: 'No',
              cost: 'Free',
              notes: 'Needs a public IPv4 or port forwarding. Simplest when it works; fails on most Indian mobile broadband.',
            },
            {
              name: 'Playit',
              cgnat: 'Yes',
              cost: 'Free tier',
              notes: 'Outbound UDP tunnel. Requires a Playit secret on the device. Free tier has limits and third-party availability can change.',
            },
            {
              name: 'Manual',
              cgnat: 'Depends',
              cost: 'Yours',
              notes: 'Any address you control — your own VPS relay, router forward, or another UDP tunnel. OG HOST still verifies it before trusting it.',
            },
          ].map((p) => (
            <div key={p.name} className="rounded-xl border border-white/8 bg-black/25 px-3.5 py-3">
              <p className="text-xs font-semibold text-white/85">{p.name}</p>
              <p className="mt-1.5 text-[10px] text-white/40">
                CGNAT: <span className="text-white/65">{p.cgnat}</span> · {p.cost}
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-white/45">{p.notes}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-white/40">
          The provider layer is pluggable: implement INetworkProvider in the Windows agent and add a
          row to the network_providers table to support a new tunnel without changing the website.
          See docs/NETWORKING.md for what has actually been tested and what still needs a real
          Bedrock client.
        </p>
      </Card>
    </div>
  );
}
