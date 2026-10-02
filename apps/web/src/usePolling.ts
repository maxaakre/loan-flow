import { useCallback, useEffect, useState } from 'react';

/**
 * Polls `load` every `intervalMs`. Polling is a deliberate free-tier choice;
 * production would push updates over WebSocket or AppSync instead.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const value = await load();
        if (!alive) return;
        setData(value);
        setError(undefined);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Något gick fel.');
      }
      if (alive) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load, intervalMs, tick]);

  return { data, error, refresh };
}
