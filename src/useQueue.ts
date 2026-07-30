import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChecks, fetchQueue, type Checks, type Entry, type Queue } from "./github.js";
import { SetupError } from "./auth.js";

export type Event = {
  id: number;
  at: Date;
  text: string;
  tone: "good" | "bad" | "info";
  mine: boolean;
};

export type Target = {
  token: string;
  owner: string;
  name: string;
  branch: string;
  as?: string;
};

function diff(prev: Entry[], next: Entry[], viewer: string): Omit<Event, "id" | "at">[] {
  const before = new Map(prev.map((e) => [e.pullRequest.number, e]));
  const after = new Map(next.map((e) => [e.pullRequest.number, e]));
  const events: Omit<Event, "id" | "at">[] = [];

  for (const entry of next) {
    const was = before.get(entry.pullRequest.number);
    const mine = entry.pullRequest.author?.login === viewer;

    if (!was) {
      events.push({
        text: `#${entry.pullRequest.number} joined the queue at position ${entry.position}`,
        tone: "info",
        mine,
      });
      continue;
    }

    if (was.state !== entry.state) {
      events.push({
        text: `#${entry.pullRequest.number} is now ${entry.state.toLowerCase().replace(/_/g, " ")}`,
        tone: entry.state === "UNMERGEABLE" ? "bad" : "info",
        mine,
      });
    }

    if (mine && was.position !== entry.position) {
      events.push({
        text: `#${entry.pullRequest.number} moved to position ${entry.position}`,
        tone: entry.position < was.position ? "good" : "info",
        mine,
      });
    }
  }

  for (const entry of prev) {
    if (after.has(entry.pullRequest.number)) continue;
    const mine = entry.pullRequest.author?.login === viewer;
    const merged = entry.position === 1;
    events.push({
      text: merged
        ? `#${entry.pullRequest.number} merged`
        : `#${entry.pullRequest.number} left the queue`,
      tone: merged ? "good" : "bad",
      mine,
    });
  }

  return events;
}

export function useQueue(target: Target, intervalMs: number) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [checks, setChecks] = useState<Map<string, Checks>>(new Map());
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [fetching, setFetching] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [nonce, setNonce] = useState(0);
  const previous = useRef<Entry[] | null>(null);
  const failures = useRef(0);
  const fatal = useRef(false);
  const nextId = useRef(0);

  const poll = useCallback(async () => {
    setFetching(true);
    try {
      const result = await fetchQueue(target);
      const viewer = target.as ?? result.viewer;

      if (previous.current) {
        const fresh = diff(previous.current, result.entries, viewer);
        if (fresh.length > 0) {
          const at = new Date();
          setEvents((current) =>
            [
              ...fresh.map((e) => ({ ...e, id: nextId.current++, at })),
              ...current,
            ].slice(0, 50),
          );
        }
      }

      previous.current = result.entries;
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
  }, [poll, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const viewer = target.as ?? queue?.viewer ?? "";

  return { queue, viewer, checks, events, error, fetching, updatedAt, refresh };
}
