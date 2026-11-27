'use client';

import Link from 'next/link';
import { Server, ArrowRight, Globe2, ShieldAlert } from 'lucide-react';
import { StatusDot, statusToDot } from '@/components/ui/StatusDot';
import { Badge } from '@/components/ui/Badge';

interface ServerRow {
  id: string;
  name: string;
  status: string;
  installed_version: string | null;
  minecraft_version: string | null;
  max_players: number;
  online_players: number;
  public_address: string | null;
  public_port: number | null;
  networking_verified: boolean;
  last_error: string | null;
  node_id: string;
}

export function ServerActivityList({
  servers,
  nodesById,
  latestVersion,
}: {
  servers: ServerRow[];
  nodesById: Record<string, { name: string; computed_status: string }>;
  latestVersion: { version: string } | null;
}) {
  if (servers.length === 0) {
    return (
      <div className="glass p-5">
        <div className="mb-3 flex items-center gap-2">
          <Server className="h-4 w-4 text-violet-300" />
          <h3 className="card-title">Your servers</h3>
        </div>
        <p className="text-xs leading-relaxed text-white/45">
          You have not created a Minecraft Bedrock server yet.{' '}
          <Link href="/servers/new" className="text-violet-300 underline underline-offset-2">
            Create your first one
          </Link>{' '}
          — you will need a paired device first.
        </p>
      </div>
    );
  }

  return (
    <div className="glass p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-violet-300" />
          <h3 className="card-title">Your servers</h3>
        </div>
        <Link href="/servers" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
          All servers <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <ul className="flex flex-col gap-2.5">
        {servers.slice(0, 6).map((s) => {
          const node = nodesById[s.node_id];
          const outdated =
            latestVersion && s.installed_version && latestVersion.version !== s.installed_version;
          return (
            <li key={s.id}>
              <Link
                href={`/servers/${s.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3 transition-all duration-200 hover:border-violet-400/35 hover:bg-black/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-white/90">{s.name}</p>
                    {s.status === 'running' && s.networking_verified ? (
                      <Badge tone="green">
                        <Globe2 className="h-3 w-3" /> reachable
                      </Badge>
                    ) : s.status === 'running' ? (
                      <Badge tone="amber">
                        <ShieldAlert className="h-3 w-3" /> unverified net
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-[11px] text-white/40">
                    {node ? `${node.name} · ${node.computed_status}` : 'node missing'} ·{' '}
                    {s.installed_version ?? s.minecraft_version ?? 'BDS not installed'}
                    {outdated ? ` · ${latestVersion.version} available` : ''} ·{' '}
                    {s.online_players}/{s.max_players} players
                  </p>
                  {s.last_error ? (
                    <p className="mt-1 truncate text-[11px] text-red-300/80">{s.last_error}</p>
                  ) : null}
                </div>
                <StatusDot kind={statusToDot(s.status)} label={s.status} />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
