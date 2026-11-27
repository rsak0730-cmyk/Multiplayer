'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  OctagonAlert,
  Loader2,
  TerminalSquare,
  FolderTree,
  Puzzle,
  DatabaseBackup,
  RefreshCw,
  Globe2,
  SlidersHorizontal,
  CheckCircle2,
  AlertCircle,
  Info,
  Trash2,
} from 'lucide-react';
import { StatusDot, statusToDot } from '@/components/ui/StatusDot';
import { Badge } from '@/components/ui/Badge';
import { ControlsPanel } from '@/components/servers/panels/ControlsPanel';
import { ConfigPanel } from '@/components/servers/panels/ConfigPanel';
import { ConsolePanel } from '@/components/servers/panels/ConsolePanel';
import { FilesPanel } from '@/components/servers/panels/FilesPanel';
import { AddonsPanel } from '@/components/servers/panels/AddonsPanel';
import { BackupsPanel } from '@/components/servers/panels/BackupsPanel';
import { VersionsPanel } from '@/components/servers/panels/VersionsPanel';
import { NetworkingPanel } from '@/components/servers/panels/NetworkingPanel';

export type TabKey =
  | 'controls'
  | 'config'
  | 'console'
  | 'files'
  | 'addons'
  | 'backups'
  | 'versions'
  | 'networking';

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'controls', label: 'Controls', icon: Play },
  { key: 'console', label: 'Console', icon: TerminalSquare },
  { key: 'config', label: 'Settings', icon: SlidersHorizontal },
  { key: 'files', label: 'Files', icon: FolderTree },
  { key: 'addons', label: 'Add-ons', icon: Puzzle },
  { key: 'backups', label: 'Backups', icon: DatabaseBackup },
  { key: 'versions', label: 'Versions', icon: RefreshCw },
  { key: 'networking', label: 'Networking', icon: Globe2 },
];

export interface ServerDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  node_id: string;
  world_name: string | null;
  minecraft_version: string | null;
  installed_version: string | null;
  available_version: string | null;
  max_players: number;
  online_players: number;
  port: number;
  network_provider: string;
  public_address: string | null;
  public_port: number | null;
  networking_verified: boolean;
  networking_verified_at: string | null;
  auto_update: boolean;
  auto_start_on_node_boot: boolean;
  last_error: string | null;
  last_started_at: string | null;
  last_stopped_at: string | null;
}

export interface NodeDetail {
  id: string;
  name: string;
  operating_system: string | null;
  agent_version: string | null;
  cpu_percent: number | null;
  ram_total_mb: number | null;
  ram_available_mb: number | null;
  storage_total_mb: number | null;
  storage_available_mb: number | null;
  last_seen_at: string | null;
  computed_status: string;
}

