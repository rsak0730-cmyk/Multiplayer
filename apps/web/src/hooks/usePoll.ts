'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll a JSON endpoint on an interval. Pauses when the tab is hidden to save
 * mobile battery and Vercel invocations.
 */
export function usePoll<T>(url: string | null, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tick = useCallback(async () => {
    if (!url) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(Boolean(url));
    void tick();
    timer.current = setInterval(() => void tick(), intervalMs);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tick, intervalMs, url]);

  const refresh = useCallback(() => tick(), [tick]);
  return { data, error, loading, refresh };
}
