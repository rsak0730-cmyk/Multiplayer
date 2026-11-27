'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { clsx } from 'clsx';
import {
  LayoutDashboard,
  Server,
  MonitorSmartphone,
  Globe2,
  DatabaseBackup,
  TerminalSquare,
  Settings,
  Menu,
  X,
  LogOut,
  Blocks,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/servers', label: 'My Servers', icon: Server },
  { href: '/devices', label: 'Devices', icon: MonitorSmartphone },
  { href: '/networking', label: 'Networking', icon: Globe2 },
  { href: '/backups', label: 'Backups', icon: DatabaseBackup },
  { href: '/console', label: 'Console', icon: TerminalSquare },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-1">
      <div className="grid h-9 w-9 place-items-center rounded-xl border border-violet-400/30 bg-gradient-to-br from-violet-600/30 to-cyan-500/20 shadow-[0_0_24px_-6px_rgba(139,92,246,0.9)]">
        <Blocks className="h-5 w-5 text-violet-200" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-bold tracking-wide text-white">OG HOST</p>
        <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Bedrock Panel</p>
      </div>
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={clsx('nav-link', active && 'nav-link-active')}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  window.location.href = '/login';
}

export function Sidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-white/8 bg-[#07070f]/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-ghost !min-h-10 !px-3 !py-2"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-[82%] max-w-xs flex-col gap-5 border-r border-white/10 bg-[#0a0a16]/95 p-4 backdrop-blur-2xl">
            <div className="flex items-center justify-between">
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-ghost !min-h-9 !px-2.5 !py-1.5"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavList onNavigate={() => setOpen(false)} />
            <div className="mt-auto">
              <button type="button" onClick={signOut} className="btn-ghost w-full">
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col gap-6 border-r border-white/8 bg-[#08081273]/60 p-4 backdrop-blur-2xl lg:flex">
        <Brand />
        <NavList />
        <div className="mt-auto flex flex-col gap-3">
          <div className="glass px-3 py-2.5">
            <p className="text-[11px] leading-relaxed text-white/45">
              Self-hosted · no subscription. Your Windows PC is the game host; this panel is the
              remote control.
            </p>
          </div>
          <button type="button" onClick={signOut} className="btn-ghost w-full">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
