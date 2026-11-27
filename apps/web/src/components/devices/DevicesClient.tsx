'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  MonitorSmartphone,
  Plus,
  Loader2,
  Copy,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  Trash2,
  Pencil,
  RotateCcw,
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
  Info,
  Download,
  TerminalSquare,
} from 'lucide-react';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Meter } from '@/components/ui/Meter';
import { StatusDot, statusToDot } from '@/components/ui/StatusDot';

interface NodeRow {
  id: string;
  name: string;
  hostname: string | null;
  operating_system: string | null;
  agent_version: string | null;
  status: string;
  cpu_percent: number | null;
  ram_total_mb: number | null;
  ram_available_mb: number | null;
  storage_total_mb: number | null;
  storage_available_mb: number | null;
  uptime_seconds: number | null;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
  computed_status: string;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function DevicesClient({ initialNodes }: { initialNodes: NodeRow[] }) {
  const [nodes, setNodes] = useState<NodeRow[]>(initialNodes);
  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<{
    code: string;
    expires_at: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenFor, setTokenFor] = useState<{ id: string; token: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/nodes', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setNodes(json.nodes ?? []);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 8000);
    return () => clearInterval(id);
  }, [load]);

  // Expire the displayed pairing code when its TTL passes.
  useEffect(() => {
    if (!pairResult) return;
    const expiresAt = new Date(pairResult.expires_at).getTime();
    const id = setInterval(() => {
      if (Date.now() > expiresAt) {
        setPairResult(null);
        setErrorText('That pairing code expired. Generate a new one.');
      }
    }, 1000);
    return () => clearInterval(id);
  }, [pairResult]);

