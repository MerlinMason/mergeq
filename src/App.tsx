import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Spacer, Text, useAnimation, useApp, useInput, useWindowSize } from "ink";
import Gradient from "ink-gradient";
import { TitledBox, titleStyles } from "@mishieck/ink-titled-box";
import { useQueue, type Event, type Target } from "./useQueue.js";
import { usePoll } from "./usePoll.js";
import { notify } from "./notify.js";
import { SetupError } from "./auth.js";
import { link, openUrl, pullRequestUrl } from "./link.js";
import {
  fetchOutcomes,
  fetchRate,
  outcomeKey,
  RECENT_LIMIT,
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

const NO_OUTCOMES: Outcome[] = [];

function Spinner({ color }: { color: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return <Text color={color}>{SPINNER[frame % SPINNER.length]}</Text>;
}

const REASONS: Record<string, { emoji: string; label: string }> = {
  merged: { emoji: "🚀", label: "shipped" },
  failed_checks: { emoji: "💥", label: "failed" },
  merge_conflict: { emoji: "🥊", label: "conflict" },
  manual: { emoji: "✋", label: "yanked" },
  queue_cleared: { emoji: "🧹", label: "cleared" },
  branch_protections: { emoji: "🚧", label: "blocked" },
  invalid_merge_commit: { emoji: "🫠", label: "bad commit" },
};

const STATUS_WIDTH =
  2 + 1 + Math.max(...Object.values(REASONS).map((r) => r.label.length)) + " 10h ago".length;

function reasonOf(reason: string): { emoji: string; label: string } {
  return REASONS[reason] ?? { emoji: "😭", label: reason.replace(/_/g, " ") };
}

function busyness(depth: number): { emoji: string; label: string; color: string } {
  if (depth === 0) return { emoji: "🌙", label: "dead quiet", color: "green" };
  if (depth <= 4) return { emoji: "🍃", label: "ticking over", color: "green" };
  if (depth <= 9) return { emoji: "🚦", label: "getting spicy", color: "yellow" };
  return { emoji: "🌋", label: "absolute carnage", color: "red" };
}

const NOTHING_QUEUED = [
  "💅 nothing of yours in the queue — yassify something",
  "✨ nothing of yours in the queue — make something magic",
  "👑 nothing of yours in the queue — crank up the slay",
];

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

const BAR_WIDTH = 10;

function bar(done: number, total: number): string {
  if (total === 0) return "░".repeat(BAR_WIDTH);
  const filled = Math.round((done / total) * BAR_WIDTH);
  return "▓".repeat(filled) + "░".repeat(Math.max(0, BAR_WIDTH - filled));
}

function eta(position: number, rate: Rate | null, fallback: number | null): number | null {
  if (rate) return position * rate.gapMinutes;
  return fallback === null ? null : fallback / 60;
}

function Ahead({
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

function Mine({
  entry,
  checks,
  rate,
  building,
  repo,
  here,
  now,
}: {
  entry: Entry;
  checks: Checks | undefined;
  rate: Rate | null;
  building: boolean;
  repo: { owner: string; name: string };
  here: boolean;
  now: number;
}) {
  const state = STATES[entry.state];
  const first = entry.position === 1;
  const estimate = eta(entry.position, rate, entry.estimatedTimeToMerge);
  const waiting = ago(new Date(entry.enqueuedAt), now);

  const accent = first ? "green" : building ? "cyan" : "white";

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color="cyan" bold>
            {here ? "▸" : " "}
          </Text>
        </Box>
        <Box width={2} flexShrink={0}>
          {first ? (
            <Text color="green">▶</Text>
          ) : building ? (
            <Spinner color="cyan" />
          ) : (
            <Text color={state.color}>{state.glyph}</Text>
          )}
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
        <Spacer />
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
  showAuthor,
  now,
}: {
  outcomes: Outcome[];
  repo: { owner: string; name: string };
  selected: Outcome | null;
  showAuthor: boolean;
  now: number;
}) {
  if (outcomes.length === 0) return null;
  return (
    <Panel title="RECENTLY">
      {outcomes.map((outcome) => {
        const merged = outcome.kind === "merged";
        const reason = reasonOf(outcome.reason);
        const here = outcome === selected;
        return (
          <Box key={outcomeKey(outcome)}>
            <Box width={4} flexShrink={0}>
              <Text color="cyan" bold>
                {here ? "▸" : " "}
              </Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text color="white" bold={here} underline={here}>
                {link(`#${outcome.number}`, pullRequestUrl(repo.owner, repo.name, outcome.number))}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={2}>
              <Text wrap="truncate" color={here ? "whiteBright" : undefined} dimColor={!here}>
                {outcome.title}
              </Text>
            </Box>
            {showAuthor ? (
              <Box width={14} marginRight={2} flexShrink={0}>
                <Text color="gray" dimColor wrap="truncate">
                  {outcome.author}
                </Text>
              </Box>
            ) : null}
            <Box width={STATUS_WIDTH} flexShrink={0}>
              <Text color={merged ? "gray" : "red"} dimColor={merged} wrap="truncate">
                {reason.emoji} {merged ? "" : `${reason.label} `}
                {ago(outcome.at, now)} ago
              </Text>
            </Box>
          </Box>
        );
      })}
    </Panel>
  );
}

function Empty({ outcomes, now }: { outcomes: Outcome[]; now: number }) {
  const lastMerge = outcomes.find((o) => o.kind === "merged");
  const [greeting] = useState(
    () => NOTHING_QUEUED[Math.floor(Math.random() * NOTHING_QUEUED.length)]!,
  );
  return (
    <>
      <Text color="white">{greeting}</Text>
      {lastMerge ? (
        <Text color="gray" dimColor>
          You last shipped #{lastMerge.number} · {ago(lastMerge.at, now)} ago
        </Text>
      ) : null}
    </>
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
    <Panel title="ACTIVITY">
      {events.slice(0, 3).map((event) => (
        <Box key={event.id}>
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
    </Panel>
  );
}

const BRAND = "fruit";

const PANEL_CHROME = 6;

const WORDMARK = ["┌┬┐┌─╴┌─┐┌─╴┌─╴┌─┐", "│││├╴ ├┬┘│╶┐├╴ │┐│", "╵ ╵└─╴╵└╴└─┘└─╴└┴┘"].join("\n");

function Wordmark() {
  return (
    <Gradient name={BRAND}>
      <Text>{WORDMARK}</Text>
    </Gradient>
  );
}

function Rule({ width }: { width: number }) {
  return (
    <Gradient name={BRAND}>
      <Text dimColor>{"─".repeat(Math.max(10, width - 2))}</Text>
    </Gradient>
  );
}

function Badge() {
  return (
    <Gradient name={BRAND}>
      <Text bold>mergeq</Text>
    </Gradient>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <TitledBox
      borderStyle="round"
      borderColor="gray"
      titles={[title]}
      titleStyles={titleStyles.rectangle}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      {children}
    </TitledBox>
  );
}

export default function App({
  target,
  interval,
  all,
}: {
  target: Target;
  interval: number;
  all: boolean;
}) {
  const { exit } = useApp();
  const { columns: width } = useWindowSize();
  const { queue, viewer, checks, events, error, fetching, updatedAt } = useQueue(target, interval);
  const [now, setNow] = useState(Date.now());
  const [showAll, setShowAll] = useState(all);
  const [selection, setSelection] = useState(0);

  const loadOutcomes = useCallback(
    () => fetchOutcomes({ ...target, login: showAll ? undefined : viewer }),
    [target, viewer, showAll],
  );
  const loadRate = useCallback(() => fetchRate(target), [target]);

  const outcomes = usePoll(viewer ? loadOutcomes : null, 60_000) ?? NO_OUTCOMES;
  const rate = usePoll(loadRate, 300_000);

  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (outcomes.length === 0) return;

    if (seen.current === null) {
      seen.current = new Set(outcomes.map(outcomeKey));
      return;
    }

    for (const outcome of outcomes) {
      const key = outcomeKey(outcome);
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (outcome.author !== viewer) continue;

      const reason = reasonOf(outcome.reason);
      if (outcome.kind === "merged") {
        notify(`🚀 #${outcome.number} shipped`, outcome.title);
      } else {
        notify(
          `${reason.emoji} #${outcome.number} out of the queue`,
          `${reason.label} — ${outcome.title}`,
        );
      }
    }
  }, [outcomes, viewer]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const stale = updatedAt !== null && now - updatedAt.getTime() > 30_000;
  const entries = queue?.entries ?? [];
  const mine = entries.filter((entry) => entry.pullRequest.author?.login === viewer);
  const buildWindow = queue?.maximumEntriesToBuild ?? 0;
  const busy = busyness(queue?.totalCount ?? 0);

  const selectable: { number: number; outcome: Outcome | null }[] = [
    ...mine.map((entry) => ({ number: entry.pullRequest.number, outcome: null })),
    ...outcomes.map((outcome) => ({ number: outcome.number, outcome })),
  ];
  const selected =
    selectable.length === 0
      ? null
      : selectable[Math.min(selection, selectable.length - 1)]!;
  const selectedEntry = selected?.outcome === null ? selected.number : null;
  const selectedOutcome = selected?.outcome ?? null;

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
    if (input === "a") setShowAll((value) => !value);
    if (input === "j" || key.downArrow) setSelection((value) => value + 1);
    if (input === "k" || key.upArrow) setSelection((value) => Math.max(0, value - 1));
    if (key.return && selected) openUrl(pullRequestUrl(target.owner, target.name, selected.number));
    if (input === "o" && queue) openUrl(queue.url);
  });

  if (error instanceof SetupError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Badge />
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

  const hints = "↑↓ pick · ⏎  open PR · a toggle all/mine · o open queue · q quit";

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Rule width={width} />

      <Wordmark />

      <Box>
        <Text bold>
          {target.owner}/{target.name}
        </Text>
        <Text color="gray" dimColor>
          {" "}
          → {target.branch}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray" dimColor wrap="truncate">
          {hints}
        </Text>
      </Box>

      <Panel title="QUEUE">
        <Box>
          {queue ? (
            <Text>
              <Text bold color="whiteBright">
                {queue.totalCount}
              </Text>
              <Text color="gray" dimColor>
                {" "}
                queued
              </Text>
              <Text color="gray" dimColor>
                {"   "}
              </Text>
              <Text>{busy.emoji} </Text>
              <Text color={busy.color}>{busy.label}</Text>
              {rate ? (
                <Text color="gray" dimColor>
                  {"   "}~{minutes(rate.gapMinutes)} between merges
                </Text>
              ) : null}
            </Text>
          ) : (
            <Text color="gray">connecting…</Text>
          )}
          <Spacer />
          {error ? <Text color="red">retrying… </Text> : null}
          {!error && stale ? (
            <Text color="yellow" dimColor>
              last update {ago(updatedAt!, now)} ago{" "}
            </Text>
          ) : null}
          {fetching ? <Spinner color="cyan" /> : <Text> </Text>}
        </Box>

        <Box marginY={1}>
          <Text color="gray">{"─".repeat(Math.max(10, width - PANEL_CHROME))}</Text>
        </Box>

        {showAll ? (
          queue && entries.length === 0 ? (
            <Text color="white">🍺 nothing in the queue — everyone must be at the pub</Text>
          ) : (
            entries.map((entry, index) => (
            <React.Fragment key={entry.pullRequest.number}>
              {index === buildWindow && buildWindow > 0 ? (
                <Text color="gray" dimColor>
                  {"─".repeat(24)} not building yet
                </Text>
              ) : null}
              <AllRow
                entry={entry}
                mine={entry.pullRequest.author?.login === viewer}
                repo={target}
                now={now}
              />
            </React.Fragment>
            ))
          )
        ) : mine.length > 0 ? (
          groups.map(({ ahead, entry }) => (
            <React.Fragment key={entry.pullRequest.number}>
              {ahead > 0 ? (
                <Ahead count={ahead} rate={rate} width={width - PANEL_CHROME + 2} />
              ) : null}
              <Mine
                entry={entry}
                checks={entry.headCommit ? checks.get(entry.headCommit.oid) : undefined}
                rate={rate}
                building={entry.position <= buildWindow}
                repo={target}
                here={entry.pullRequest.number === selectedEntry}
                now={now}
              />
            </React.Fragment>
          ))
        ) : queue ? (
          <Empty outcomes={outcomes} now={now} />
        ) : null}
      </Panel>

      <Recently
        outcomes={outcomes}
        repo={target}
        selected={selectedOutcome}
        showAuthor={showAll}
        now={now}
      />
      {!showAll && mine.length > 0 ? <Events events={events} now={now} /> : null}
    </Box>
  );
}
