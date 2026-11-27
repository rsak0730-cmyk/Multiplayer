'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, Blocks, Info } from 'lucide-react';
import { StatGrid, VersionWarning } from '@/components/dashboard/StatGrid';
import { NodeHealthCard } from '@/components/dashboard/NodeHealthCard';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { ServerActivityList } from '@/components/dashboard/ServerActivityList';
import { Badge } from '@/components/ui/Badge';

interface DashboardData {
  nodes: never[];
  servers: never[];
  events: never[];
}

export function DashboardClient({
  email,
  totals,
  nodes,
  servers,
  events,
  latestVersion,
  versionDiscoveryFailed,
}: {
  email: string;
  totals: {
    servers: number;
    nodes: number;
    nodes_online: number;
    servers_running: number;
    online_players: number;
    online_players_verified_networking: number;
  };
  nodes: Array<Record<string, never>>;
  servers: Array<Record<string, never>>;
  events: Array<Record<string, never>>;
  latestVersion: { version: string; channel: string; discoveredAt: string } | null;
  versionDiscoveryFailed: boolean;
}) {
  // Live refresh: re-fetch the dashboard API every 15s so numbers stay real.
  const [live, setLive] = useState<{
    totals: typeof totals;
    nodes: typeof nodes;
    servers: typeof servers;
    events: typeof events;
    latest_bds_version: typeof latestVersion;
    version_discovery_failed: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/dashboard', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setLive(json);
      } catch {
        /* ignore transient errors */
      }
    };
    void tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const t = live?.totals ?? totals;
  const n = (live?.nodes ?? nodes) as Array<Record<string, string | number | null>>;
  const s = (live?.servers ?? servers) as Array<Record<string, string | number | boolean | null>>;
  const e = (live?.events ?? events) as Array<Record<string, string | null>>;
  const latest = live ? live.latest_bds_version : latestVersion;
  const discoveryFailed = live ? live.version_discovery_failed : versionDiscoveryFailed;

  const nodesById: Record<string, { name: string; computed_status: string }> = {};
  for (const node of n) {
    nodesById[String(node.id)] = {
      name: String(node.name ?? 'Node'),
      computed_status: String(node.computed_status ?? 'unknown'),
    };
  }

  const hasNodes = n.length > 0;

  return (
    <div className="fade-in flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Overview</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Welcome back
          </h1>
          <p className="mt-1 text-xs text-white/45">{email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {latest ? (
            <Badge tone="cyan">
              <RefreshCw className="h-3 w-3" /> Latest BDS {latest.version}
            </Badge>
          ) : (
            <Badge tone="amber">
              <Info className="h-3 w-3" /> Latest BDS unknown
            </Badge>
          )}
          <Link href="/servers/new" className="btn-primary !min-h-10 !px-3.5 !py-2 text-xs sm:text-sm">
            <Plus className="h-4 w-4" /> New server
          </Link>
        </div>
      </header>

      {!hasNodes ? (
        <div className="glass flex flex-col items-start gap-3 border-violet-400/25 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-violet-400/30 bg-violet-500/12 text-violet-200">
              <Blocks className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white/90">Connect your Windows computer</p>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-white/45">
                OG HOST cannot host anything until a node is paired. Generate a pairing code, run the
                agent on your Windows laptop, and it will register itself here automatically.
              </p>
            </div>
          </div>
          <Link href="/devices" className="btn-cyan w-full shrink-0 sm:w-auto">
            Pair a device
          </Link>
        </div>
      ) : null}

      <VersionWarning failed={discoveryFailed} />

      <StatGrid totals={t} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="flex flex-col gap-5 lg:col-span-2">
          <NodeHealthCard nodes={n as never} />
          <ServerActivityList
            servers={s as never}
            nodesById={nodesById}
            latestVersion={latest}
          />
        </div>
        <ActivityFeed events={e as never} />
      </div>

      <p className="text-center text-[11px] leading-relaxed text-white/30">
        Every number above comes from your own nodes. Offline devices show their last reported
        values, and nothing is marked reachable until a real Bedrock protocol check succeeds.
      </p>
    </div>
  );
}
