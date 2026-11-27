import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DatabaseBackup, ArrowRight, Info } from 'lucide-react';
import { Card, CardHeader, EmptyState } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default async function BackupsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: servers }, { data: backups }, { data: schedules }] = await Promise.all([
    supabase.from('servers').select('*').order('created_at', { ascending: false }),
    supabase
      .from('server_backups')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('backup_schedules').select('*'),
  ]);

  const serverById = new Map((servers ?? []).map((s) => [s.id, s]));
  const scheduleByServer = new Map((schedules ?? []).map((s) => [s.server_id, s]));
  const completed = (backups ?? []).filter((b) => b.status === 'completed');
  const totalBytes = completed.reduce((sum, b) => sum + (b.size_bytes ?? 0), 0);

  return (
    <div className="fade-in flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Backups</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          World backups
        </h1>
        <p className="mt-1 text-xs text-white/45">
          {completed.length} completed backups · {formatSize(totalBytes)} total · stored on your own
          devices
        </p>
      </header>

      {(servers ?? []).length === 0 ? (
        <EmptyState
          icon={<DatabaseBackup className="h-6 w-6" />}
          title="Nothing to back up yet"
          description="Create a Minecraft Bedrock server first. Backups are created on the device that hosts the world and can be downloaded or restored from here."
          action={
            <Link href="/servers/new" className="btn-primary">
              Create a server
            </Link>
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {(servers ?? []).map((s) => {
            const serverBackups = (backups ?? []).filter((b) => b.server_id === s.id);
            const schedule = scheduleByServer.get(s.id);
            return (
              <Card key={s.id} hover className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/servers/${s.id}?tab=backups`}
                      className="block truncate text-sm font-semibold text-white/90 hover:text-violet-200"
                    >
                      {s.name}
                    </Link>
                    <p className="mt-1 truncate text-[11px] text-white/40">
                      world {s.world_name ?? 'world'} · {serverBackups.length} backups ·{' '}
                      {s.installed_version ?? 'BDS not installed'}
                    </p>
                  </div>
                  <Badge tone={s.status === 'running' ? 'green' : 'slate'}>{s.status}</Badge>
                </div>

                <div className="rounded-xl border border-white/8 bg-black/25 px-3.5 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/35">Schedule</p>
                  <p className="mt-1 text-xs text-white/75">
                    {schedule?.enabled
                      ? `Every ${schedule.interval_hours} h · keep last ${schedule.keep_count}${
                          schedule.safe_stop_server ? ' · stops the server safely first' : ''
                        }`
                      : 'Automatic backups are off'}
                  </p>
                  {schedule?.last_run_at ? (
                    <p className="mt-1 text-[10px] text-white/35">
                      last run {new Date(schedule.last_run_at).toLocaleString()}
                    </p>
                  ) : null}
                </div>

                {serverBackups.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {serverBackups.slice(0, 4).map((b) => (
                      <li
                        key={b.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-white/6 bg-black/20 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium text-white/80">{b.name}</p>
                          <p className="text-[10px] text-white/35">
                            {b.size_bytes > 0 ? `${formatSize(b.size_bytes)} · ` : ''}
                            {new Date(b.created_at).toLocaleString()}
                          </p>
                        </div>
                        <Badge
                          tone={
                            b.status === 'completed'
                              ? 'green'
                              : b.status === 'failed'
                                ? 'red'
                                : 'amber'
                          }
                        >
                          {b.status.replace('_', ' ')}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-white/40">
                    No backups yet. Back up manually from the server’s Backups tab, or turn on a
                    schedule.
                  </p>
                )}

                <Link
                  href={`/servers/${s.id}?tab=backups`}
                  className="btn-ghost mt-auto !min-h-9 !px-3 !py-1.5 text-xs"
                >
                  Manage backups <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader icon={<Info className="h-[18px] w-[18px]" />} title="How backups stay consistent" />
        <div className="grid gap-3 text-[11px] leading-relaxed text-white/55 sm:grid-cols-2">
          <p>
            A Bedrock world is a folder of LevelDB chunks being written continuously. Zipping it
            while the server is running can capture a half-written chunk. OG HOST therefore asks the
            agent to flush and, when the option is enabled, stop the server safely before archiving.
          </p>
          <p>
            Each backup records the Bedrock version it was taken on, so a restore across a version
            change is visible rather than surprising. Archives live on your own device; downloading
            one streams it through your private storage bucket with a 15-minute signed link, never
            through another account’s space.
          </p>
        </div>
      </Card>
    </div>
  );
}
