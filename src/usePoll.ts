import { useEffect, useState } from "react";

export function usePoll<T>(load: (() => Promise<T>) | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!load) return;
    // `load` only changes when the query itself changes, so anything already
    // held describes a different question and must not be shown as an answer.
    setData(null);
    setError(null);

    let cancelled = false;
    let timer: NodeJS.Timeout;

    const loop = async () => {
      try {
        const next = await load();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (caught) {
        // a stale value beats an empty panel, but a panel that never fills
        // should say why rather than look merely quiet
        if (!cancelled) setError(caught as Error);
      }
      if (!cancelled) timer = setTimeout(loop, intervalMs);
    };

    void loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load, intervalMs]);

  // The hook is what set `data` to null and what knows whether there is a query
  // at all, so it reports waiting rather than making each caller rebuild it.
  return { data, error, loading: Boolean(load) && data === null && error === null };
}
