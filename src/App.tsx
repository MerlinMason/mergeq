import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Spacer, Text, useAnimation, useApp, useInput, useWindowSize } from "ink";
import Gradient from "ink-gradient";
import { TitledBox, titleStyles } from "@mishieck/ink-titled-box";
import { useQueue, type Target } from "./useQueue.js";
import { usePoll } from "./usePoll.js";
import { notify } from "./notify.js";
import { SetupError } from "./auth.js";
import { link, openUrl, pullRequestUrl } from "./link.js";
// Inlined at build time, so it reports the version of this build rather than
// whatever package.json happens to sit next to it.
import { version } from "../package.json" with { type: "json" };
import {
  act,
  fetchOutcomes,
  fetchRate,
  outcomeKey,
  type Action,
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

const RECENT_LIMIT = 6;

const STARTED_AT = Date.now();

// The queue actions are only offered when one of yours is selected, so the line
// only mentions them then. The help text lists everything.
const keyHints = (actions: boolean) =>
  `↑↓ pick · ⏎  open PR${actions ? " · d remove · f front" : ""} · a toggle all/yours · o open queue · q quit`;

export const KEY_HINTS = keyHints(true);

function Spinner({ color }: { color: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return <Text color={color}>{SPINNER[frame % SPINNER.length]}</Text>;
}

const REASONS: Record<string, { emoji: string; label: string }> = {
  merged: { emoji: "🔀", label: "shipped" },
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
  if (depth <= 1) return { emoji: "🧊", label: "chill", color: "cyan" };
  if (depth <= 4) return { emoji: "🍳", label: "warming up", color: "green" };
  if (depth <= 9) return { emoji: "🥵", label: "getting spicy", color: "yellow" };
  return { emoji: "🔥", label: "absolute carnage", color: "red" };
}

const NOTHING_QUEUED = [
  "Nothing of yours in the queue — yassify something 💅",
  "Nothing of yours in the queue — make something magic ✨",
  "Nothing of yours in the queue — crank up the slay 👑",
  "Nothing of yours in the queue — get ticket-maxxing 🚢",
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

function etaLabel(entry: Entry, rate: Rate | null): string {
  return `🔀 in ~${minutes(eta(entry.position, rate, entry.estimatedTimeToMerge))}`;
}

const ETA_WIDTH = "🔀 in ~".length + 1 + "10h30m".length;

// root paddingX (2) + panel border (2) + panel paddingX (2)
const PANEL_CHROME = 6;

const NOT_BUILDING = `${"─".repeat(24)} not building yet`;

function PrLink({
  repo,
  number,
  width,
  color,
  bold,
  underline,
}: {
  repo: { owner: string; name: string };
  number: number;
  width: number;
  color?: string;
  bold?: boolean;
  underline?: boolean;
}) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={color} bold={bold} underline={underline}>
        {link(`#${number}`, pullRequestUrl(repo.owner, repo.name, number))}
      </Text>
    </Box>
  );
}

const AHEAD_GUTTER = 4;

function Ahead({ count, rate, inner }: { count: number; rate: Rate | null; inner: number }) {
  const wait = rate ? rate.gapMinutes * count : null;
  const label = `${count} ahead`;
  const right = wait === null ? "" : `~${minutes(wait)}`;
  const spent = AHEAD_GUTTER + label.length + 1 + (right ? right.length + 1 : 0);

  return (
    <Box>
      <Box width={AHEAD_GUTTER} flexShrink={0}>
        <Text dimColor>{"  ⋯"}</Text>
      </Box>
      <Text dimColor>
        {label} {"─".repeat(Math.max(3, inner - spent))}
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
}: {
  entry: Entry;
  checks: Checks | undefined;
  rate: Rate | null;
  building: boolean;
  repo: { owner: string; name: string };
  here: boolean;
}) {
  const state = STATES[entry.state];
  const first = entry.position === 1;
  const detail = first || (checks !== undefined && checks.total > 0);

  const accent = building ? "cyan" : undefined;

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
        <PrLink
          repo={repo}
          number={entry.pullRequest.number}
          width={8}
          color={accent}
          bold
          underline={here}
        />
        <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
          <Text bold={first} wrap="truncate">
            {entry.pullRequest.title}
          </Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text color="gray">pos {entry.position}</Text>
        </Box>
        <Box width={ETA_WIDTH} flexShrink={0} justifyContent="flex-end">
          <Text color={first ? "green" : "cyan"}>{etaLabel(entry, rate)}</Text>
        </Box>
      </Box>

      {detail ? (
        <Box marginLeft={4}>
          {first ? (
            <Text color="green" bold>
              🔀 you&apos;re up next{" "}
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
                <Text dimColor wrap="truncate">
                  {" "}
                  · {checks.running}
                </Text>
              ) : null}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function Recently({
  outcomes,
  repo,
  selected,
  showAuthor,
  error,
  loading,
  now,
}: {
  outcomes: Outcome[];
  repo: { owner: string; name: string };
  selected: Outcome | null;
  showAuthor: boolean;
  error: Error | null;
  loading: boolean;
  now: number;
}) {
  const title = showAuthor ? "ALL RECENT" : "YOUR RECENT";

  if (outcomes.length === 0) {
    if (loading) {
      return (
        <Panel title={title}>
          <Box>
            <Spinner color="cyan" />
            <Text dimColor> looking…</Text>
          </Box>
        </Panel>
      );
    }
    if (!error) {
      return (
        <Panel title={title}>
          <Text dimColor>
            {showAuthor
              ? "Nothing has left the queue lately"
              : "Nothing of yours has left the queue lately"}
          </Text>
        </Panel>
      );
    }
    return (
      <Panel title={title}>
        <Text color="red">✗ {error.message}</Text>
        {error instanceof SetupError && error.hint[0] ? (
          <Text dimColor>{error.hint[0]}</Text>
        ) : null}
      </Panel>
    );
  }
  return (
    <Panel title={title}>
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
            <PrLink
              repo={repo}
              number={outcome.number}
              width={8}
              bold={here}
              underline={here}
            />
            <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={2}>
              <Text wrap="truncate" bold={here} dimColor={!here}>
                {outcome.title}
              </Text>
            </Box>
            {showAuthor ? (
              <Box width={14} marginRight={2} flexShrink={0}>
                <Text dimColor wrap="truncate">
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
      <Text>{greeting}</Text>
      {lastMerge ? (
        <Text dimColor>
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
  rate,
}: {
  entry: Entry;
  mine: boolean;
  repo: { owner: string; name: string };
  rate: Rate | null;
}) {
  const state = STATES[entry.state];
  const author = entry.pullRequest.author?.login ?? "unknown";
  return (
    <Box>
      <Box width={3} marginRight={1} flexShrink={0}>
        <Text color={mine ? "cyan" : "gray"}>{String(entry.position).padStart(2)}</Text>
      </Box>
      <Box marginRight={1} flexShrink={0}>
        <PrLink
          repo={repo}
          number={entry.pullRequest.number}
          width={7}
          color={mine ? "cyan" : undefined}
          bold={mine}
        />
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
      <Box width={ETA_WIDTH} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {etaLabel(entry, rate)}
        </Text>
      </Box>
    </Box>
  );
}

const BRAND = "fruit";

// figlet "Future Thin", frozen so the binary needs no font files at runtime
const WORDMARK = [
  "┌┬┐┌─╴┌─┐┌─╴┌─╴┌─┐╷ ╷┌─╴╷ ╷┌─╴",
  "│││├╴ ├┬┘│╶┐├╴ │┐││ │├╴ │ │├╴ ",
  "╵ ╵└─╴╵└╴└─┘└─╴└┴┘└─┘└─╴└─┘└─╴",
].join("\n");

const Wordmark = React.memo(function Wordmark() {
  return (
    <Gradient name={BRAND}>
      <Text>{WORDMARK}</Text>
    </Gradient>
  );
});

const Rule = React.memo(function Rule({ width }: { width: number }) {
  return (
    <Gradient name={BRAND}>
      <Text dimColor>{"─".repeat(Math.max(10, width - 2))}</Text>
    </Gradient>
  );
});

const Badge = React.memo(function Badge() {
  return (
    <Gradient name={BRAND}>
      <Text bold>mergequeue</Text>
    </Gradient>
  );
});

const CONSEQUENCE: Record<Action, string[]> = {
  remove: [
    "It leaves the queue and stops building. The checks it has already",
    "run are discarded.",
    " ",
    "You can queue it again afterwards, from the back.",
  ],
  jump: [
    "It goes to the front, so it merges next and everything currently",
    "ahead of it waits longer.",
    " ",
    "Jumping requeues it, so its checks start again from a new base.",
  ],
};

function Confirm({
  action,
  entry,
  depth,
  width,
  pending,
  error,
}: {
  action: Action;
  entry: Entry;
  depth: number;
  width: number;
  pending: boolean;
  error: Error | null;
}) {
  const remove = action === "remove";
  const accent = remove ? "red" : "yellow";
  const verb = remove ? "Remove" : "Move";
  const where = remove ? "from the queue" : "to the front of the queue";

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Rule width={width} />

      <Box marginTop={2} marginLeft={2} flexDirection="column">
        <Box>
          <Text color={accent} bold>
            {verb} #{entry.pullRequest.number}{" "}
          </Text>
          <Text bold>{where}?</Text>
        </Box>

        <Box marginTop={1}>
          <Text wrap="truncate">{entry.pullRequest.title}</Text>
        </Box>
        <Text dimColor>
          position {entry.position} of {depth}
        </Text>

        <Box marginTop={2} flexDirection="column">
          {CONSEQUENCE[action].map((line, index) => (
            <Text key={index} dimColor>
              {line}
            </Text>
          ))}
        </Box>

        <Box marginTop={2}>
          {pending ? (
            <Box>
              <Spinner color={accent} />
              <Text dimColor> asking GitHub…</Text>
            </Box>
          ) : error ? (
            <Box flexDirection="column">
              <Text color="red">✗ {error.message}</Text>
              <Text dimColor>esc go back</Text>
            </Box>
          ) : (
            <Text>
              <Text color={accent} bold>
                ⏎ yes,{" "}
              </Text>
              <Text color={accent} bold>
                {remove ? "remove it" : "jump the queue"}
              </Text>
              <Text dimColor>{"     "}esc leave it alone</Text>
            </Text>
          )}
        </Box>
      </Box>
    </Box>
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
  const { queue, viewer, checks, error, fetching, updatedAt } = useQueue(target, interval);
  const [now, setNow] = useState(Date.now());
  const [showAll, setShowAll] = useState(all);
  const [selection, setSelection] = useState(0);
  const [confirming, setConfirming] = useState<{ action: Action; entry: Entry } | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);

  const loadOutcomes = useCallback(
    () => fetchOutcomes({ ...target, login: showAll ? undefined : viewer }),
    [target, viewer, showAll],
  );
  const loadRate = useCallback(() => fetchRate(target), [target]);

  const { data: outcomeData, error: outcomeError } = usePoll(
    viewer ? loadOutcomes : null,
    60_000,
  );
  const { data: rate } = usePoll(loadRate, 300_000);
  const outcomes = outcomeData ?? NO_OUTCOMES;
  const outcomesLoading = Boolean(viewer) && outcomeData === null && !outcomeError;

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
      if (outcome.at.getTime() < STARTED_AT) continue;

      const reason = reasonOf(outcome.reason);
      if (outcome.kind === "merged") {
        notify(`🔀 #${outcome.number} shipped`, outcome.title);
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

  const recent = outcomes.slice(0, RECENT_LIMIT);
  const selectable: { number: number; outcome: Outcome | null }[] = [
    ...mine.map((entry) => ({ number: entry.pullRequest.number, outcome: null })),
    ...recent.map((outcome) => ({ number: outcome.number, outcome })),
  ];
  const selected =
    selectable.length === 0
      ? null
      : selectable[Math.min(selection, selectable.length - 1)]!;
  const selectedEntry = selected?.outcome === null ? selected.number : null;
  const selectedOutcome = selected?.outcome ?? null;

  // The entry the queue actions would apply to: yours, and still in the queue.
  // Restricted to your own while the behaviour of jumping is unverified — being
  // wrong about somebody else's pull request costs them their afternoon.
  const actionable = mine.find((entry) => entry.pullRequest.number === selectedEntry) ?? null;

  const run = useCallback(
    async (action: Action, entry: Entry) => {
      setActing(true);
      setActionError(null);
      try {
        await act({ token: target.token, action, pullRequestId: entry.pullRequest.id });
        setConfirming(null);
      } catch (caught) {
        setActionError(caught as Error);
      } finally {
        setActing(false);
      }
    },
    [target.token],
  );

  useInput((input, key) => {
    if (confirming) {
      if (acting) return;
      if (key.escape || input === "q") {
        setConfirming(null);
        setActionError(null);
        return;
      }
      if (key.return && !actionError) void run(confirming.action, confirming.entry);
      return;
    }

    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
    if (input === "a") setShowAll((value) => !value);
    if (input === "j" || key.downArrow)
      setSelection((value) => Math.min(value + 1, Math.max(0, selectable.length - 1)));
    if (input === "k" || key.upArrow) setSelection((value) => Math.max(0, value - 1));
    if (key.return && selected) openUrl(pullRequestUrl(target.owner, target.name, selected.number));
    if (input === "o" && queue) openUrl(queue.url);
    if (input === "d" && actionable) setConfirming({ action: "remove", entry: actionable });
    if (input === "f" && actionable) setConfirming({ action: "jump", entry: actionable });
  });

  if (confirming) {
    return (
      <Confirm
        action={confirming.action}
        entry={confirming.entry}
        depth={queue?.totalCount ?? 0}
        width={width}
        pending={acting}
        error={actionError}
      />
    );
  }

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


  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Rule width={width} />

      <Box>
        <Wordmark />
        <Spacer />
        <Text dimColor>v{version}</Text>
      </Box>

      <Box>
        <Text bold>
          {target.owner}/{target.name}
        </Text>
        <Text dimColor>
          {" "}
          → {target.branch}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor wrap="truncate">
          {keyHints(actionable !== null)}
        </Text>
      </Box>

      <Panel title="QUEUE">
        <Box>
          {queue ? (
            <Text>
              <Text bold>
                {queue.totalCount}
              </Text>
              <Text dimColor>
                {" "}
                queued
              </Text>
              <Text dimColor>
                {"   "}
              </Text>
              <Text>{busy.emoji} </Text>
              <Text color={busy.color}>{busy.label}</Text>
              {rate ? (
                <Text dimColor>
                  {"   "}join now 🔀 in ~
                  {minutes((queue.totalCount + 1) * rate.gapMinutes)}
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
            <Text>Nothing in the queue — everyone must be at the pub 🍺</Text>
          ) : (
            entries.map((entry, index) => (
            <React.Fragment key={entry.pullRequest.number}>
              {index === buildWindow && buildWindow > 0 ? (
                <Text dimColor>
                  {NOT_BUILDING}
                </Text>
              ) : null}
              <AllRow
                entry={entry}
                mine={entry.pullRequest.author?.login === viewer}
                repo={target}
                rate={rate}
              />
            </React.Fragment>
            ))
          )
        ) : mine.length > 0 ? (
          groups.map(({ ahead, entry }) => (
            <React.Fragment key={entry.pullRequest.number}>
              {ahead > 0 ? <Ahead count={ahead} rate={rate} inner={width - PANEL_CHROME} /> : null}
              <Mine
                entry={entry}
                checks={entry.headCommit ? checks.get(entry.headCommit.oid) : undefined}
                rate={rate}
                building={entry.position <= buildWindow}
                repo={target}
                here={entry.pullRequest.number === selectedEntry}
              />
            </React.Fragment>
          ))
        ) : queue ? (
          <Empty outcomes={outcomes} now={now} />
        ) : null}
      </Panel>

      <Recently
        outcomes={recent}
        repo={target}
        selected={selectedOutcome}
        showAuthor={showAll}
        error={outcomeError}
        loading={outcomesLoading}
        now={now}
      />
    </Box>
  );
}
