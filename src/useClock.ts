import { useEffect, useState } from "react";

// Separate timers, even on an identical interval, drift apart within a minute,
// because each waits from when its own request finished. One clock on a fixed
// edge keeps the panels in step.
export function useClock(intervalMs: number) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((previous) => previous + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return tick;
}
