import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { execFile } from "node:child_process";
import { useQueue, type Event, type Target } from "./useQueue.js";
import { usePoll } from "./usePoll.js";
import { notify } from "./notify.js";
import { SetupError } from "./auth.js";
import { link, pullRequestUrl } from "./link.js";
import {
  fetchOutcomes,
  fetchRate,
  type Checks,
  type Entry,
  type EntryState,
  type Outcome,
  type Rate,
} from "./github.js";

const STATES: Record<EntryState, { glyph: string; color: string; label: string }> = {
  QUEUED: { glyph: "○", color: "gray", label: "queued" },
  AWAITING_CHECKS: { glyph: "◐", color: "yellow", label: "checks" },
  MERGEABLE: { glyph: "●", color: "green", label: "mergeable" },
  UNMERGEABLE: { glyph: "✗", color: "red", label: "failing" },
  LOCKED: { glyph: "▲", color: "magenta", label: "locked" },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const REASONS: Record<string, { emoji: string; label: string }> = {
  merged: { emoji: "🚀", label: "shipped" },
  failed_checks: { emoji: "💥", label: "checks blew up" },
  merge_conflict: { emoji: "🥊", label: "merge conflict" },
  manual: { emoji: "✋", label: "yanked by hand" },
  queue_cleared: { emoji: "🧹", label: "queue cleared" },
  branch_protections: { emoji: "🚧", label: "branch protections" },
  invalid_merge_commit: { emoji: "🫠", label: "bad merge commit" },
};

function reasonOf(reason: string): { emoji: string; label: string } {
  return REASONS[reason.replace(/ /g, "_")] ?? { emoji: "😭", label: reason };
}

function busyness(depth: number): { emoji: string; label: string; color: string } {
  if (depth === 0) return { emoji: "🌙", label: "dead quiet", color: "green" };
  if (depth <= 4) return { emoji: "🍃", label: "ticking over", color: "green" };
  if (depth <= 9) return { emoji: "🚦", label: "getting spicy", color: "yellow" };
  return { emoji: "🔥", label: "absolute carnage", color: "red" };
}

const NOTHING_QUEUED = [
  "💅 nothing of yours in the queue — yassify something",
  "✨ nothing of yours in the queue — make something magic",
  "👑 nothing of yours in the queue — crank up the slay",
];

function useWidth(): number {
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  useEffect(() => {
    const onResize = () => bump((value) => value + 1);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return stdout.columns || 100;
}

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER[frame % SPINNER.length] ?? SPINNER[0]!;
}

function ago(from: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return "<1m";
  if (value < 60) return `${Math.round(value)}m`;
  const hours = Math.floor(value / 60);
  return `${hours}h${Math.round(value % 60)}m`;
}

function bar(done: number, total: number, width = 10): string {
  if (total === 0) return "░".repeat(width);
  const filled = Math.round((done / total) * width);
  return "▓".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function eta(position: number, rate: Rate | null, fallback: number | null): number | null {
  if (rate) return position * rate.gapMinutes;
  return fallback === null ? null : fallback / 60;
}

export function Section({ title }: { title: string }) {
  return (
    <Box marginTop={1}>
      <Text color="gray" dimColor bold>
        {title}
      </Text>
    </Box>
  );
}

export function Ahead({
  count,
  rate,
  width,
}: {
  count: number;
  rate: Rate | null;
  width: number;
}) {
  const wait = rate ? rate.gapMinutes * count : null;
  const label = `${count} ahead`;
  const right = wait === null ? "" : `~${minutes(wait)}`;
  const rule = "─".repeat(Math.max(3, width - 2 - 4 - label.length - right.length - 3));

  return (
    <Box>
      <Box width={4} flexShrink={0}>
        <Text color="gray" dimColor>
          {"  ⋯"}
        </Text>
      </Box>
      <Text color="gray" dimColor>
        {label} {rule}
      </Text>
      {right ? <Text color="gray"> {right}</Text> : null}
    </Box>
  );
}

export function Mine({
  entry,
  checks,
  rate,
  building,
  spinner,
  repo,
  here,
  now,
}: {
  entry: Entry;
  checks: Checks | undefined;
  rate: Rate | null;
  building: boolean;
  spinner: string;
  repo: { owner: string; name: string };
  here: boolean;
  now: number;
}) {
  const state = STATES[entry.state];
  const first = entry.position === 1;
  const estimate = eta(entry.position, rate, entry.estimatedTimeToMerge);
  const waiting = ago(new Date(entry.enqueuedAt), now);

  const accent = first ? "green" : building ? "cyan" : "white";
  const icon = first ? "▶" : building ? spinner : state.glyph;

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color="cyan" bold>
            {here ? "▸" : " "}
          </Text>
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={first ? "green" : state.color}>{icon}</Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text color={accent} bold underline={here}>
            {link(
              `#${entry.pullRequest.number}`,
              pullRequestUrl(repo.owner, repo.name, entry.pullRequest.number),
            )}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
          <Text bold={first} color={first ? "green" : undefined} wrap="truncate">
            {entry.pullRequest.title}
          </Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text color="gray">pos {entry.position}</Text>
        </Box>
      </Box>

      <Box marginLeft={4}>
        {first ? (
          <Text color="green" bold>
            🚀 you&apos;re up next{" "}
          </Text>
        ) : null}
        {checks && checks.total > 0 ? (
          <Text>
            <Text color={checks.failing > 0 ? "red" : building ? "cyan" : "gray"}>
              {bar(checks.done, checks.total)}
            </Text>
            <Text color="gray">
              {" "}
              {checks.done}/{checks.total}
            </Text>
            {checks.failing > 0 ? (
              <Text color="red" bold>
                {" "}
                {checks.failing} failing
              </Text>
            ) : null}
            {checks.running ? (
              <Text color="gray" dimColor wrap="truncate">
                {" "}
                · {checks.running}
              </Text>
            ) : null}
          </Text>
        ) : (
          <Text color="gray">{state.label}</Text>
        )}
        <Box flexGrow={1} />
        <Text color="gray" dimColor>
          waited {waiting} ·{" "}
        </Text>
        <Text color={first ? "green" : "cyan"}>~{minutes(estimate)} left</Text>
      </Box>
    </Box>
  );
}

function Recently({
  outcomes,
  repo,
  selected,
  now,
}: {
  outcomes: Outcome[];
  repo: { owner: string; name: string };
  selected: number;
  now: number;
}) {
  if (outcomes.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Section title="RECENTLY" />
      {outcomes.slice(0, 6).map((outcome, index) => {
        const merged = outcome.kind === "merged";
        const reason = reasonOf(merged ? "merged" : outcome.reason);
        const here = index === selected;
        return (
          <Box key={`${outcome.number}-${outcome.at.getTime()}`}>
            <Box width={4} flexShrink={0}>
              <Text color="cyan" bold>
                {here ? "▸" : " "}
              </Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text color={merged ? "green" : "red"} bold={here} underline={here}>
                {link(`#${outcome.number}`, pullRequestUrl(repo.owner, repo.name, outcome.number))}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
              <Text wrap="truncate" color={here ? "white" : "gray"}>
                {outcome.title}
              </Text>
            </Box>
            <Box width={25} flexShrink={0}>
              <Text color={merged ? "green" : "red"} wrap="truncate">
                {reason.emoji} {reason.label} {ago(outcome.at, now)} ago
              </Text>
            </Box>
            <Box width={14} flexShrink={0} justifyContent="flex-end">
              {outcome.queuedMinutes !== null ? (
                <Text color="gray" dimColor wrap="truncate">
                  ⏱️ {merged ? "in" : "after"} {minutes(outcome.queuedMinutes)}
                </Text>
              ) : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Empty({
  depth,
  rate,
  outcomes,
  now,
}: {
  depth: number;
  rate: Rate | null;
  outcomes: Outcome[];
  now: number;
}) {
  const busy = busyness(depth);
  const lastMerge = outcomes.find((o) => o.kind === "merged");
  const [greeting] = useState(
    () => NOTHING_QUEUED[Math.floor(Math.random() * NOTHING_QUEUED.length)]!,
  );
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={3}>
      <Text color="green">{greeting}</Text>
      <Box marginTop={1}>
        <Text color="gray">
          {busy.emoji} the queue is <Text color={busy.color}>{busy.label}</Text>
          <Text color="gray">
            {" "}
            — {depth} {depth === 1 ? "item" : "items"}
            {rate ? `, merging every ~${minutes(rate.gapMinutes)}` : ""}
          </Text>
        </Text>
      </Box>
      {lastMerge ? (
        <Text color="gray" dimColor>
          you last shipped #{lastMerge.number} {ago(lastMerge.at, now)} ago 🚀
        </Text>
      ) : null}
    </Box>
  );
}

function AllRow({
  entry,
  mine,
  repo,
  now,
}: {
  entry: Entry;
  mine: boolean;
  repo: { owner: string; name: string };
  now: number;
}) {
  const state = STATES[entry.state];
  const author = entry.pullRequest.author?.login ?? "unknown";
  return (
    <Box>
      <Box width={3} marginRight={1} flexShrink={0}>
        <Text color={mine ? "cyan" : "gray"}>{String(entry.position).padStart(2)}</Text>
      </Box>
      <Box width={7} marginRight={1} flexShrink={0}>
        <Text color={mine ? "cyan" : undefined} bold={mine}>
          {link(
            `#${entry.pullRequest.number}`,
            pullRequestUrl(repo.owner, repo.name, entry.pullRequest.number),
          )}
        </Text>
      </Box>
      <Box width={10} marginRight={1} flexShrink={0}>
        <Text color={state.color} wrap="truncate">
          {state.glyph} {state.label}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
        <Text bold={mine} wrap="truncate">
          {entry.pullRequest.title}
        </Text>
      </Box>
      <Box width={14} marginRight={1} flexShrink={0}>
        <Text color="gray" wrap="truncate">
          {author}
        </Text>
      </Box>
      <Box width={4} flexShrink={0}>
        <Text color="gray">{ago(new Date(entry.enqueuedAt), now)}</Text>
      </Box>
    </Box>
  );
}

function Events({ events, now }: { events: Event[]; now: number }) {
  if (events.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Section title="ACTIVITY" />
      {events.slice(0, 3).map((event) => (
        <Box key={event.id} marginLeft={3}>
          <Text color="gray" dimColor>
            {ago(event.at, now)} ago{" "}
          </Text>
          <Text
            color={event.tone === "good" ? "green" : event.tone === "bad" ? "red" : "white"}
            bold={event.mine}
          >
            {event.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export default function App({
  target,
  interval,
  all,
  as,
}: {
  target: Target;
  interval: number;
  all: boolean;
  as?: string;
}) {
  const { exit } = useApp();
  const width = useWidth();
  const { queue, checks, events, error, fetching, updatedAt, refresh } = useQueue(
    target,
    interval,
  );
  const spinner = useSpinner(true);
  const [now, setNow] = useState(Date.now());
  const [showAll, setShowAll] = useState(all);
  const [selection, setSelection] = useState(0);

  const viewer = as ?? queue?.viewer ?? "";

  const loadOutcomes = useCallback(
    () => (viewer ? fetchOutcomes({ ...target, login: viewer }) : Promise.resolve([])),
    [target, viewer],
  );
  const loadRate = useCallback(() => fetchRate(target), [target]);

  const outcomes = usePoll(viewer ? loadOutcomes : null, 60_000) ?? [];
  const rate = usePoll(loadRate, 300_000);

  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (outcomes.length === 0) return;
    const keys = outcomes.map((o) => `${o.number}-${o.at.getTime()}`);

    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }

    for (const outcome of outcomes) {
      const key = `${outcome.number}-${outcome.at.getTime()}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (outcome.kind === "merged") {
        notify(`🚀 #${outcome.number} shipped`, outcome.title);
      } else {
        const reason = reasonOf(outcome.reason);
        notify(`${reason.emoji} #${outcome.number} out of the queue`, `${reason.label} — ${outcome.title}`);
      }
    }
  }, [outcomes]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const repo = { owner: target.owner, name: target.name };
  const stale = updatedAt !== null && now - updatedAt.getTime() > 30_000;
  const entries = queue?.entries ?? [];
  const mine = entries.filter((entry) => entry.pullRequest.author?.login === viewer);
  const buildWindow = queue?.maximumEntriesToBuild ?? 0;
  const busy = busyness(queue?.totalCount ?? 0);

  const selectable = [
    ...mine.map((entry) => entry.pullRequest.number),
    ...outcomes.slice(0, 6).map((outcome) => outcome.number),
  ];
  const cursor = selectable.length === 0 ? -1 : Math.min(selection, selectable.length - 1);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
    if (input === "r") refresh();
    if (input === "a") setShowAll((value) => !value);
    if (input === "j" || key.downArrow) setSelection((value) => value + 1);
    if (input === "k" || key.upArrow) setSelection((value) => Math.max(0, value - 1));
    if (key.return && cursor >= 0) {
      execFile("open", [pullRequestUrl(repo.owner, repo.name, selectable[cursor]!)]);
    }
    if (input === "o" && queue) execFile("open", [queue.url]);
    if (input === "n") notify("mergeq 🚀", "notifications are working");
  });

  if (error instanceof SetupError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text backgroundColor="cyan" color="black" bold>
            {" mergeq "}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">✗ {error.message}</Text>
          {error.hint.map((line) => (
            <Text key={line} color="gray">
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  const groups: { ahead: number; entry: Entry }[] = [];
  let walked = 0;
  for (const entry of mine) {
    groups.push({ ahead: entry.position - 1 - walked, entry });
    walked = entry.position;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text backgroundColor="cyan" color="black" bold>
          {" mergeq "}
        </Text>
        <Text> </Text>
        <Text bold>
          {target.owner}/{target.name}
        </Text>
        <Text color="gray"> → {target.branch}</Text>
        <Box flexGrow={1} />
        <Text color="gray" dimColor>
          {width >= 96
            ? `↑↓ pick · ⏎ open · ${showAll ? "a mine" : "a all"} · n test · r refresh · q quit`
            : ""}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={fetching ? "cyan" : "gray"}>{fetching ? spinner : "·"} </Text>
        {queue ? (
          <Text>
            <Text bold>{queue.totalCount}</Text>
            <Text color="gray"> in queue · </Text>
            <Text>{busy.emoji} </Text>
            <Text color={busy.color}>{busy.label}</Text>
            {rate ? (
              <Text color="gray">
                {" "}
                · merging every ~{minutes(rate.gapMinutes)}
                {rate.spanHours > 6 ? " (rough)" : ""}
              </Text>
            ) : null}
          </Text>
        ) : (
          <Text color="gray">connecting…</Text>
        )}
        <Box flexGrow={1} />
        {error ? <Text color="red">retrying…</Text> : null}
        {!error && stale ? (
          <Text color="yellow" dimColor>
            last update {ago(updatedAt!, now)} ago
          </Text>
        ) : null}
      </Box>

      {showAll ? (
        <Box flexDirection="column" marginTop={1}>
          {entries.map((entry, index) => (
            <React.Fragment key={entry.pullRequest.number}>
              {index === buildWindow && buildWindow > 0 ? (
                <Text color="gray" dimColor>
                  {"─".repeat(24)} not building yet
                </Text>
              ) : null}
              <AllRow
                entry={entry}
                mine={entry.pullRequest.author?.login === viewer}
                repo={repo}
                now={now}
              />
            </React.Fragment>
          ))}
        </Box>
      ) : (
        <>
          {mine.length > 0 ? (
            <Box flexDirection="column">
              <Section title="YOURS" />
              {groups.map(({ ahead, entry }, index) => (
                <React.Fragment key={entry.pullRequest.number}>
                  {ahead > 0 ? <Ahead count={ahead} rate={rate} width={width} /> : null}
                  <Mine
                    entry={entry}
                    checks={entry.headCommit ? checks.get(entry.headCommit.oid) : undefined}
                    rate={rate}
                    building={entry.position <= buildWindow}
                    spinner={spinner}
                    repo={repo}
                    here={cursor === index}
                    now={now}
                  />
                </React.Fragment>
              ))}
            </Box>
          ) : queue ? (
            <Empty depth={queue.totalCount} rate={rate} outcomes={outcomes} now={now} />
          ) : null}

          <Recently
            outcomes={outcomes}
            repo={repo}
            selected={cursor - mine.length}
            now={now}
          />
          {mine.length > 0 ? <Events events={events} now={now} /> : null}
        </>
      )}
    </Box>
  );
}
