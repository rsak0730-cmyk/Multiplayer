'use client';

import { Server, MonitorSmartphone, Users, PlayCircle, TriangleAlert } from 'lucide-react';

interface Totals {
  servers: number;
  nodes: number;
  nodes_online: number;
  servers_running: number;
  online_players: number;
  online_players_verified_networking: number;
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'violet',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'violet' | 'cyan' | 'green' | 'amber';
}) {
  const tones = {
    violet: 'from-violet-600/25 to-violet-500/5 text-violet-200 border-violet-400/25',
    cyan: 'from-cyan-500/25 to-cyan-400/5 text-cyan-200 border-cyan-400/25',
    green: 'from-emerald-500/25 to-emerald-400/5 text-emerald-200 border-emerald-400/25',
    amber: 'from-amber-500/25 to-amber-400/5 text-amber-200 border-amber-400/25',
  } as const;
  return (
    <div className="glass glass-hover p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-white/40">{label}</p>
          <p className="mt-1.5 text-2xl font-bold leading-none text-white sm:text-3xl">{value}</p>
          {hint ? <p className="mt-2 text-[11px] leading-snug text-white/40">{hint}</p> : null}
        </div>
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border bg-gradient-to-br ${tones[tone]}`}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
      </div>
    </div>
  );
}

export function StatGrid({ totals }: { totals: Totals }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        icon={Server}
        label="Servers"
        value={totals.servers}
        tone="violet"
        hint={`${totals.servers_running} running right now`}
      />
      <Stat
        icon={MonitorSmartphone}
        label="Devices"
        value={totals.nodes}
        tone="cyan"
        hint={`${totals.nodes_online} online · ${totals.nodes - totals.nodes_online} offline`}
      />
      <Stat
        icon={PlayCircle}
        label="Running"
        value={totals.servers_running}
        tone="green"
        hint="Bedrock processes alive on your nodes"
      />
      <Stat
        icon={Users}
        label="Players"
        value={totals.online_players}
        tone="amber"
        hint={`${totals.online_players_verified_networking} on servers with verified public networking`}
      />
    </div>
  );
}

export function VersionWarning({ failed }: { failed: boolean }) {
  if (!failed) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/8 px-3.5 py-3 text-xs text-amber-100/90">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">Latest Bedrock server version is unknown</p>
        <p className="mt-0.5 leading-relaxed text-amber-100/60">
          The official download page could not be reached from this deployment, so no version is
          shown rather than a guessed one. Your node discovers and verifies the version locally when
          it installs or updates.
        </p>
      </div>
    </div>
  );
}
