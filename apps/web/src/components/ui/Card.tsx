import { clsx } from 'clsx';

export function Card({
  children,
  className,
  hover = false,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div className={clsx('glass p-4 sm:p-5', hover && 'glass-hover', className)}>{children}</div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
  icon,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {icon ? (
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-violet-300">
            {icon}
          </div>
        ) : null}
        <div>
          <h3 className="card-title">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-white/45">{subtitle}</p> : null}
        </div>
      </div>
      {right}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="glass flex flex-col items-center gap-3 px-6 py-12 text-center">
      {icon ? (
        <div className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/5 text-violet-300">
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-sm font-semibold text-white/85">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-white/45">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
