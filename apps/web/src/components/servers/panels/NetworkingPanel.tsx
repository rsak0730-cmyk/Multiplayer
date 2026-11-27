'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Globe2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Info,
  ShieldAlert,
  Copy,
  Play,
  Square,
  KeyRound,
  WifiOff,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

interface EndpointRow {
  id: string;
  provider: string;
  address: string | null;
  port: number | null;
  status: string;
  verified: boolean;
  verified_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const PROVIDERS = [
  {
    value: 'direct',
    label: 'Direct connection',
    hint: 'Uses the device’s own public address and port. Works when your ISP gives you a public IPv4 or you have set up port forwarding.',
    cgnat: 'Usually fails behind CGNAT (common on Airtel, Jio and Vi mobile broadband).',
  },
  {
    value: 'playit',
    label: 'Playit.gg UDP tunnel',
    hint: 'Outbound UDP tunnel that can work behind CGNAT. Bedrock uses UDP, so this is the realistic free option for mobile networks.',
    cgnat: 'Designed to work behind CGNAT.',
  },
  {
    value: 'manual',
    label: 'Manual endpoint',
    hint: 'You supply the public address and port yourself — your own VPS relay, router forwarding, or another tunnel you already run.',
    cgnat: 'Depends entirely on what you point it at.',
  },
] as const;

export function NetworkingPanel({
  server,
  node,
  onChanged,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
  onChanged: () => void;
}) {
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);
  const [active, setActive] = useState<EndpointRow | null>(null);
  const [provider, setProvider] = useState<string>(server.network_provider);
  const [manualAddress, setManualAddress] = useState('');
  const [manualPort, setManualPort] = useState<number>(server.port);
  const [playitSecret, setPlayitSecret] = useState('');
  const [nodeSettings, setNodeSettings] = useState<{
    playit_agent_installed: boolean;
    playit_tunnel_id: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodeOnline = node?.computed_status === 'online';
  const running = server.status === 'running';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/servers/${server.id}/networking`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setEndpoints(json.endpoints ?? []);
      setActive(json.active_endpoint ?? null);
      setNodeSettings(json.node_settings ?? null);
      if (json.server_provider) setProvider(json.server_provider);
    } catch {
      /* transient */
    }
  }, [server.id]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 6000);
    return () => clearInterval(id);
  }, [load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/servers/${server.id}/networking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Request failed');
    return json;
  }

  async function waitForCommand(commandId: string): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
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
    throw new Error('Timed out waiting for the tunnel to report back.');
  }

  async function setProviderAction(value: string) {
    setBusy('provider');
    setErrorText(null);
    setInfoText(null);
    try {
      const json = await post({ action: 'set_provider', provider: value });
      setProvider(value);
      setInfoText(json.message ?? 'Provider updated.');
      await load();
      onChanged();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  async function startTunnel() {
    setBusy('start');
    setErrorText(null);
    setInfoText(null);
    try {
      const json = await post({ action: 'start' });
      setInfoText(json.message ?? 'Networking start queued.');
      await waitForCommand(json.command_id);
      await load();
      onChanged();
      setInfoText(
        active?.verified
          ? 'Connectivity verified with a real Bedrock protocol round trip. This address is shareable.'
          : 'Tunnel established. The address is shown as UNVERIFIED until a real Bedrock client (or RakNet ping) confirms it — join once from your phone to complete verification.',
      );
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to start networking');
    } finally {
      setBusy(null);
    }
  }

  async function stopTunnel() {
    setBusy('stop');
    setErrorText(null);
    try {
      const json = await post({ action: 'stop' });
      if (json.command_id) await waitForCommand(json.command_id);
      await load();
      onChanged();
      setInfoText('Networking stopped.');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to stop networking');
    } finally {
      setBusy(null);
    }
  }

  async function saveManual() {
    setBusy('manual');
    setErrorText(null);
    setInfoText(null);
    try {
      const json = await post({
        action: 'set_manual',
        address: manualAddress,
        port: manualPort,
      });
      setInfoText(json.message ?? 'Saved.');
      await load();
      onChanged();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(null);
    }
  }

  async function savePlayitSecret() {
    setBusy('secret');
    setErrorText(null);
    setInfoText(null);
    try {
      const json = await post({ action: 'save_node_settings', playit_secret: playitSecret });
      setPlayitSecret('');
      setInfoText(json.message ?? 'Saved.');
      await load();
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(null);
    }
  }

  function copyAddress() {
    if (!active?.address) return;
    const text = `${active.address}:${active.port ?? server.port}`;
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const verified = Boolean(active?.verified);
  const shareable = verified && active?.address ? `${active.address}:${active.port ?? ''}` : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Share card */}
      <Card
        className={
          verified
            ? 'border-emerald-400/30 shadow-[0_0_40px_-20px_rgba(52,211,153,0.8)]'
            : undefined
        }
      >
        <CardHeader
          icon={<Globe2 className="h-[18px] w-[18px]" />}
          title="Multiplayer connection"
          subtitle="What your friends type into Minecraft Bedrock"
          right={
            <Badge tone={verified ? 'green' : active?.address ? 'amber' : 'slate'}>
              {verified ? 'verified reachable' : active?.address ? 'unverified' : 'not established'}
            </Badge>
          }
        />

        {shareable ? (
          <div className="rounded-2xl border border-emerald-400/25 bg-emerald-500/8 p-4">
            <p className="text-[10px] uppercase tracking-wider text-emerald-200/60">
              Server address
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <p className="font-mono text-lg font-bold text-white sm:text-xl">{shareable}</p>
              <button type="button" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs" onClick={copyAddress}>
                {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-emerald-100/70">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Verified by a real Bedrock protocol round trip at{' '}
              {active?.verified_at ? new Date(active.verified_at).toLocaleString() : '—'}. Friends can
              add this as an external server in Minecraft Bedrock.
            </p>
          </div>
        ) : active?.address ? (
          <div className="rounded-2xl border border-amber-400/25 bg-amber-500/8 p-4">
            <p className="text-[10px] uppercase tracking-wider text-amber-200/60">
              Reported address — NOT verified yet
            </p>
            <p className="mt-1.5 font-mono text-lg font-bold text-white/90">
              {active.address}:{active.port ?? server.port}
            </p>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-100/70">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The tunnel reported this address, but no Bedrock protocol round trip has succeeded
              yet. Test it by joining once from Minecraft on your phone. OG HOST will not label it
              reachable until that check genuinely passes.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-white/50">
              <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              No public address is known yet. Choose a provider below, start the Minecraft server,
              then start networking. Until a real check passes, no address is shown — OG HOST never
              invents one.
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary !min-h-10 !px-3.5 !py-2 text-xs"
            disabled={busy !== null || !nodeOnline || !running}
            onClick={startTunnel}
          >
            {busy === 'start' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Start networking
          </button>
          <button
            type="button"
            className="btn-ghost !min-h-10 !px-3.5 !py-2 text-xs"
            disabled={busy !== null || !nodeOnline}
            onClick={stopTunnel}
          >
            {busy === 'stop' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            Stop networking
          </button>
        </div>

        {!running ? (
          <p className="mt-3 text-[11px] text-white/40">
            Start the Minecraft server first — the tunnel is established against a live Bedrock
            process so the connectivity check is real.
          </p>
        ) : null}
        {!nodeOnline ? (
          <p className="mt-3 text-[11px] text-amber-200/80">
            “{node?.name ?? 'Your device'}” is offline. Networking runs on that device, so the agent
            must be connected.
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

      {/* Provider selection */}
      <Card>
        <CardHeader
          icon={<Globe2 className="h-[18px] w-[18px]" />}
          title="Networking provider"
          subtitle="Pluggable by design — swap providers without changing anything else"
        />
        <div className="grid gap-2.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.value}
              type="button"
              disabled={busy === 'provider'}
              onClick={() => setProviderAction(p.value)}
              className={`rounded-xl border p-3.5 text-left transition-all duration-200 ${
                provider === p.value
                  ? 'border-cyan-400/45 bg-cyan-500/10'
                  : 'border-white/8 bg-black/25 hover:border-white/20'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white/90">{p.label}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">{p.hint}</p>
                  <p className="mt-1.5 text-[10px] text-white/35">CGNAT: {p.cgnat}</p>
                </div>
                {provider === p.value ? (
                  <Badge tone="cyan" className="shrink-0">
                    selected
                  </Badge>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* Playit secret */}
      {provider === 'playit' ? (
        <Card>
          <CardHeader
            icon={<KeyRound className="h-[18px] w-[18px]" />}
            title="Playit tunnel secret"
            subtitle={`Stored on this device’s record${
              nodeSettings?.playit_tunnel_id ? ` · tunnel ${nodeSettings.playit_tunnel_id}` : ''
            }`}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input font-mono !text-xs"
              type="password"
              placeholder="Paste your Playit secret key"
              value={playitSecret}
              onChange={(e) => setPlayitSecret(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary shrink-0"
              disabled={busy === 'secret' || !playitSecret.trim()}
              onClick={savePlayitSecret}
            >
              {busy === 'secret' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save secret
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            Create a free account at playit.gg, add a UDP tunnel pointing at port {server.port} on
            this device, and copy the secret here. The agent uses it to open the outbound tunnel.
            Playit’s free tier has limits and third-party availability can change — see
            docs/NETWORKING.md for what has and has not been verified with a real Bedrock client.
          </p>
        </Card>
      ) : null}

      {/* Manual endpoint */}
      {provider === 'manual' ? (
        <Card>
          <CardHeader
            icon={<Globe2 className="h-[18px] w-[18px]" />}
            title="Manual endpoint"
            subtitle="Provide the public address yourself"
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]">
            <div>
              <span className="label">Public address or hostname</span>
              <input
                className="input"
                placeholder="play.example.com or 203.0.113.45"
                value={manualAddress}
                onChange={(e) => setManualAddress(e.target.value)}
              />
            </div>
            <div>
              <span className="label">Port</span>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={manualPort}
                onChange={(e) => setManualPort(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy === 'manual' || !manualAddress.trim()}
                onClick={saveManual}
              >
                {busy === 'manual' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            Private and loopback ranges are rejected. The endpoint is stored as UNVERIFIED and only
            becomes verified after a genuine Bedrock protocol round trip succeeds.
          </p>
        </Card>
      ) : null}

      {/* Endpoint history */}
      <Card>
        <CardHeader icon={<Info className="h-[18px] w-[18px]" />} title="Endpoint history" />
        {endpoints.length === 0 ? (
          <p className="text-xs text-white/45">No networking attempts recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {endpoints.slice(0, 12).map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-1.5 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-white/85">
                    {e.address ? `${e.address}:${e.port ?? ''}` : 'no address reported'}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-white/35">
                    {e.provider} · {new Date(e.created_at).toLocaleString()}
                    {e.notes ? ` · ${e.notes}` : ''}
                  </p>
                </div>
                <Badge
                  tone={
                    e.verified ? 'green' : e.status === 'failed' ? 'red' : e.status === 'active' ? 'amber' : 'slate'
                  }
                >
                  {e.verified ? 'verified' : e.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[11px] leading-relaxed text-white/50">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <p className="font-medium text-white/70">Why this page can look “unfinished”</p>
            <p className="mt-1">
              Bedrock gameplay is UDP with a specific RakNet protocol. An HTTPS tunnel cannot carry
              it, and a web function cannot reliably open UDP sockets to arbitrary hosts. So the
              verification round trip is performed by the agent on your device and reported back.
              Until that succeeds, OG HOST labels the address unverified rather than claiming your
              friends can join.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
