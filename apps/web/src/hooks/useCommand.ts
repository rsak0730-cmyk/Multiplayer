'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type CommandState =
  | { kind: 'idle' }
  | { kind: 'queued'; commandId: string; message?: string }
  | { kind: 'running'; commandId: string }
  | { kind: 'completed'; commandId: string; result: Record<string, unknown> | null }
  | { kind: 'failed'; commandId: string; error: string };

/**
 * Track an enqueued agent command until it completes. Polls
 * /api/servers/:id/commands/:commandId every 2s (max ~5 minutes).
 */
export function useCommand(serverId: string) {
  const [state, setState] = useState<CommandState>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef<number>(0);

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const track = useCallback(
    (commandId: string, message?: string) => {
      stop();
      startedAt.current = Date.now();
      setState({ kind: 'queued', commandId, message });
      timer.current = setInterval(async () => {
        if (Date.now() - startedAt.current > 5 * 60_000) {
          stop();
          setState({
            kind: 'failed',
            commandId,
            error:
              'Timed out waiting for the node to answer. Check that the OG HOST Agent is running on that computer.',
          });
          return;
        }
        try {
          const res = await fetch(`/api/servers/${serverId}/commands/${commandId}`, {
            cache: 'no-store',
          });
          if (!res.ok) return;
          const json = (await res.json()) as {
            command: { status: string; result: Record<string, unknown> | null; error_message: string | null };
          };
          const cmd = json.command;
          if (cmd.status === 'claimed' || cmd.status === 'running') {
            setState({ kind: 'running', commandId });
          } else if (cmd.status === 'completed') {
            stop();
            setState({ kind: 'completed', commandId, result: cmd.result });
          } else if (cmd.status === 'failed' || cmd.status === 'cancelled') {
            stop();
            setState({
              kind: 'failed',
              commandId,
              error: cmd.error_message ?? 'The node reported a failure.',
            });
          }
        } catch {
          // Transient network error — keep polling.
        }
      }, 2000);
    },
    [serverId, stop],
  );

  useEffect(() => stop, [stop]);

  return { state, track, reset: () => { stop(); setState({ kind: 'idle' }); } };
}