export function ServerDetailClient({
  server: initialServer,
  node: initialNode,
  config: initialConfig,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
  config: Record<string, unknown> | null;
}) {
  const searchParams = useSearchParams();
  const requestedTab = (searchParams.get('tab') as TabKey) ?? 'controls';
  const [tab, setTab] = useState<TabKey>(
    TABS.some((t) => t.key === requestedTab) ? requestedTab : 'controls',
  );
  const [server, setServer] = useState<ServerDetail>(initialServer);
  const [node, setNode] = useState<NodeDetail | null>(initialNode);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Keep server + node state live while this page is open.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/servers/${initialServer.id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setServer(json.server);
      setNode(json.node);
    } catch {
      /* transient */
    }
  }, [initialServer.id]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  async function onDelete() {
    setDeleting(true);
    const res = await fetch(`/api/servers/${server.id}`, { method: 'DELETE' });
    if (res.ok) {
      window.location.href = '/servers';
      return;
    }
    setDeleting(false);
    setConfirmDelete(false);
  }

  const running = server.status === 'running';
  const transitional = ['starting', 'stopping', 'installing', 'updating'].includes(server.status);

  return (
    <div className="fade-in flex flex-col gap-5">
      <Link href="/servers" className="btn-ghost w-fit !min-h-9 !px-3 !py-1.5 text-xs">
        <ArrowLeft className="h-3.5 w-3.5" /> All servers
      </Link>

      {/* Header */}
      <header className="glass p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-xl font-bold tracking-tight text-white sm:text-2xl">
                {server.name}
              </h1>
              <StatusDot kind={statusToDot(server.status)} label={server.status} />
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-white/45">
              {node ? (
                <>
                  Hosted on <span className="text-white/70">{node.name}</span> ·{' '}
                  {node.operating_system ?? 'Unknown OS'} ·{' '}
                  <span className={node.computed_status === 'online' ? 'text-emerald-300' : 'text-white/40'}>
                    {node.computed_status}
                  </span>
                </>
              ) : (
                'Hosting device not found'
              )}
            </p>
            {server.description ? (
              <p className="mt-1 text-xs text-white/35">{server.description}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={running ? 'green' : 'slate'}>
              {server.online_players}/{server.max_players} players
            </Badge>
            <Badge tone="violet">
              {server.installed_version ?? server.minecraft_version ?? 'BDS not installed'}
            </Badge>
            {running && server.networking_verified ? (
              <Badge tone="cyan">
                <CheckCircle2 className="h-3 w-3" /> verified reachable
              </Badge>
            ) : running ? (
              <Badge tone="amber">
                <AlertCircle className="h-3 w-3" /> networking unverified
              </Badge>
            ) : null}
          </div>
        </div>

        {server.last_error ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-400/25 bg-red-500/8 px-3.5 py-3 text-xs text-red-200/90">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Last error reported by the node</p>
              <p className="mt-0.5 leading-relaxed text-red-200/70">{server.last_error}</p>
            </div>
          </div>
        ) : null}

        {node && node.computed_status !== 'online' ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3.5 py-3 text-xs text-amber-100/90">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Hosting device is offline</p>
              <p className="mt-0.5 leading-relaxed text-amber-100/65">
                Start the OG HOST Agent on “{node.name}”. Commands are queued and run automatically
                when it reconnects, but nothing can start, stop or be read from disk until then.
              </p>
            </div>
          </div>
        ) : null}
      </header>

      {/* Quick controls */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <QuickAction
          icon={Play}
          label="Start"
          tone="primary"
          disabled={running || transitional}
          serverId={server.id}
          action="start"
          onDone={refresh}
        />
        <QuickAction
          icon={Square}
          label="Stop"
          tone="ghost"
          disabled={!running || transitional}
          serverId={server.id}
          action="stop"
          onDone={refresh}
        />
        <QuickAction
          icon={RotateCw}
          label="Restart"
          tone="ghost"
          disabled={!running || transitional}
          serverId={server.id}
          action="restart"
          onDone={refresh}
        />
        <QuickAction
          icon={OctagonAlert}
          label="Force stop"
          tone="danger"
          disabled={server.status === 'stopped' || transitional}
          serverId={server.id}
          action="force_stop"
          confirm
          onDone={refresh}
        />
      </div>

      {/* Tabs */}
      <div className="scrollbar-thin -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-1.5 rounded-2xl border border-white/8 bg-black/25 p-1.5">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-medium transition-all duration-200 ${
                tab === key
                  ? 'bg-gradient-to-br from-violet-600/35 to-cyan-500/15 text-white shadow-[0_8px_24px_-14px_rgba(139,92,246,1)]'
                  : 'text-white/50 hover:bg-white/5 hover:text-white/85'
              }`}
              style={{ minHeight: 44 }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div key={tab} className="fade-in">
        {tab === 'controls' ? (
          <ControlsPanel server={server} node={node} onChanged={refresh} />
        ) : null}
        {tab === 'config' ? (
          <ConfigPanel serverId={server.id} initialConfig={initialConfig} onChanged={refresh} />
        ) : null}
        {tab === 'console' ? <ConsolePanel server={server} node={node} /> : null}
        {tab === 'files' ? <FilesPanel server={server} node={node} /> : null}
        {tab === 'addons' ? <AddonsPanel server={server} node={node} /> : null}
        {tab === 'backups' ? <BackupsPanel server={server} node={node} /> : null}
        {tab === 'versions' ? <VersionsPanel server={server} node={node} onChanged={refresh} /> : null}
        {tab === 'networking' ? (
          <NetworkingPanel server={server} node={node} onChanged={refresh} />
        ) : null}
      </div>

      {/* Danger zone */}
      <section className="glass border-red-400/20 p-5">
        <h2 className="card-title mb-1 text-red-200/90">Delete server</h2>
        <p className="mb-4 text-xs leading-relaxed text-white/45">
          Removes this server from OG HOST and asks the node to delete its directory. World backups
          you downloaded are unaffected. This cannot be undone.
        </p>
        {confirmDelete ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className="btn-danger" disabled={deleting} onClick={onDelete}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Yes, delete “{server.name}”
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={deleting}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" /> Delete server
          </button>
        )}
      </section>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  tone,
  disabled,
  serverId,
  action,
  confirm,
  onDone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  serverId: string;
  action: string;
  confirm?: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const classes =
    tone === 'primary' ? 'btn-primary' : tone === 'danger' ? 'btn-danger' : 'btn-ghost';

  async function run() {
    if (confirm && !window.confirm(`${label} this server? This is immediate and not graceful.`)) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, force: action === 'force_stop' }),
      });
      const json = await res.json();
      if (!res.ok) setErrorText(json.error ?? 'Request failed');
      onDone();
    } catch {
      setErrorText('Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" className={`${classes} w-full`} disabled={disabled || busy} onClick={run}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
        {label}
      </button>
      {errorText ? <p className="text-[10px] leading-snug text-red-300/85">{errorText}</p> : null}
    </div>
  );
}
