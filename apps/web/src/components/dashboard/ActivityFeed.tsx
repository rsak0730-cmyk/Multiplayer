'use client';

import { Activity } from 'lucide-react';

interface EventRow {
  id: string;
  node_id: string;
  event_type: string;
  message: string | null;
  created_at: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const TONE: Record<string, string> = {
  paired: 'text-emerald-300',
  server_created: 'text-violet-300',
  server_started: 'text-cyan-300',
  server_stopped: 'text-white/55',
  crashed: 'text-red-300',
  revoked: 'text-red-300',
  token_rotated: 'text-amber-300',
};

export function ActivityFeed({ events }: { events: EventRow[] }) {
  return (
    <div className="glass p-5">
      <div className="mb-4 flex items-center gap-2">
        <Activity className="h-4 w-4 text-cyan-300" />
        <h3 className="card-title">Recent activity</h3>
      </div>
      {events.length === 0 ? (
        <p className="text-xs leading-relaxed text-white/45">
          Nothing yet. Events appear here as soon as a node pairs, a server starts, or something
          goes wrong on your hardware.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {events.slice(0, 12).map((e) => (
            <li
              key={e.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-white/6 bg-black/20 px-3 py-2"
            >
              <div className="min-w-0">
                <p className={`text-[11px] font-medium ${TONE[e.event_type] ?? 'text-white/70'}`}>
                  {e.event_type.replace(/_/g, ' ')}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-white/45">
                  {e.message ?? '—'}
                </p>
              </div>
              <span className="shrink-0 text-[10px] text-white/30">{timeAgo(e.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
