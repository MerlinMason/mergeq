import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChecks, fetchQueue, type Checks, type Entry, type Queue } from "./github.js";
import { SetupError } from "./auth.js";

export type Target = {
  token: string;
  owner: string;
  name: string;
  branch: string;
  as?: string;
};

export function useQueue(target: Target, intervalMs: number) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [checks, setChecks] = useState<Map<string, Checks>>(new Map());
  const [error, setError] = useState<Error | null>(null);
  const [fetching, setFetching] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const failures = useRef(0);
  const fatal = useRef(false);

  const poll = useCallback(async () => {
    setFetching(true);
    try {
      const result = await fetchQueue(target);
      const viewer = target.as ?? result.viewer;

      failures.current = 0;
      setQueue(result);
      setUpdatedAt(new Date());
      setError(null);

      const oids = result.entries
        .filter((entry) => entry.pullRequest.author?.login === viewer)
        .map((entry) => entry.headCommit?.oid)
        .filter((oid): oid is string => Boolean(oid));

      if (oids.length === 0) {
        setChecks(new Map());
      } else {
        void fetchChecks({ ...target, oids })
          .then(setChecks)
          .catch(() => {});
      }
    } catch (caught) {
      failures.current += 1;
      fatal.current = caught instanceof SetupError;
      setError(caught as Error);
    } finally {
      setFetching(false);
    }
  }, [target]);

  useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout;

    const loop = async () => {
      await poll();
      if (cancelled || fatal.current) return;
      const backoff = Math.min(2 ** failures.current, 8);
      timer = setTimeout(loop, intervalMs * backoff);
    };

    void loop();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll, intervalMs]);

  const viewer = target.as ?? queue?.viewer ?? "";

  return { queue, viewer, checks, error, fetching, updatedAt };
}
