import Link from 'next/link';
import {
  Blocks,
  MonitorSmartphone,
  Smartphone,
  ShieldCheck,
  Gauge,
  Globe2,
  ArrowRight,
  TerminalSquare,
  DatabaseBackup,
  RefreshCw,
} from 'lucide-react';

const FEATURES = [
  {
    icon: MonitorSmartphone,
    title: 'Your PC is the server',
    body: 'Install the OG HOST Agent on Windows. It registers as your private node and does the actual Bedrock Dedicated Server hosting.',
  },
  {
    icon: Smartphone,
    title: 'Control from your phone',
    body: 'Start, stop, configure, back up and watch the console from Android or anywhere else. No need to touch the laptop.',
  },
  {
    icon: ShieldCheck,
    title: 'Private nodes, never shared',
    body: 'Anyone can register, but nobody can ever use another account\u2019s CPU, RAM or storage. Row Level Security enforces ownership.',
  },
  {
    icon: Globe2,
    title: 'Pluggable networking',
    body: 'Direct, Playit UDP tunnel, or a manual endpoint you provide. Addresses are only shown as reachable after a real protocol check.',
  },
  {
    icon: RefreshCw,
    title: 'Version manager that never ages',
    body: 'The latest official Bedrock server build is discovered at runtime. Update, keep history, and roll back if a start fails.',
  },
  {
    icon: DatabaseBackup,
    title: 'Consistent world backups',
    body: 'Manual or scheduled, with safe stopping so the world snapshot is never corrupted. Restore in one tap.',
  },
  {
    icon: TerminalSquare,
    title: 'Real console, allowlisted only',
    body: 'Live BDS output and official Bedrock console commands. There is no remote shell \u2014 by design.',
  },
  {
    icon: Gauge,
    title: 'Built for weak hardware',
    body: 'RAM, CPU and storage checks before every start, conservative defaults, and clear warnings on a 6 GB machine.',
  },
];

export default function LandingPage() {
  return (
    <div className="relative min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl border border-violet-400/30 bg-gradient-to-br from-violet-600/30 to-cyan-500/20 shadow-[0_0_24px_-6px_rgba(139,92,246,0.9)]">
            <Blocks className="h-5 w-5 text-violet-200" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-wide text-white">OG HOST</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Bedrock Panel</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn-ghost !min-h-10 !px-3.5 !py-2 text-xs sm:text-sm">
            Sign in
          </Link>
          <Link href="/signup" className="btn-primary !min-h-10 !px-3.5 !py-2 text-xs sm:text-sm">
            Get started
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5">
        <section className="fade-in py-14 text-center sm:py-24">
          <span className="chip border-violet-400/30 bg-violet-500/12 text-violet-200">
            Free · Self-hosted · Bedrock Edition
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-6xl">
            Host Minecraft Bedrock on{' '}
            <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
              your own PC
            </span>
            , control it from your phone.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-white/55 sm:text-base">
            OG HOST turns a Windows laptop into a private Minecraft Bedrock hosting node. Create
            servers, edit worlds, watch a live console, manage add-ons and versions, and share a
            connection address with friends — all from a web panel that works anywhere. No hosting
            subscription, ever.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="btn-primary w-full sm:w-auto">
              Create your account <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/login" className="btn-ghost w-full sm:w-auto">
              I already have an account
            </Link>
          </div>
          <p className="mt-4 text-[11px] text-white/35">
            You need a Windows 10/11 computer to host and any device with a browser to control it.
          </p>
        </section>

        <section className="grid gap-3 pb-16 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="glass glass-hover p-4">
              <div className="mb-3 grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-violet-300">
                <Icon className="h-[18px] w-[18px]" />
              </div>
              <p className="text-sm font-semibold text-white/85">{title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/45">{body}</p>
            </div>
          ))}
        </section>

        <section className="glass mb-20 p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-white">How it actually works</h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Create an account', 'Email + password through Supabase Auth.'],
              ['Pair your Windows PC', 'Generate a 10-minute pairing code, paste it into the agent.'],
              ['Create a Bedrock server', 'Pick your node, world name, game mode, player cap.'],
              ['Invite friends', 'Start networking, then share the verified address and port.'],
            ].map(([step, body], i) => (
              <li key={step} className="flex gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-violet-400/30 bg-violet-500/12 text-xs font-bold text-violet-200">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-white/85">{step}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-white/45">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-white/8 px-5 py-8 text-center">
        <p className="text-xs text-white/35">
          OG HOST is an independent project. Not affiliated with Mojang Studios or Microsoft.
          Minecraft Bedrock Dedicated Server is downloaded from official sources by your own node.
        </p>
      </footer>
    </div>
  );
}
