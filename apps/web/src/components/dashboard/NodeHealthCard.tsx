'use client';

import Link from 'next/link';
import { Cpu, HardDrive, MemoryStick, MonitorSmartphone, ArrowRight } from 'lucide-react';
import { Meter } from '@/components/ui/Meter';
import { StatusDot, statusToDot } from '@/components/ui/StatusDot';
import { Badge } from '@/components/ui/Badge';

interface NodeRow {
  id: string;
  name: string;
  hostname: string | null;
  operating_system: string | null;
  agent_version: string | null;
  computed_status: string;
  cpu_percent: number | null;
  ram_total_mb: number | null;
  ram_available_mb: number | null;
  storage_total_mb: number | null;
  storage_available_mb: number | null;
  last_seen_at: string | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never connected';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function NodeHealthCard({ nodes }: { nodes: NodeRow[] }) {
  if (nodes.length === 0) {
    return (
      <div className="glass p-5">
        <div className="mb-3 flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-violet-300" />
          <h3 className="card-title">Device health</h3>
        </div>
        <p className="text-xs leading-relaxed text-white/45">
          No devices connected yet. Pair your Windows computer from the{' '}
          <Link href="/devices" className="text-violet-300 underline underline-offset-2">
            Devices
          </Link>{' '}
          page — it takes about two minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="glass p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-violet-300" />
          <h3 className="card-title">Device health</h3>
        </div>
        <Link href="/devices" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
          Manage <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="flex flex-col gap-4">
        {nodes.slice(0, 4).map((node) => {
          const ramUsedPct =
            node.ram_total_mb && node.ram_available_mb !== null
              ? ((node.ram_total_mb - node.ram_available_mb) / node.ram_total_mb) * 100
              : null;
          const storageUsedPct =
            node.storage_total_mb && node.storage_available_mb !== null
              ? ((node.storage_total_mb - node.storage_available_mb) / node.storage_total_mb) * 100
              : null;
          const online = node.computed_status === 'online';
          return (
            <div key={node.id} className="rounded-xl border border-white/8 bg-black/25 p-3.5">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/devices?focus=${node.id}`}
                    className="truncate text-sm font-semibold text-white/90 hover:text-white"
                  >
                    {node.name}
                  </Link>
                  <p className="mt-0.5 truncate text-[11px] text-white/40">
                    {node.operating_system ?? 'Unknown OS'} · agent{' '}
                    {node.agent_version ?? 'n/a'} · seen {relativeTime(node.last_seen_at)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <StatusDot kind={statusToDot(node.computed_status)} label={node.computed_status} />
                  {online ? null : (
                    <Badge tone="slate">metrics stale</Badge>
                  )}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Meter
                  value={online ? node.cpu_percent : null}
                  label="CPU"
                  detail={online ? `${(node.cpu_percent ?? 0).toFixed(0)}% used` : 'offline — no data'}
                />
                <Meter
                  value={online ? ramUsedPct : null}
                  label="RAM"
                  detail={
                    node.ram_total_mb
                      ? `${Math.round((node.ram_available_mb ?? 0) / 1024)} GB free of ${Math.round(node.ram_total_mb / 1024)} GB`
                      : 'unknown'
                  }
                />
                <Meter
                  value={online ? storageUsedPct : null}
                  label="Storage"
                  detail={
                    node.storage_total_mb
                      ? `${Math.round((node.storage_available_mb ?? 0) / 1024)} GB free of ${Math.round(node.storage_total_mb / 1024)} GB`
                      : 'unknown'
                  }
                />
              </div>

              {!online ? (
                <p className="mt-3 flex items-center gap-1.5 text-[11px] text-white/35">
                  <Cpu className="h-3 w-3" /> Values shown are the last report before this device
                  went offline.
                </p>
              ) : null}
              {online && node.ram_available_mb !== null && node.ram_available_mb < 1024 ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-100/85">
                  <MemoryStick className="mt-0.5 h-3 w-3 shrink-0" />
                  Only {node.ram_available_mb} MB free. Bedrock Dedicated Server needs roughly 1 GB —
                  close other programs before starting a server.
                </p>
              ) : null}
              {online && node.storage_available_mb !== null && node.storage_available_mb < 2048 ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-red-400/25 bg-red-500/8 px-2.5 py-2 text-[11px] text-red-100/85">
                  <HardDrive className="mt-0.5 h-3 w-3 shrink-0" />
                  Only {Math.round(node.storage_available_mb / 1024)} GB free. Backups and world
                  growth need room.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
