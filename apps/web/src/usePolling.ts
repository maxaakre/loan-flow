import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls `load` every `intervalMs`. Polling is a deliberate free-tier choice;
 * production would push updates over WebSocket or AppSync instead.
 *
 * `stopWhen` marks data as final. After it first returns true, at most EXTRA_POLLS more
 * polls run (to catch late events like the timeline), then polling stops. `refresh()` restarts it.
 */
export const EXTRA_POLLS = 5;

export function usePolling<T>(load: () => Promise<T>, intervalMs: number, stopWhen?: (data: T) => boolean) {
  const stopRef = useRef(stopWhen);
  stopRef.current = stopWhen;
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    let extraPolls: number | undefined; // undefined until stopWhen has returned true
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const value = await load();
        if (!alive) return;
        setData(value);
        setError(undefined);
        if (extraPolls !== undefined) extraPolls += 1;
        else if (stopRef.current?.(value)) extraPolls = 0;
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Något gick fel.');
      }
      if (alive && (extraPolls ?? 0) < EXTRA_POLLS) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load, intervalMs, tick]);

  return { data, error, refresh };
}
