'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  FolderTree,
  Folder,
  FileText,
  FolderPlus,
  Trash2,
  Download,
  Upload,
  RefreshCw,
  Loader2,
  AlertCircle,
  ArrowLeft,
  Save,
  Info,
  ShieldAlert,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size_bytes: number;
  modified_at: string | null;
}

const EDITABLE_EXTENSIONS = [
  '.json',
  '.txt',
  '.properties',
  '.yml',
  '.yaml',
  '.cfg',
  '.ini',
  '.mcfunction',
  '.lang',
];

function isEditable(name: string): boolean {
  const lower = name.toLowerCase();
  return EDITABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function FilesPanel({
  server,
  node,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
}) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; name: string; content: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const nodeOnline = node?.computed_status === 'online';

  /** Poll the queued command until the agent answers. */
  const waitForCommand = useCallback(
    async (commandId: string): Promise<Record<string, unknown> | null> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const res = await fetch(`/api/servers/${server.id}/commands/${commandId}`, {
            cache: 'no-store',
          });
          if (!res.ok) continue;
          const json = await res.json();
          const cmd = json.command;
          if (cmd.status === 'completed') return (cmd.result ?? {}) as Record<string, unknown>;
          if (cmd.status === 'failed' || cmd.status === 'cancelled') {
            throw new Error(cmd.error_message ?? 'The node reported a failure.');
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'The node reported a failure.') {
            // transient poll error — keep waiting
            continue;
          }
          throw e;
        }
      }
      throw new Error(
        'Timed out waiting for the device. Make sure the OG HOST Agent is running and connected.',
      );
    },
    [server.id],
  );

  const loadDir = useCallback(
    async (target: string) => {
      setPath(target);
      setLoading(true);
      setErrorText(null);
      try {
        const res = await fetch(
          `/api/servers/${server.id}/files?path=${encodeURIComponent(target)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error(j?.error ?? `Failed (${res.status})`);
        }
        const queued = await res.json();
        const result = await waitForCommand(queued.command_id as string);
        const list = (result?.entries ?? []) as FileEntry[];
        setEntries(list);
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : 'Failed to list files');
        setEntries(null);
      } finally {
        setLoading(false);
      }
    },
    [server.id, waitForCommand],
  );

  useEffect(() => {
    if (nodeOnline) void loadDir('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeOnline, server.id]);

  function parentOf(current: string): string {
    const parts = current.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  async function makeFolder() {
    const name = window.prompt('New folder name:');
    if (!name?.trim()) return;
    setBusy('mkdir');
    const target = path ? `${path}/${name.trim()}` : name.trim();
    try {
      const res = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'mkdir', path: target }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      await waitForCommand(json.command_id);
      setInfoText(`Folder “${name.trim()}” created.`);
      await loadDir(path);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to create folder');
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: FileEntry) {
    if (
      !window.confirm(
        `Delete ${entry.is_directory ? 'folder' : 'file'} “${entry.name}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(`del:${entry.path}`);
    try {
      const res = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'delete', path: entry.path }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      await waitForCommand(json.command_id);
      setInfoText(`Deleted “${entry.name}”.`);
      await loadDir(path);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusy(null);
    }
  }

  async function download(entry: FileEntry) {
    setBusy(`dl:${entry.path}`);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'download', path: entry.path }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      const result = await waitForCommand(json.command_id);
      const url = result?.download_url as string | undefined;
      if (!url) throw new Error('The node did not return a download link.');
      window.open(url, '_blank', 'noopener,noreferrer');
      setInfoText(`Download link for “${entry.name}” opened (valid 15 minutes).`);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to download');
    } finally {
      setBusy(null);
    }
  }

  async function openEditor(entry: FileEntry) {
    setBusy(`edit:${entry.path}`);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'download', path: entry.path, as_text: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      const result = await waitForCommand(json.command_id);
      const content = result?.content as string | undefined;
      if (content === undefined) throw new Error('The node did not return the file contents.');
      setEditing({ path: entry.path, name: entry.name, content });
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to open file');
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy('save');
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'edit', path: editing.path, content: editing.content }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      await waitForCommand(json.command_id);
      setInfoText(`Saved “${editing.name}” on the device.`);
      setEditing(null);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(null);
    }
  }

  async function uploadFile(file: File) {
    setUploading(true);
    setErrorText(null);
    try {
      // 1. Register the upload and get a signed storage URL.
      const res = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'upload_intent', path: path, file_name: file.name, size_bytes: file.size }),
      });
      const intent = await res.json();
      if (!res.ok) throw new Error(intent.error ?? 'Failed to start upload');

      // 2. Upload bytes straight to Supabase Storage (bypasses function limits).
      const put = await fetch(intent.signed_upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      if (!put.ok) throw new Error('Upload to storage failed.');

      // 3. Ask the node to pull it into the server directory.
      const start = await fetch(`/api/servers/${server.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'upload_commit',
          path: path ? `${path}/${file.name}` : file.name,
          storage_path: intent.storage_path,
        }),
      });
      const startJson = await start.json();
      if (!start.ok) throw new Error(startJson.error ?? 'Failed to queue the transfer');
      await waitForCommand(startJson.command_id);
      setInfoText(`Uploaded “${file.name}”.`);
      await loadDir(path);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  if (!nodeOnline) {
    return (
      <Card>
        <CardHeader icon={<FolderTree className="h-[18px] w-[18px]" />} title="File manager" />
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3.5 py-3 text-xs leading-relaxed text-amber-100/85">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Device offline</p>
            <p className="mt-0.5 text-amber-100/65">
              Files live on your Windows computer, so the file manager needs the agent to be
              connected. Start the OG HOST Agent on “{node?.name ?? 'this device'}” and this view
              will load automatically.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={<FolderTree className="h-[18px] w-[18px]" />}
          title="File manager"
          subtitle={path ? `/${path}` : 'Server root directory'}
          right={<Badge tone={nodeOnline ? 'green' : 'slate'}>node {node?.computed_status}</Badge>}
        />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {path ? (
            <button
              type="button"
              className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
              onClick={() => loadDir(parentOf(path))}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Up
            </button>
          ) : null}
          <button
            type="button"
            className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
            onClick={() => loadDir(path)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
          <button
            type="button"
            className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
            onClick={makeFolder}
            disabled={busy === 'mkdir'}
          >
            <FolderPlus className="h-3.5 w-3.5" /> New folder
          </button>
          <label className="btn-ghost !min-h-9 cursor-pointer !px-3 !py-1.5 text-xs">
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {errorText ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-red-100/90">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{errorText}</span>
          </div>
        ) : null}
        {infoText ? (
          <div className="mb-3 rounded-xl border border-emerald-400/25 bg-emerald-500/8 px-3 py-2.5 text-[11px] text-emerald-100/90">
            {infoText}
          </div>
        ) : null}

        {loading && entries === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton h-12 w-full" />
            ))}
          </div>
        ) : entries === null ? (
          <p className="text-xs text-white/45">Nothing loaded yet.</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-white/45">This folder is empty.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {[...entries]
              .sort((a, b) =>
                a.is_directory === b.is_directory
                  ? a.name.localeCompare(b.name)
                  : a.is_directory
                    ? -1
                    : 1,
              )
              .map((entry) => (
                <li
                  key={entry.path}
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-black/25 px-3 py-2.5"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    onClick={() => {
                      if (entry.is_directory) void loadDir(entry.path);
                      else if (isEditable(entry.name)) void openEditor(entry);
                      else void download(entry);
                    }}
                  >
                    {entry.is_directory ? (
                      <Folder className="h-4 w-4 shrink-0 text-violet-300" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-cyan-300" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-white/85">
                        {entry.name}
                      </span>
                      <span className="block text-[10px] text-white/35">
                        {entry.is_directory
                          ? 'folder'
                          : `${formatSize(entry.size_bytes)}${isEditable(entry.name) ? ' · editable' : ''}`}
                      </span>
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    {!entry.is_directory ? (
                      <button
                        type="button"
                        className="btn-ghost !min-h-9 !px-2.5 !py-1.5"
                        title="Download"
                        disabled={busy === `dl:${entry.path}`}
                        onClick={() => download(entry)}
                      >
                        {busy === `dl:${entry.path}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-danger !min-h-9 !px-2.5 !py-1.5"
                      title="Delete"
                      disabled={busy === `del:${entry.path}`}
                      onClick={() => remove(entry)}
                    >
                      {busy === `del:${entry.path}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}

        <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[11px] leading-relaxed text-white/50">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Every path is validated on both sides and confined to this server’s directory. Bedrock
            system files (bedrock_server.exe, allowlist.json, permissions.json,
            valid_known_packs.json) are protected from editing and deletion. Large uploads go
            directly to storage and are pulled down by your device, so nothing is limited by the web
            function’s body size.
          </span>
        </div>
      </Card>

      {editing ? (
        <Card>
          <CardHeader
            icon={<FileText className="h-[18px] w-[18px]" />}
            title={`Editing ${editing.name}`}
            subtitle={editing.path}
            right={
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
                  onClick={() => setEditing(null)}
                  disabled={busy === 'save'}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary !min-h-9 !px-3 !py-1.5 text-xs"
                  onClick={saveEdit}
                  disabled={busy === 'save'}
                >
                  {busy === 'save' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </button>
              </div>
            }
          />
          <textarea
            className="console-surface scrollbar-thin h-[46vh] w-full rounded-xl p-3 text-[12px] text-emerald-100/85 outline-none"
            value={editing.content}
            spellCheck={false}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          />
          <p className="mt-2 text-[11px] text-white/40">
            Saving writes the file back on your device. Invalid JSON in files like permissions.json
            can stop the server from starting — a backup first is always sensible.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
