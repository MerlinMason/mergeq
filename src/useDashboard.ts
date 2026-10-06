import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChecks, fetchDashboard, SECTIONS, type Checks, type Snapshot } from "./github.js";
import { SetupError } from "./auth.js";

export type Target = {
  token: string;
  owner: string;
  name: string;
  branch: string;
  as?: string;
};

type Held = Omit<Snapshot, "at" | "missing"> & {
  /** When a reply last answered for something, so a panel can date its rows. */
  at: Date | null;
};

const NOTHING: Held = { viewer: "", queue: null, reviews: null, prs: null, outcomes: null, rate: null, at: null };

// Keep what we had for any section GitHub did not answer for: blanking a panel
// is worse than dating its rows.
function merge(held: Held, { missing, ...next }: Snapshot): Held {
  for (const section of missing) Object.assign(next, { [section]: held[section] });
  // A reply that answered for nothing leaves the clock where it was.
  return missing.length === SECTIONS.length ? { ...next, at: held.at } : next;
}

export function useDashboard(target: Target, tick: number, mine: boolean) {
  const [held, setHeld] = useState<Held>(NOTHING);
  const [checks, setChecks] = useState<Map<string, Checks>>(new Map());
  const [fatal, setFatal] = useState<SetupError | null>(null);
  const [fetching, setFetching] = useState(false);
  // Why the clock stopped, rather than something to show in place of the rows.
  const [failing, setFailing] = useState<Error | null>(null);

  const failures = useRef(0);
  const cooldown = useRef(0);
  const inFlight = useRef(false);
  const asked = useRef<string | null>(null);

  const poll = useCallback(async () => {
    setFetching(true);
    try {
      const snapshot = await fetchDashboard({ ...target, mine });

      failures.current = 0;
      cooldown.current = 0;
      setHeld((previous) => merge(previous, snapshot));
      setFailing(
        snapshot.missing.length > 0
          ? new Error(`GitHub did not answer for ${snapshot.missing.join(", ")}`)
          : null,
      );

      const oids = (snapshot.queue?.entries ?? [])
        .filter((entry) => entry.author === snapshot.viewer)
        .flatMap((entry) => entry.headOid ?? []);

      if (oids.length === 0) {
        setChecks(new Map());
      } else {
        // Keyed by commit, so it cannot join the query above: you have to
        // know the commits before you can ask.
        void fetchChecks({ ...target, oids })
          .then(setChecks)
          .catch(() => {});
      }
    } catch (caught) {
      // Asking again will not fix a repository we cannot see, so stop.
      if (caught instanceof SetupError) {
        setFatal(caught);
        return;
      }

      failures.current += 1;
      // Ticks to sit out, doubling per failure, so an outage is not asked
      // about every few seconds.
      cooldown.current = Math.min(2 ** failures.current, 8) - 1;
      setFailing(caught as Error);
    } finally {
      setFetching(false);
    }
  }, [target, mine]);

  useEffect(() => {
    if (fatal) return;

    // A changed question is asked at once; an unchanged one waits for the
    // clock, and skips a turn while its last answer is still out.
    const question = `${target.owner}/${target.name}#${target.branch}${mine ? "" : ":all"}`;
    if (asked.current === question) {
      if (inFlight.current) return;
      if (cooldown.current > 0) {
        cooldown.current -= 1;
        return;
      }
    }
    asked.current = question;

    inFlight.current = true;
    void poll().finally(() => {
      inFlight.current = false;
    });
  }, [poll, target, mine, tick, fatal]);

  return { ...held, checks, fatal, failing, fetching };
}
