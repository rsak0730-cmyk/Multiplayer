'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TerminalSquare,
  Send,
  Trash2,
  Copy,
  ArrowDown,
  Loader2,
  AlertCircle,
  Info,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { ServerDetail, NodeDetail } from '@/components/servers/ServerDetailClient';

interface LogLine {
  id: number;
  line: string;
  stream: 'stdout' | 'stderr' | 'system';
  created_at: string;
}

const HISTORY_KEY = (serverId: string) => `oghost.console.history.${serverId}`;

export function ConsolePanel({
  server,
  node,
}: {
  server: ServerDetail;
  node: NodeDetail | null;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastId = useRef<number>(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  // Load command history for this server.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY(server.id));
      if (raw) setHistory(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
  }, [server.id]);

  const pull = useCallback(async () => {
    try {
      const url = `/api/servers/${server.id}/console?limit=200${
        lastId.current ? `&after=${lastId.current}` : ''
      }`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as { lines: LogLine[] };
      if (!json.lines?.length) return;
      setLines((prev) => {
        const merged = [...prev, ...json.lines].slice(-800);
        lastId.current = merged[merged.length - 1]?.id ?? lastId.current;
        return merged;
      });
    } catch {
      /* transient */
    }
  }, [server.id]);

  useEffect(() => {
    void pull();
    const id = setInterval(() => {
      if (!document.hidden) void pull();
    }, 2500);
    return () => clearInterval(id);
  }, [pull]);

  useEffect(() => {
    if (autoScroll && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  function pushHistory(command: string) {
    const next = [command, ...history.filter((h) => h !== command)].slice(0, 50);
    setHistory(next);
    try {
      window.localStorage.setItem(HISTORY_KEY(server.id), JSON.stringify(next));
    } catch {
      /* storage may be unavailable */
    }
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const command = input.trim();
    if (!command) return;
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'console_command', command }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? 'Command rejected');
      } else {
        pushHistory(command);
        setLines((prev) => [
          ...prev,
          {
            id: Date.now(),
            line: `> ${command}`,
            stream: 'system',
            created_at: new Date().toISOString(),
          },
        ]);
        setInput('');
        setHistoryIndex(-1);
      }
    } catch {
      setErrorText('Network error while sending the command.');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (history.length === 0) return;
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex] ?? '');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput('');
        return;
      }
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex] ?? '');
    }
  }

  function copyAll() {
    const text = lines
      .map((l) => `[${new Date(l.created_at).toISOString()}] ${l.line}`)
      .join('\n');
    void navigator.clipboard?.writeText(text);
  }

  const running = server.status === 'running';
  const nodeOnline = node?.computed_status === 'online';

  return (
    <Card>
      <CardHeader
        icon={<TerminalSquare className="h-[18px] w-[18px]" />}
        title="Live console"
        subtitle="Real Bedrock Dedicated Server output streamed from your device"
        right={
          <div className="flex items-center gap-1.5">
            <Badge tone={running ? 'green' : 'slate'}>{server.status}</Badge>
            <Badge tone={nodeOnline ? 'cyan' : 'slate'}>node {node?.computed_status ?? 'unknown'}</Badge>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs" onClick={copyAll}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
        <button
          type="button"
          className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
          onClick={() => setLines([])}
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear view
        </button>
        <button
          type="button"
          className={`btn-ghost !min-h-9 !px-3 !py-1.5 text-xs ${autoScroll ? '!border-violet-400/40 !text-violet-200' : ''}`}
          onClick={() => {
            setAutoScroll((v) => !v);
            if (!autoScroll && scroller.current) {
              scroller.current.scrollTop = scroller.current.scrollHeight;
            }
          }}
        >
          <ArrowDown className="h-3.5 w-3.5" /> Auto-scroll {autoScroll ? 'on' : 'off'}
        </button>
        {!autoScroll ? (
          <button
            type="button"
            className="btn-cyan !min-h-9 !px-3 !py-1.5 text-xs"
            onClick={() => {
              setAutoScroll(true);
              if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            }}
          >
            Jump to bottom
          </button>
        ) : null}
      </div>

      <div
        ref={scroller}
        className="console-surface scrollbar-thin h-[46vh] min-h-[260px] overflow-y-auto rounded-xl p-3 sm:h-[52vh]"
      >
        {lines.length === 0 ? (
          <p className="text-white/35">
            {running
              ? 'Waiting for output from the server…'
              : 'The server is not running. Start it to see live Bedrock Dedicated Server output here.'}
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-white/25">
                {new Date(l.created_at).toLocaleTimeString()}
              </span>
              <span
                className={
                  l.stream === 'stderr'
                    ? 'text-red-300/90'
                    : l.stream === 'system'
                      ? 'text-violet-300/90'
                      : 'text-emerald-100/80'
                }
              >
                {l.line}
              </span>
            </div>
          ))
        )}
      </div>

      <form onSubmit={send} className="mt-3 flex items-center gap-2">
        <input
          className="input font-mono !text-xs"
          placeholder={
            running ? 'Type a Bedrock command, e.g. list, say hello, difficulty hard' : 'Start the server to send commands'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || !running}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn-primary !px-3.5" disabled={busy || !running || !input.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>

      {errorText ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-red-100/90">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{errorText}</span>
        </div>
      ) : null}

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[11px] leading-relaxed text-white/50">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Commands are checked against an allowlist of official Bedrock console commands before they
          reach your device, and again by the agent. There is no remote shell — you cannot run
          Windows commands through this panel. Arrow keys walk through your command history.
        </span>
      </div>
    </Card>
  );
}
