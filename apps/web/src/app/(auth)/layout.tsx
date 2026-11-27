import Link from 'next/link';
import { Blocks } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-5 py-5">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl border border-violet-400/30 bg-gradient-to-br from-violet-600/30 to-cyan-500/20 shadow-[0_0_24px_-6px_rgba(139,92,246,0.9)]">
            <Blocks className="h-5 w-5 text-violet-200" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-wide text-white">OG HOST</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Bedrock Panel</p>
          </div>
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:items-center sm:pt-0">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
