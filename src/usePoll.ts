import { useEffect, useState } from "react";

export function usePoll<T>(load: (() => Promise<T>) | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    let timer: NodeJS.Timeout;

    const loop = async () => {
      try {
        const next = await load();
        if (!cancelled) setData(next);
      } catch {
        // a stale value beats an empty panel; the next tick will retry
      }
      if (!cancelled) timer = setTimeout(loop, intervalMs);
    };

    void loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load, intervalMs]);

  return data;
}
