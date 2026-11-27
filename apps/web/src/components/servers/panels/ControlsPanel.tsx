'use client';

import { useState } from 'react';
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Users,
  Play,
  Square,
  RotateCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Info,
  DatabaseBackup,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Meter } from '@/components/ui/Meter';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

export function ControlsPanel({
  server,
  node,
  onChanged,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null);

  async function run(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setFeedback(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) {
        setFeedback({ tone: 'err', text: json.error ?? 'Request failed' });
      } else {
        setFeedback({
          tone: 'ok',
          text:
            json.message ??
            'Command queued. Your node picks it up within a few seconds and reports the result here.',
        });
      }
      onChanged();
    } catch {
      setFeedback({ tone: 'err', text: 'Network error while contacting OG HOST.' });
    } finally {
      setBusy(null);
    }
  }

  const online = node?.computed_status === 'online';
  const ramUsedPct =
    online && node?.ram_total_mb && node?.ram_available_mb !== null
      ? ((node.ram_total_mb - node.ram_available_mb) / node.ram_total_mb) * 100
      : null;
  const storageUsedPct =
    online && node?.storage_total_mb && node?.storage_available_mb !== null
      ? ((node.storage_total_mb - node.storage_available_mb) / node.storage_total_mb) * 100
      : null;

  const lowRam = online && node?.ram_available_mb !== null && node.ram_available_mb < 1024;
  const lowDisk = online && node?.storage_available_mb !== null && node.storage_available_mb < 2048;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          icon={<Activity className="h-[18px] w-[18px]" />}
          title="Server state"
          subtitle="Reported by the agent on your device"
          right={<Badge tone={server.status === 'running' ? 'green' : 'slate'}>{server.status}</Badge>}
        />

        <dl className="grid grid-cols-2 gap-3 text-xs">
          <Fact label="World" value={server.world_name ?? 'world'} />
          <Fact label="Port (UDP)" value={String(server.port)} />
          <Fact
            label="Installed BDS"
            value={server.installed_version ?? 'not installed yet'}
          />
          <Fact label="Players" value={`${server.online_players} / ${server.max_players}`} />
          <Fact
            label="Last started"
            value={server.last_started_at ? new Date(server.last_started_at).toLocaleString() : 'never'}
          />
          <Fact
            label="Last stopped"
            value={server.last_stopped_at ? new Date(server.last_stopped_at).toLocaleString() : 'never'}
          />
        </dl>

        <div className="divider" />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null || server.status === 'running'}
            onClick={() => run('start')}
          >
            {busy === 'start' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Start
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || server.status !== 'running'}
            onClick={() => run('stop')}
          >
            {busy === 'stop' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            Stop
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || server.status !== 'running'}
            onClick={() => run('restart')}
          >
            {busy === 'restart' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            Restart
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null}
            onClick={() => run('backup')}
          >
            {busy === 'backup' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <DatabaseBackup className="h-4 w-4" />
            )}
            Back up now
          </button>
        </div>

        {feedback ? (
          <div
            className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed ${
              feedback.tone === 'ok'
                ? 'border-emerald-400/25 bg-emerald-500/8 text-emerald-100/90'
                : feedback.tone === 'err'
                  ? 'border-red-400/25 bg-red-500/8 text-red-100/90'
                  : 'border-white/10 bg-white/5 text-white/65'
            }`}
          >
            {feedback.tone === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        ) : null}

        {!server.installed_version ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-violet-400/25 bg-violet-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-violet-100/85">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Bedrock Dedicated Server is not installed on this device yet. Pressing Start queues an
              install first — the agent discovers the current official build, verifies the download,
              then starts the server and reports the real version back here.
            </span>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          icon={<Cpu className="h-[18px] w-[18px]" />}
          title="Device resources"
          subtitle={node ? `${node.name} · ${node.operating_system ?? 'Unknown OS'}` : 'No device'}
          right={
            <Badge tone={online ? 'green' : 'slate'}>{node?.computed_status ?? 'unknown'}</Badge>
          }
        />

        {!node ? (
          <p className="text-xs text-white/45">This server has no hosting device assigned.</p>
        ) : (
          <>
            <div className="flex flex-col gap-3.5">
              <Meter
                value={online ? node.cpu_percent : null}
                label="CPU"
                detail={
                  online
                    ? `${(node.cpu_percent ?? 0).toFixed(0)}% in use`
                    : 'Device offline — last known values unavailable'
                }
              />
              <Meter
                value={ramUsedPct}
                label="RAM"
                detail={
                  node.ram_total_mb
                    ? `${Math.round((node.ram_available_mb ?? 0) / 1024 * 10) / 10} GB free of ${Math.round(node.ram_total_mb / 1024 * 10) / 10} GB`
                    : 'unknown'
                }
              />
              <Meter
                value={storageUsedPct}
                label="Storage"
                detail={
                  node.storage_total_mb
                    ? `${Math.round((node.storage_available_mb ?? 0) / 1024)} GB free of ${Math.round(node.storage_total_mb / 1024)} GB`
                    : 'unknown'
                }
              />
            </div>

            {!online ? (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[11px] leading-relaxed text-white/55">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Values are only shown while the agent is connected. When a device is offline OG
                  HOST displays “offline” rather than pretending the last numbers are current.
                </span>
              </div>
            ) : null}

            {lowRam ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-amber-100/85">
                <MemoryStick className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Only {node.ram_available_mb} MB free. The start request will be rejected until at
                  least ~1 GB is available. Close browsers and other apps on the device.
                </span>
              </div>
            ) : null}

            {lowDisk ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-red-100/85">
                <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Only {Math.round((node.storage_available_mb ?? 0) / 1024)} GB free. Bedrock worlds
                  grow with exploration, and backups need room too.
                </span>
              </div>
            ) : null}

            <div className="divider" />
            <div className="flex items-center gap-2 text-[11px] text-white/40">
              <Users className="h-3.5 w-3.5" />
              Player count is parsed from real BDS console output on the node. It is 0 while the
              server is stopped.
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/8 bg-black/25 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-white/35">{label}</dt>
      <dd className="mt-0.5 truncate text-xs font-medium text-white/80">{value}</dd>
    </div>
  );
}
