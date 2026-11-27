'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DatabaseBackup,
  Plus,
  Loader2,
  RotateCcw,
  Trash2,
  Download,
  AlertCircle,
  CheckCircle2,
  Info,
  CalendarClock,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

interface BackupRow {
  id: string;
  name: string;
  file_name: string;
  size_bytes: number;
  minecraft_version: string | null;
  status: string;
  storage_provider: 'local' | 'google_drive';
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function BackupsPanel({
  server,
  node,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
}) {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<{
    enabled: boolean;
    interval_hours: number;
    keep_count: number;
    safe_stop_server: boolean;
  } | null>(null);

  const nodeOnline = node?.computed_status === 'online';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/servers/${server.id}/backups`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setBackups(json.backups ?? []);
    } catch {
      /* transient */
    }
  }, [server.id]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 8000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/servers/${server.id}/backup-schedule`, { cache: 'no-store' });
        if (res.ok) {
          const json = await res.json();
          setSchedule(json.schedule);
        }
      } catch {
        /* optional */
      }
    })();
  }, [server.id]);

  async function waitForCommand(commandId: string): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const res = await fetch(`/api/servers/${server.id}/commands/${commandId}`, {
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const json = await res.json();
      const cmd = json.command;
      if (cmd.status === 'completed') return;
      if (cmd.status === 'failed' || cmd.status === 'cancelled') {
        throw new Error(cmd.error_message ?? 'The node reported a failure.');
      }
    }
    throw new Error('Timed out waiting for the backup to finish.');
  }

  async function createBackup() {
    setBusy('create');
    setErrorText(null);
    setInfoText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/backups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to start the backup');
      await waitForCommand(json.command_id);
      setInfoText('Backup completed on your device.');
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Backup failed');
    } finally {
      setBusy(null);
    }
  }

  async function restore(backup: BackupRow) {
    if (
      !window.confirm(
        `Restore “${backup.name}”? The current world will be replaced by this backup. The server must be stopped.`,
      )
    ) {
      return;
    }
    setBusy(`restore:${backup.id}`);
    setErrorText(null);
    setInfoText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/backups/${backup.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to start the restore');
      await waitForCommand(json.command_id);
      setInfoText(`Restored “${backup.name}”. Start the server to play on it.`);
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setBusy(null);
    }
  }

  async function download(backup: BackupRow) {
    setBusy(`dl:${backup.id}`);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/backups/${backup.id}/download`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to get a download link');
      window.open(json.download_url, '_blank', 'noopener,noreferrer');
      setInfoText('Download link opened (valid 15 minutes).');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  async function remove(backup: BackupRow) {
    if (!window.confirm(`Delete backup “${backup.name}”? This cannot be undone.`)) return;
    setBusy(`del:${backup.id}`);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/backups/${backup.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? 'Failed to delete');
      }
      setInfoText(`Deleted “${backup.name}”.`);
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={<DatabaseBackup className="h-[18px] w-[18px]" />}
          title="World backups"
          subtitle="Stored on your own device, downloadable to your phone"
          right={
            <button
              type="button"
              className="btn-primary !min-h-9 !px-3 !py-1.5 text-xs"
              disabled={busy !== null || !nodeOnline}
              onClick={createBackup}
            >
              {busy === 'create' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Back up now
            </button>
          }
        />

        {!nodeOnline ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-amber-100/85">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              “{node?.name ?? 'This device'}” is offline. Backups are created on the device that
              hosts the world, so new backups and restores need the agent connected. Existing
              backups remain listed here.
            </span>
          </div>
        ) : null}

        {errorText ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-red-100/90">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{errorText}</span>
          </div>
        ) : null}
        {infoText ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-emerald-100/90">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{infoText}</span>
          </div>
        ) : null}

        {backups.length === 0 ? (
          <p className="text-xs text-white/45">
            No backups yet. A backup zips the world folder plus your configuration so a restore puts
            the server back exactly as it was.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {backups.map((b) => (
              <li
                key={b.id}
                className="flex flex-col gap-2.5 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-white/85">{b.name}</p>
                  <p className="mt-0.5 text-[10px] text-white/35">
                    {b.size_bytes > 0 ? `${formatSize(b.size_bytes)} · ` : ''}
                    {b.minecraft_version ?? 'version unknown'} ·{' '}
                    {new Date(b.created_at).toLocaleString()} · {b.storage_provider}
                  </p>
                  {b.error_message ? (
                    <p className="mt-1 text-[10px] leading-snug text-red-300/85">{b.error_message}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Badge
                    tone={
                      b.status === 'completed'
                        ? 'green'
                        : b.status === 'failed'
                          ? 'red'
                          : 'amber'
                    }
                  >
                    {b.status.replace('_', ' ')}
                  </Badge>
                  <button
                    type="button"
                    className="btn-ghost !min-h-9 !px-2.5 !py-1.5"
                    title="Restore"
                    disabled={busy !== null || b.status !== 'completed'}
                    onClick={() => restore(b)}
                  >
                    {busy === `restore:${b.id}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !min-h-9 !px-2.5 !py-1.5"
                    title="Download"
                    disabled={busy !== null || b.status !== 'completed'}
                    onClick={() => download(b)}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="btn-danger !min-h-9 !px-2.5 !py-1.5"
                    title="Delete"
                    disabled={busy !== null}
                    onClick={() => remove(b)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          icon={<CalendarClock className="h-[18px] w-[18px]" />}
          title="Schedule"
          subtitle={
            schedule
              ? schedule.enabled
                ? `Every ${schedule.interval_hours} h · keep ${schedule.keep_count}`
                : 'Automatic backups are off'
              : 'Loading schedule…'
          }
        />
        <div className="flex items-start gap-2.5 text-[11px] leading-relaxed text-white/50">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <p>
              Scheduled backups run on the device itself, so they keep working even when this website
              is not open. Backups are consistent: the world is flushed and, if the option is
              enabled, the server is stopped safely before the archive is written.
            </p>
            <p className="mt-2">
              Configure the schedule from the server’s Settings tab or the Backups page. Restoring
              always requires the server to be stopped — OG HOST will never overwrite a live world.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
