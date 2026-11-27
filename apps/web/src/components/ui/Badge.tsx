import { clsx } from 'clsx';

type Tone = 'violet' | 'cyan' | 'green' | 'amber' | 'red' | 'slate';

const TONES: Record<Tone, string> = {
  violet: 'border-violet-400/30 bg-violet-500/12 text-violet-200',
  cyan: 'border-cyan-400/30 bg-cyan-500/12 text-cyan-200',
  green: 'border-emerald-400/30 bg-emerald-500/12 text-emerald-200',
  amber: 'border-amber-400/30 bg-amber-500/12 text-amber-200',
  red: 'border-red-400/30 bg-red-500/12 text-red-200',
  slate: 'border-white/12 bg-white/5 text-white/60',
};

export function Badge({
  children,
  tone = 'slate',
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return <span className={clsx('chip', TONES[tone], className)}>{children}</span>;
}
