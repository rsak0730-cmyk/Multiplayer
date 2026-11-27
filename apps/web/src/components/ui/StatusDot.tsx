import { clsx } from 'clsx';

export type DotKind =
  | 'online'
  | 'offline'
  | 'running'
  | 'error'
  | 'warn'
  | 'unknown';

const LABEL: Record<DotKind, string> = {
  online: 'Online',
  offline: 'Offline',
  running: 'Running',
  error: 'Error',
  warn: 'Warning',
  unknown: 'Unknown',
};

export function StatusDot({ kind, label }: { kind: DotKind; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={clsx('dot', `dot-${kind}`)} aria-hidden />
      <span className="text-xs text-white/70">{label ?? LABEL[kind]}</span>
    </span>
  );
}

export function statusToDot(status: string | null | undefined): DotKind {
  switch (status) {
    case 'online':
    case 'running':
      return status === 'running' ? 'running' : 'online';
    case 'offline':
    case 'stopped':
      return 'offline';
    case 'starting':
    case 'stopping':
    case 'installing':
    case 'updating':
    case 'pending':
    case 'in_progress':
      return 'warn';
    case 'error':
    case 'failed':
    case 'revoked':
      return 'error';
    default:
      return 'unknown';
  }
}
