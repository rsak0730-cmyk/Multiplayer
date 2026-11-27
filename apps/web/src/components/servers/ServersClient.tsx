'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Server, Globe2, ShieldAlert, ArrowRight, Play, Square, Plus } from 'lucide-react';
import { StatusDot, statusToDot } from '@/components/ui/StatusDot';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/Card';

interface ServerRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  node_id: string;
  installed_version: string | null;
  minecraft_version: string | null;
  max_players: number;
  online_players: number;
  public_address: string | null;
  public_port: number | null;
  networking_verified: boolean;
  last_error: string | null;
  world_name: string | null;
  created_at: string;
}

interface NodeRow {
  id: string;
  name: string;
  computed_status: string;
}

export function ServersClient({
  servers: initialServers,
  nodes: initialNodes,
}: {
  servers: ServerRow[];
  nodes: NodeRow[];
}) {
  const [servers, setServers] = useState<ServerRow[]>(initialServers);
  const [nodes, setNodes] = useState<NodeRow[]>(initialNodes);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Keep the list live: servers change state when the agent reports back.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/servers', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        const rows = (json.servers ?? []) as Array<ServerRow & { node?: NodeRow | null }>;
        setServers(rows);
        setNodes(
          rows
            .filter((r) => r.node)
            .map((r) => ({
              id: r.node!.id,
              name: r.node!.name,
              computed_status: r.node!.computed_status,
            })),
        );
      } catch {
        /* transient network error — keep the last known state */
      }
    };
    void tick();
    const id = setInterval(tick, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  async function quickControl(server: ServerRow, action: 'start' | 'stop') {
    setBusyId(server.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? 'Request failed');
      } else {
        setMessage(
          json.message ??
            `${action === 'start' ? 'Start' : 'Stop'} queued for "${server.name}".`,
        );
      }
    } catch {
      setMessage('Network error while sending the command.');
    } finally {
      setBusyId(null);
    }
  }

  if (servers.length === 0) {
    return (
      <EmptyState
        icon={<Server className="h-6 w-6" />}
        title="No servers yet"
        description="Create a Minecraft Bedrock server on one of your paired Windows devices. You can configure the world, players, game mode and networking entirely from this panel."
        action={
          nodes.length === 0 ? (
            <Link href="/devices" className="btn-cyan">
              Pair a device first
            </Link>
          ) : (
              <Link href="/servers/new" className="btn-primary">
              <Plus className="h-4 w-4" /> Create your first server
            </Link>
          )
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? (
        <div className="glass border-violet-400/25 px-4 py-3 text-xs leading-relaxed text-white/75">
          {message}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {servers.map((s) => {
          const node = nodeById[s.node_id];
          const running = s.status === 'running';
          const busy = busyId === s.id;
          return (
            <div key={s.id} className="glass glass-hover flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/servers/${s.id}`}
                    className="block truncate text-base font-semibold text-white hover:text-violet-200"
                  >
                    {s.name}
                  </Link>
                  <p className="mt-1 truncate text-[11px] text-white/40">
                    {node ? `${node.name} · ${node.computed_status}` : 'node not found'} · world{' '}
                    {s.world_name ?? 'world'} ·{' '}
                    {s.installed_version ?? s.minecraft_version ?? 'BDS not installed'}
                  </p>
                  {s.description ? (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/35">
                      {s.description}
                    </p>
                  ) : null}
                </div>
                <StatusDot kind={statusToDot(s.status)} label={s.status} />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={running ? 'green' : 'slate'}>
                  {s.online_players}/{s.max_players} players
                </Badge>
                {running && s.networking_verified ? (
                  <Badge tone="cyan">
                    <Globe2 className="h-3 w-3" /> verified reachable
                  </Badge>
                ) : running ? (
                  <Badge tone="amber">
                    <ShieldAlert className="h-3 w-3" /> networking unverified
                  </Badge>
                ) : null}
                {s.public_address && s.networking_verified ? (
                  <Badge tone="violet">
                    {s.public_address}:{s.public_port}
                  </Badge>
                ) : null}
              </div>

              {s.last_error ? (
                <p className="rounded-lg border border-red-400/25 bg-red-500/8 px-3 py-2 text-[11px] leading-relaxed text-red-200/85">
                  {s.last_error}
                </p>
              ) : null}

              <div className="mt-auto flex items-center gap-2 pt-1">
                {running ? (
                  <button
                    type="button"
                    className="btn-ghost flex-1"
                    disabled={busy}
                    onClick={() => quickControl(s, 'stop')}
                  >
                    <Square className="h-4 w-4" /> Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary flex-1"
                    disabled={busy}
                    onClick={() => quickControl(s, 'start')}
                  >
                    <Play className="h-4 w-4" /> Start
                  </button>
                )}
                <Link href={`/servers/${s.id}`} className="btn-ghost">
                  Manage <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
