'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  MonitorSmartphone,
  Info,
  Wand2,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';

interface NodeOption {
  id: string;
  name: string;
  operating_system: string | null;
  revoked: boolean;
  online: boolean;
  ram_available_mb: number | null;
  storage_available_mb: number | null;
}

const GAMEMODES = [
  { value: 'survival', label: 'Survival' },
  { value: 'creative', label: 'Creative' },
  { value: 'adventure', label: 'Adventure' },
];

const DIFFICULTIES = [
  { value: 'peaceful', label: 'Peaceful' },
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];

const PROVIDERS = [
  {
    value: 'direct',
    label: 'Direct',
    hint: 'Node must have a public IPv4 or port forwarding. Usually fails on Airtel/Jio/Vi mobile broadband (CGNAT).',
  },
  {
    value: 'playit',
    label: 'Playit tunnel',
    hint: 'UDP tunnel that can work behind CGNAT. Needs a free Playit secret configured on the device.',
  },
  {
    value: 'manual',
    label: 'Manual',
    hint: 'You provide the public address yourself (own VPS, router forward, other tunnel).',
  },
];

export function NewServerForm({
  nodes,
  latestVersion,
  versionDiscoveryFailed,
}: {
  nodes: NodeOption[];
  latestVersion: { version: string; channel: string } | null;
  versionDiscoveryFailed: boolean;
}) {
  const router = useRouter();
  const usableNodes = nodes.filter((n) => !n.revoked);

  const [form, setForm] = useState({
    name: '',
    node_id: usableNodes[0]?.id ?? '',
    world_name: 'world',
    description: '',
    max_players: 10,
    port: 19132,
    gamemode: 'survival',
    difficulty: 'easy',
    enable_cheats: true,
    pvp: true,
    network_provider: 'direct',
    auto_update: false,
    auto_start_on_node_boot: false,
  });
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const selectedNode = usableNodes.find((n) => n.id === form.node_id);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.node_id) {
      setErrorText('Choose which of your devices will host this server.');
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...form,
          minecraft_version: latestVersion?.version ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? 'Failed to create the server.');
        setBusy(false);
        return;
      }
      router.push(`/servers/${json.server.id}`);
      router.refresh();
    } catch {
      setErrorText('Network error. Please try again.');
      setBusy(false);
    }
  }

  if (nodes.length === 0) {
    return (
      <div className="fade-in flex flex-col gap-5">
        <BackLink />
        <div className="glass flex flex-col items-start gap-4 p-6">
          <div className="grid h-12 w-12 place-items-center rounded-2xl border border-violet-400/30 bg-violet-500/12 text-violet-200">
            <MonitorSmartphone className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Pair a device first</h1>
            <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-white/50">
              A Minecraft server has to live on one of your own Windows computers. OG HOST never
              pools resources between accounts, so there is nothing to host on until you connect a
              node. Pairing takes about two minutes.
            </p>
          </div>
          <Link href="/devices" className="btn-primary">
            Go to Devices
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in flex flex-col gap-5">
      <BackLink />

      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">My Servers</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Create a Bedrock server
        </h1>
        <p className="mt-1 text-xs text-white/45">
          The official Minecraft Bedrock Dedicated Server will be downloaded and installed on the
          device you pick. No version number is hard-coded — the latest stable build is discovered
          at install time.
        </p>
      </header>

      {versionDiscoveryFailed ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3.5 py-3 text-xs text-amber-100/90">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Latest version could not be discovered right now</p>
            <p className="mt-0.5 leading-relaxed text-amber-100/60">
              The server will still be created. Your Windows agent discovers and verifies the current
              official Bedrock Dedicated Server build locally before installing it.
            </p>
          </div>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        {/* Basics */}
        <section className="glass p-5">
          <h2 className="card-title mb-4">Basics</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">
                Server name
              </label>
              <input
                id="name"
                className="input"
                required
                maxLength={64}
                placeholder="My Survival World"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="world_name">
                World folder name
              </label>
              <input
                id="world_name"
                className="input"
                required
                maxLength={64}
                placeholder="world"
                value={form.world_name}
                onChange={(e) => update('world_name', e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="description">
                Description (optional)
              </label>
              <input
                id="description"
                className="input"
                maxLength={255}
                placeholder="Weekend server for friends"
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
              />
            </div>
          </div>
        </section>

        {/* Node */}
        <section className="glass p-5">
          <h2 className="card-title mb-1">Hosting device</h2>
          <p className="mb-4 text-xs text-white/45">
            Only your own devices are listed. Each one belongs exclusively to your account.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {usableNodes.map((node) => {
              const active = form.node_id === node.id;
              const lowRam =
                node.online && node.ram_available_mb !== null && node.ram_available_mb < 1024;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => update('node_id', node.id)}
                  className={`rounded-xl border p-3.5 text-left transition-all duration-200 ${
                    active
                      ? 'border-violet-400/50 bg-violet-500/12 shadow-[0_0_28px_-14px_rgba(139,92,246,1)]'
                      : 'border-white/8 bg-black/25 hover:border-white/20'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white/90">{node.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-white/40">
                        {node.operating_system ?? 'Unknown OS'}
                      </p>
                    </div>
                    <Badge tone={node.online ? 'green' : 'slate'}>
                      {node.online ? 'online' : 'offline'}
                    </Badge>
                  </div>
                  {node.online ? (
                    <p className="mt-2 text-[11px] text-white/45">
                      {node.ram_available_mb !== null
                        ? `${Math.round(node.ram_available_mb / 1024 * 10) / 10} GB RAM free`
                        : 'RAM unknown'}{' '}
                      ·{' '}
                      {node.storage_available_mb !== null
                        ? `${Math.round(node.storage_available_mb / 1024)} GB storage free`
                        : 'storage unknown'}
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-white/35">
                      Offline — you can still create the server; the install command waits for it to
                      reconnect.
                    </p>
                  )}
                  {lowRam ? (
                    <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-500/8 px-2 py-1.5 text-[11px] text-amber-100/85">
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      Less than 1 GB free. Bedrock Dedicated Server may fail to start.
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        {/* Gameplay */}
        <section className="glass p-5">
          <h2 className="card-title mb-4">Gameplay</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="label">Game mode</span>
              <div className="grid grid-cols-3 gap-2">
                {GAMEMODES.map((g) => (
                  <button
                    key={g.value}
                    type="button"
                    onClick={() => update('gamemode', g.value)}
                    className={`rounded-xl border px-2 py-2.5 text-xs font-medium transition-all ${
                      form.gamemode === g.value
                        ? 'border-violet-400/50 bg-violet-500/15 text-white'
                        : 'border-white/8 bg-black/25 text-white/55 hover:border-white/20'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label">Difficulty</span>
              <div className="grid grid-cols-4 gap-2">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => update('difficulty', d.value)}
                    className={`rounded-xl border px-1 py-2.5 text-[11px] font-medium transition-all ${
                      form.difficulty === d.value
                        ? 'border-cyan-400/50 bg-cyan-500/15 text-white'
                        : 'border-white/8 bg-black/25 text-white/55 hover:border-white/20'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label" htmlFor="max_players">
                Maximum players
              </label>
              <input
                id="max_players"
                type="number"
                min={1}
                max={100}
                className="input"
                value={form.max_players}
                onChange={(e) => update('max_players', Number(e.target.value))}
              />
              <p className="mt-1.5 text-[11px] text-white/35">
                10 is the design target for your hardware. Real capacity depends on the CPU and RAM
                actually available when the server runs.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="port">
                Server port
              </label>
              <input
                id="port"
                type="number"
                min={1024}
                max={65535}
                className="input"
                value={form.port}
                onChange={(e) => update('port', Number(e.target.value))}
              />
              <p className="mt-1.5 text-[11px] text-white/35">
                Bedrock uses UDP. 19132 is the standard port; change it only if another server on the
                same device already uses it.
              </p>
            </div>
          </div>

          <div className="divider" />

          <div className="flex flex-col gap-3">
            <Toggle
              checked={form.enable_cheats}
              onChange={(v) => update('enable_cheats', v)}
              label="Enable cheats"
              hint="Turns on scripting, command blocks and makes new players operators by default."
            />
            <Toggle
              checked={form.pvp}
              onChange={(v) => update('pvp', v)}
              label="Player vs player"
              hint="Allow players to damage each other."
            />
            <Toggle
              checked={form.auto_update}
              onChange={(v) => update('auto_update', v)}
              label="Automatic updates"
              hint="Off by default. Updates always back up the world first and never replace a running server."
            />
            <Toggle
              checked={form.auto_start_on_node_boot}
              onChange={(v) => update('auto_start_on_node_boot', v)}
              label="Auto-start this server when the device boots"
              hint="Off by default. The agent reconnects after a Windows restart but does not start Minecraft servers unless you enable this."
            />
          </div>
        </section>

        {/* Networking */}
        <section className="glass p-5">
          <h2 className="card-title mb-1">Multiplayer networking</h2>
          <p className="mb-4 text-xs text-white/45">
            You can change this later. OG HOST only reports an address as reachable after a real
            Bedrock protocol check succeeds — it never shows a guessed IP.
          </p>
          <div className="grid gap-2.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => update('network_provider', p.value as typeof form.network_provider)}
                className={`rounded-xl border p-3.5 text-left transition-all duration-200 ${
                  form.network_provider === p.value
                    ? 'border-cyan-400/45 bg-cyan-500/10'
                    : 'border-white/8 bg-black/25 hover:border-white/20'
                }`}
              >
                <p className="text-sm font-semibold text-white/90">{p.label}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/45">{p.hint}</p>
              </button>
            ))}
          </div>
        </section>

        {errorText ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3.5 py-3 text-xs text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorText}</span>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="submit" className="btn-primary flex-1" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {busy ? 'Creating server…' : 'Create server'}
          </button>
          <Link href="/servers" className="btn-ghost sm:w-auto">
            Cancel
          </Link>
        </div>

        {selectedNode && !selectedNode.online ? (
          <p className="text-center text-[11px] leading-relaxed text-white/35">
            “{selectedNode.name}” is offline. The server record is created now and the BDS install
            command runs automatically the moment the agent reconnects.
          </p>
        ) : null}
      </form>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/servers" className="btn-ghost w-fit !min-h-9 !px-3 !py-1.5 text-xs">
      <ArrowLeft className="h-3.5 w-3.5" /> Back to servers
    </Link>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-start justify-between gap-4 rounded-xl border border-white/8 bg-black/25 px-3.5 py-3 text-left transition-all hover:border-white/20"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white/85">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-white/40">{hint}</span>
        ) : null}
      </span>
      <span
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-all duration-300 ${
          checked
            ? 'border-violet-400/50 bg-violet-500/40 shadow-[0_0_18px_-4px_rgba(139,92,246,1)]'
            : 'border-white/12 bg-white/5'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all duration-300 ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
          style={{ height: 18, width: 18 }}
        />
      </span>
    </button>
  );
}
