'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Info,
  Search,
  Download,
  Undo2,
  History,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

interface VersionRow {
  id: string;
  version: string;
  channel: 'stable' | 'preview';
  action: 'installed' | 'updated' | 'rolled_back' | 'verified';
  install_path: string | null;
  archive_checksum_sha256: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  created_at: string;
  error_message: string | null;
}

interface LatestVersion {
  version: string;
  channel: 'stable' | 'preview';
  downloadUrl: string | null;
  discoveredAt: string;
  source: string;
}

export function VersionsPanel({
  server,
  node,
  onChanged,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
  onChanged: () => void;
}) {
  const [history, setHistory] = useState<VersionRow[]>([]);
  const [latest, setLatest] = useState<LatestVersion | null>(null);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [channel, setChannel] = useState<'stable' | 'preview'>('stable');

  const nodeOnline = node?.computed_status === 'online';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/servers/${server.id}/versions`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setErrorText(j?.error ?? 'Failed to load version information');
        return;
      }
      const json = await res.json();
      setHistory(json.history ?? []);
      setLatest(json.latest ?? null);
      setDiscoveryFailed(Boolean(json.discovery_failed));
      setUpdateAvailable(json.update_available ?? null);
    } catch {
      setErrorText('Network error while loading versions.');
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function waitForCommand(commandId: string): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(`/api/servers/${server.id}/commands/${commandId}`, {
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const json = await res.json();
      const cmd = json.command;
      if (cmd.status === 'completed') return (cmd.result ?? null) as Record<string, unknown> | null;
      if (cmd.status === 'failed' || cmd.status === 'cancelled') {
        throw new Error(cmd.error_message ?? 'The node reported a failure.');
      }
    }
    throw new Error('Timed out. The operation may still be running on your device — check again.');
  }

  async function run(action: 'check' | 'update' | 'rollback', version?: string) {
    setBusy(action);
    setErrorText(null);
    setInfoText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, channel, version }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Request failed');
      if (action === 'check') {
        setInfoText('Asked your device to re-check the installed and available versions.');
      } else {
        setInfoText(
          action === 'update'
            ? 'Update started on your device. It backs up the world first, verifies the download, installs into a new versioned folder, and rolls back automatically if the server fails to start.'
            : `Rollback to ${version} started.`,
        );
      }
      await waitForCommand(json.command_id);
      await load();
      onChanged();
      setInfoText(
        action === 'check'
          ? 'Version check finished.'
          : action === 'update'
            ? 'Update finished. Start the server to confirm it runs the new version.'
            : 'Rollback finished.',
      );
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy(null);
    }
  }

  const installed = server.installed_version;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={<RefreshCw className="h-[18px] w-[18px]" />}
          title="Minecraft version manager"
          subtitle="No version numbers are hard-coded — the latest official build is discovered at runtime"
          right={<Badge tone={nodeOnline ? 'green' : 'slate'}>node {node?.computed_status ?? 'unknown'}</Badge>}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/8 bg-black/25 px-3.5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-white/35">Installed</p>
            <p className="mt-1 text-sm font-semibold text-white/90">
              {installed ?? 'not installed'}
            </p>
            <p className="mt-0.5 text-[10px] text-white/35">reported by your device</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-black/25 px-3.5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-white/35">Latest available</p>
            <p className="mt-1 text-sm font-semibold text-white/90">
              {discoveryFailed ? 'unknown' : (latest?.version ?? 'checking…')}
            </p>
            <p className="mt-0.5 text-[10px] text-white/35">
              {discoveryFailed
                ? 'official source unreachable from here'
                : (latest ? `${latest.source} · ${latest.channel}` : 'discovering…')}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-black/25 px-3.5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-white/35">Status</p>
            <p className="mt-1 text-sm font-semibold text-white/90">
              {updateAvailable === null
                ? 'unknown'
                : updateAvailable
                  ? 'update available'
                  : 'up to date'}
            </p>
            <p className="mt-0.5 text-[10px] text-white/35">
              {installed && latest ? `comparing ${installed} → ${latest.version}` : 'needs both values'}
            </p>
          </div>
        </div>

        {discoveryFailed ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-amber-100/85">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              OG HOST could not reach the official Bedrock server download source from this
              deployment, so it shows “unknown” instead of guessing a version. Your Windows agent
              performs its own discovery and verifies the downloaded archive before installing, so
              updates still work.
            </span>
          </div>
        ) : null}

        <div className="divider" />

        <div className="flex flex-wrap items-center gap-2">
          <span className="label !mb-0">Channel</span>
          <div className="flex gap-1.5">
            {(['stable', 'preview'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChannel(c)}
                className={`rounded-xl border px-3 py-2 text-[11px] font-medium capitalize transition-all ${
                  channel === c
                    ? 'border-violet-400/50 bg-violet-500/15 text-white'
                    : 'border-white/8 bg-black/25 text-white/50 hover:border-white/20'
                }`}
                style={{ minHeight: 40 }}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
              disabled={busy !== null || !nodeOnline}
              onClick={() => run('check')}
            >
              {busy === 'check' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Re-check
            </button>
            <button
              type="button"
              className="btn-primary !min-h-9 !px-3 !py-1.5 text-xs"
              disabled={busy !== null || !nodeOnline || server.status === 'running'}
              onClick={() => run('update')}
            >
              {busy === 'update' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {updateAvailable ? `Update to ${latest?.version}` : 'Update'}
            </button>
          </div>
        </div>

        {server.status === 'running' ? (
          <p className="mt-3 text-[11px] text-amber-200/80">
            Stop the server before updating. OG HOST never silently replaces a running server.
          </p>
        ) : null}

        {errorText ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-red-100/90">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{errorText}</span>
          </div>
        ) : null}
        {infoText ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-emerald-100/90">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{infoText}</span>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          icon={<History className="h-[18px] w-[18px]" />}
          title="Version history"
          subtitle="Every install, update and rollback on this server"
        />
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-14 w-full" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs text-white/45">
            Nothing recorded yet. History builds up as the agent installs and updates Bedrock
            Dedicated Server on your device.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.map((v) => (
              <li
                key={v.id}
                className="flex flex-col gap-2.5 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold text-white/90">{v.version}</p>
                    <Badge tone={v.channel === 'preview' ? 'amber' : 'violet'}>{v.channel}</Badge>
                    <Badge
                      tone={
                        v.status === 'completed'
                          ? 'green'
                          : v.status === 'failed'
                            ? 'red'
                            : 'amber'
                      }
                    >
                      {v.action.replace('_', ' ')} · {v.status.replace('_', ' ')}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-white/35">
                    {new Date(v.created_at).toLocaleString()}
                    {v.install_path ? ` · ${v.install_path}` : ''}
                    {v.archive_checksum_sha256
                      ? ` · sha256 ${v.archive_checksum_sha256.slice(0, 12)}…`
                      : ''}
                  </p>
                  {v.error_message ? (
                    <p className="mt-1 text-[10px] leading-snug text-red-300/85">{v.error_message}</p>
                  ) : null}
                </div>
                {v.status === 'completed' && v.version !== installed ? (
                  <button
                    type="button"
                    className="btn-ghost shrink-0 !min-h-9 !px-3 !py-1.5 text-xs"
                    disabled={busy !== null || !nodeOnline || server.status === 'running'}
                    onClick={() => run('rollback', v.version)}
                  >
                    {busy === 'rollback' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Undo2 className="h-3.5 w-3.5" />
                    )}
                    Roll back to this
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[11px] leading-relaxed text-white/50">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <p className="font-medium text-white/70">How an update actually runs</p>
            <p className="mt-1">
              1. Stop the server safely · 2. Back up the world and configuration · 3. Download the
              official archive · 4. Verify the archive checksum · 5. Extract into a new versioned
              folder · 6. Re-link your existing world (worlds are stored separately from the engine
              files) · 7. Start and health-check · 8. If startup fails, restore the previous version
              automatically.
            </p>
            <p className="mt-2">
              Rollback is only offered for versions that previously installed successfully on this
              device — OG HOST will not pretend an older build exists locally when it does not.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