  async function generatePairingCode() {
    setPairing(true);
    setErrorText(null);
    setInfoText(null);
    setPairResult(null);
    try {
      const res = await fetch('/api/nodes', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to create a pairing code');
      setPairResult({ code: json.code, expires_at: json.expires_at });
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed');
    } finally {
      setPairing(false);
    }
  }

  function copyCode() {
    if (!pairResult) return;
    void navigator.clipboard?.writeText(pairResult.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function rename(node: NodeRow) {
    const name = window.prompt('New device name:', node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    setBusyId(node.id);
    setErrorText(null);
    try {
      const res = await fetch(`/api/nodes/${node.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? 'Failed to rename');
      }
      setInfoText(`Renamed to “${name.trim()}”.`);
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusyId(null);
    }
  }

  async function rotateToken(node: NodeRow) {
    if (
      !window.confirm(
        `Issue a new agent token for “${node.name}”? The current token stops working immediately, so you must paste the new one into the agent config on that computer.`,
      )
    ) {
      return;
    }
    setBusyId(node.id);
    setErrorText(null);
    try {
      const res = await fetch(`/api/nodes/${node.id}/rotate-token`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to rotate the token');
      setTokenFor({ id: node.id, token: json.token });
      setInfoText('New token generated. Copy it into the agent config now — it is shown only once.');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(node: NodeRow) {
    if (
      !window.confirm(
        `Disconnect “${node.name}”? Its credentials are revoked and it can no longer reach OG HOST. You will need to pair it again with a new code.`,
      )
    ) {
      return;
    }
    setBusyId(node.id);
    setErrorText(null);
    try {
      const res = await fetch(`/api/nodes/${node.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? 'Failed to disconnect');
      }
      setInfoText(`“${node.name}” disconnected and its credentials revoked.`);
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fade-in flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Devices</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Your hosting nodes
          </h1>
          <p className="mt-1 text-xs text-white/45">
            {nodes.filter((n) => n.computed_status === 'online').length} of {nodes.length} online ·
            each device belongs exclusively to your account and is never shared
          </p>
        </div>
        <button
          type="button"
          className="btn-primary w-full sm:w-auto"
          disabled={pairing}
          onClick={generatePairingCode}
        >
          {pairing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Pair a device
        </button>
      </header>

      {errorText ? (
        <div className="glass flex items-start gap-2.5 border-red-400/25 px-4 py-3 text-xs leading-relaxed text-red-100/90">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorText}</span>
        </div>
      ) : null}
      {infoText ? (
        <div className="glass flex items-start gap-2.5 border-emerald-400/25 px-4 py-3 text-xs leading-relaxed text-emerald-100/90">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{infoText}</span>
        </div>
      ) : null}

      {pairResult ? (
        <Card className="border-violet-400/35 shadow-[0_0_50px_-24px_rgba(139,92,246,1)]">
          <CardHeader
            icon={<KeyRound className="h-[18px] w-[18px]" />}
            title="Pairing code"
            subtitle={`Expires ${new Date(pairResult.expires_at).toLocaleTimeString()} · single use`}
            right={
              <button type="button" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs" onClick={copyCode}>
                {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            }
          />
          <p className="select-all rounded-2xl border border-violet-400/25 bg-black/40 px-4 py-4 text-center font-mono text-2xl font-bold tracking-[0.18em] text-white sm:text-3xl">
            {pairResult.code}
          </p>

          <ol className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              ['Download the agent', 'Get the latest OG HOST Agent build for Windows from this repository’s Releases, or build it with the GitHub Actions workflow.'],
              ['Run it on the device', 'Unzip anywhere on the Windows PC (for example C:\\OGHOST) and run OGHost.Agent.exe once to create its config file.'],
              ['Enter this code', 'Open config.json, paste the code into pairingCode, and save. Restart the agent.'],
              ['It appears here', 'The device registers itself to your account and shows up below within seconds. No inbound ports or firewall rules are needed.'],
            ].map(([step, body], i) => (
              <li key={step} className="flex gap-3 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-violet-400/30 bg-violet-500/12 text-[11px] font-bold text-violet-200">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white/85">{step}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">{body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-3 text-[11px] leading-relaxed text-white/40">
            Only a hash of this code is stored. It works for 10 minutes, can be claimed once, and is
            invalidated after 5 wrong attempts.
          </p>
        </Card>
      ) : null}

      {tokenFor ? (
        <Card className="border-cyan-400/30">
          <CardHeader
            icon={<KeyRound className="h-[18px] w-[18px]" />}
            title="New agent token"
            subtitle="Shown once — paste it into config.json on that device"
            right={
              <button
                type="button"
                className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
                onClick={() => {
                  void navigator.clipboard?.writeText(tokenFor.token);
                }}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </button>
            }
          />
          <p className="break-all rounded-xl border border-cyan-400/25 bg-black/40 px-3.5 py-3 font-mono text-[11px] text-cyan-100/90">
            {tokenFor.token}
          </p>
          <button type="button" className="btn-ghost mt-3" onClick={() => setTokenFor(null)}>
            Done
          </button>
        </Card>
      ) : null}

      {nodes.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone className="h-6 w-6" />}
          title="No devices connected"
          description="Pair your Windows computer to start hosting. The agent connects outbound only, so it works behind NAT and CGNAT with no router configuration."
          action={
            <button type="button" className="btn-primary" disabled={pairing} onClick={generatePairingCode}>
              {pairing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Generate a pairing code
            </button>
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {nodes.map((node) => {
            const online = node.computed_status === 'online';
            const ramUsedPct =
              online && node.ram_total_mb && node.ram_available_mb !== null
                ? ((node.ram_total_mb - node.ram_available_mb) / node.ram_total_mb) * 100
                : null;
            const storageUsedPct =
              online && node.storage_total_mb && node.storage_available_mb !== null
                ? ((node.storage_total_mb - node.storage_available_mb) / node.storage_total_mb) * 100
                : null;
            return (
              <Card key={node.id} hover className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-white/90">{node.name}</p>
                    <p className="mt-1 truncate text-[11px] text-white/40">
                      {node.hostname ? `${node.hostname} · ` : ''}
                      {node.operating_system ?? 'Unknown OS'} · agent{' '}
                      {node.agent_version ?? 'n/a'}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-[10px] text-white/30">
                      <Clock className="h-3 w-3" /> last seen {timeAgo(node.last_seen_at)} · uptime{' '}
                      {online ? formatUptime(node.uptime_seconds) : 'unknown'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <StatusDot
                      kind={statusToDot(node.computed_status)}
                      label={node.computed_status}
                    />
                    <Badge tone={node.revoked_at ? 'red' : online ? 'green' : 'slate'}>
                      {node.revoked_at ? 'revoked' : online ? 'connected' : 'offline'}
                    </Badge>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Meter
                    value={online ? node.cpu_percent : null}
                    label="CPU"
                    detail={online ? `${(node.cpu_percent ?? 0).toFixed(0)}%` : 'offline'}
                  />
                  <Meter
                    value={ramUsedPct}
                    label="RAM"
                    detail={
                      node.ram_total_mb
                        ? `${Math.round((node.ram_available_mb ?? 0) / 1024 * 10) / 10}/${Math.round(node.ram_total_mb / 1024 * 10) / 10} GB free`
                        : 'unknown'
                    }
                  />
                  <Meter
                    value={storageUsedPct}
                    label="Storage"
                    detail={
                      node.storage_total_mb
                        ? `${Math.round((node.storage_available_mb ?? 0) / 1024)} GB free`
                        : 'unknown'
                    }
                  />
                </div>

                {!online && !node.revoked_at ? (
                  <p className="flex items-start gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-[11px] leading-relaxed text-white/45">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" />
                    Offline. Metrics show the last report before disconnect; nothing new can be read
                    until the agent reconnects. It retries automatically, including after a Windows
                    restart.
                  </p>
                ) : null}

                {online && node.ram_available_mb !== null && node.ram_available_mb < 1024 ? (
                  <p className="flex items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2.5 py-2 text-[11px] text-amber-100/85">
                    <MemoryStick className="mt-0.5 h-3 w-3 shrink-0" />
                    Only {node.ram_available_mb} MB free — below the ~1 GB Bedrock Dedicated Server
                    needs.
                  </p>
                ) : null}

                <div className="mt-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost !min-h-9 flex-1 !px-3 !py-1.5 text-xs"
                    disabled={busyId === node.id || Boolean(node.revoked_at)}
                    onClick={() => rename(node)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Rename
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !min-h-9 flex-1 !px-3 !py-1.5 text-xs"
                    disabled={busyId === node.id || Boolean(node.revoked_at)}
                    onClick={() => rotateToken(node)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> New token
                  </button>
                  <button
                    type="button"
                    className="btn-danger !min-h-9 flex-1 !px-3 !py-1.5 text-xs"
                    disabled={busyId === node.id || Boolean(node.revoked_at)}
                    onClick={() => revoke(node)}
                  >
                    {busyId === node.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Disconnect
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader
          icon={<Download className="h-[18px] w-[18px]" />}
          title="Installing the agent on Windows"
          subtitle="One-time setup, then it runs itself"
        />
        <ol className="grid gap-2.5 text-[11px] leading-relaxed text-white/50 sm:grid-cols-2">
          {[
            'Download the latest og-host-windows-agent.zip from this repository’s GitHub Releases (built automatically by the windows-agent workflow).',
            'Unzip it to a folder such as C:\\OGHOST. Keep the folder — it stores the server files and backups.',
            'Run OGHost.Agent.exe once. It creates config.json next to itself and exits with instructions.',
            'Open config.json, set controlPlaneUrl to your Vercel domain and paste your pairing code, then save.',
            'Run OGHost.Agent.exe again. It pairs, then keeps reporting in the background.',
            'Optional: install it as a Windows service so it survives restarts — services\\install-service.ps1 does this for you.',
          ].map((step, i) => (
            <li key={i} className="flex gap-2.5 rounded-xl border border-white/8 bg-black/25 px-3 py-2.5">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-cyan-400/30 bg-cyan-500/12 text-[10px] font-bold text-cyan-200">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-white/40">
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" />
          <span>
            The agent only ever makes outbound HTTPS requests to your control plane. It needs no
            inbound ports, no firewall rules and no router configuration, which is why it works on
            CGNAT connections such as Airtel, Jio and Vi mobile broadband.
          </span>
        </p>
      </Card>
    </div>
  );
}
