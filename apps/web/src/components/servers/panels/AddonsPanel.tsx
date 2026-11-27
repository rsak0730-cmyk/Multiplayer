'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Puzzle,
  Upload,
  Loader2,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Info,
  Ban,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

interface AddonRow {
  id: string;
  file_name: string;
  addon_type: 'mcpack' | 'mcaddon' | 'mcworld';
  size_bytes: number;
  status: 'pending' | 'installing' | 'installed' | 'failed';
  installed_path: string | null;
  created_at: string;
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

const ACCEPTED = '.mcpack,.mcaddon,.mcworld';

export function AddonsPanel({
  server,
  node,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
}) {
  const [addons, setAddons] = useState<AddonRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);

  const nodeOnline = node?.computed_status === 'online';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/servers/${server.id}/addons`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setAddons(json.addons ?? []);
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

  async function waitForCommand(commandId: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
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
    throw new Error('Timed out waiting for the device to finish.');
  }

  async function upload(file: File) {
    setBusy(true);
    setErrorText(null);
    setInfoText(null);
    const lower = file.name.toLowerCase();

    if (lower.endsWith('.jar')) {
      setErrorText(
        'That is a Java Edition plugin. The official Minecraft Bedrock Dedicated Server cannot load .jar plugins — it uses Bedrock add-ons (.mcpack, .mcaddon) and behaviour/resource packs.',
      );
      setBusy(false);
      return;
    }
    if (!ACCEPTED.split(',').some((ext) => lower.endsWith(ext))) {
      setErrorText('Unsupported file type. Bedrock add-ons must be .mcpack, .mcaddon or .mcworld.');
      setBusy(false);
      return;
    }

    try {
      setProgress('Registering add-on…');
      const res = await fetch(`/api/servers/${server.id}/addons`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: file.name, size_bytes: file.size }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to register the add-on');

      setProgress('Uploading to storage…');
      const put = await fetch(json.signed_upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'false' },
        body: file,
      });
      if (!put.ok) throw new Error('Upload to storage failed. Please retry.');

      setProgress('Asking your device to install…');
      const install = await fetch(`/api/servers/${server.id}/addons/${json.addon.id}/install`, {
        method: 'POST',
      });
      const installJson = await install.json();
      if (!install.ok) throw new Error(installJson.error ?? 'Failed to queue the install');

      await waitForCommand(installJson.command_id);
      setProgress(null);
      setInfoText(
        `“${file.name}” installed. Restart the server for Bedrock to pick up the new packs if it is currently running.`,
      );
      await load();
    } catch (e) {
      setProgress(null);
      setErrorText(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(addon: AddonRow) {
    if (!window.confirm(`Remove “${addon.file_name}” from this server?`)) return;
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/addons/${addon.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? 'Failed to remove');
      }
      setInfoText(`Removed “${addon.file_name}”.`);
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to remove');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={<Puzzle className="h-[18px] w-[18px]" />}
          title="Bedrock add-ons"
          subtitle=".mcpack · .mcaddon · .mcworld"
          right={<Badge tone={nodeOnline ? 'green' : 'slate'}>node {node?.computed_status ?? 'unknown'}</Badge>}
        />

        <label
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition-all ${
            busy
              ? 'border-white/10 bg-black/20 opacity-60'
              : 'border-violet-400/30 bg-violet-500/5 hover:border-violet-400/60 hover:bg-violet-500/10'
          }`}
        >
          {busy ? (
            <Loader2 className="h-6 w-6 animate-spin text-violet-300" />
          ) : (
            <Upload className="h-6 w-6 text-violet-300" />
          )}
          <span className="text-sm font-medium text-white/85">
            {progress ?? 'Tap to upload an add-on'}
          </span>
          <span className="text-[11px] text-white/40">
            Files go straight to storage, then your device pulls them into the server’s
            behaviour_packs / resource_packs folders.
          </span>
          <input
            type="file"
            accept={ACCEPTED}
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </label>

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

        <div className="divider" />

        {addons.length === 0 ? (
          <p className="text-xs text-white/45">
            No add-ons uploaded yet. Uploaded packs appear here with their install status.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {addons.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-white/85">{a.file_name}</p>
                  <p className="mt-0.5 text-[10px] text-white/35">
                    .{a.addon_type} · {formatSize(a.size_bytes)} ·{' '}
                    {new Date(a.created_at).toLocaleString()}
                  </p>
                  {a.error_message ? (
                    <p className="mt-1 text-[10px] leading-snug text-red-300/85">{a.error_message}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge
                    tone={
                      a.status === 'installed'
                        ? 'green'
                        : a.status === 'failed'
                          ? 'red'
                          : a.status === 'installing'
                            ? 'amber'
                            : 'slate'
                    }
                  >
                    {a.status}
                  </Badge>
                  <button
                    type="button"
                    className="btn-danger !min-h-9 !px-2.5 !py-1.5"
                    title="Remove"
                    disabled={busy}
                    onClick={() => remove(a)}
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
        <CardHeader icon={<Ban className="h-[18px] w-[18px]" />} title="Bedrock vs Java" />
        <div className="flex items-start gap-2.5 text-[11px] leading-relaxed text-white/50">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <p>
              The official Bedrock Dedicated Server has no plugin API compatible with Java Edition.
              Spigot, Paper, Bukkit and .jar plugins will never load here, and OG HOST rejects them
              with an explanation rather than failing silently.
            </p>
            <p className="mt-2">
              What does work: behaviour packs, resource packs, skin packs and worlds packaged as{' '}
              <span className="text-white/75">.mcpack</span>,{' '}
              <span className="text-white/75">.mcaddon</span> and{' '}
              <span className="text-white/75">.mcworld</span>. Add-ons that need the script API also
              require “Enable scripting” in Settings.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
