import { clsx } from 'clsx';

export function Meter({
  value,
  label,
  detail,
}: {
  value: number | null;
  label: string;
  detail?: string;
}) {
  const pct = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  const tone = pct >= 90 ? 'meter-danger' : pct >= 70 ? 'meter-warn' : 'meter-accent';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wider text-white/45">{label}</span>
        <span className="text-[11px] font-medium text-white/70">
          {value === null ? 'unknown' : `${pct.toFixed(0)}%`}
        </span>
      </div>
      <div className={clsx('meter', tone)}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {detail ? <p className="mt-1 text-[11px] text-white/40">{detail}</p> : null}
    </div>
  );
}
