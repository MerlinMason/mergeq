import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Spacer, Text, useAnimation, useApp, useInput, useWindowSize } from "ink";
import Gradient from "ink-gradient";
import stringWidth from "string-width";
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
  fetchPrs,
  fetchRate,
  fetchReviews,
  outcomeKey,
  PR_FETCH_LIMIT,
  type Action,
  type Checks,
  type Entry,
  type EntryState,
  type Outcome,
  type Pr,
  type Rate,
  type Review,
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
const NO_REVIEWS: Review[] = [];

const RECENT_LIMIT = 6;
const REVIEW_LIMIT = 6;
const PR_LIMIT = 5;

const STARTED_AT = Date.now();

// Offered only for your own entries, so listed only when one is selected — and
// appended, so the keys that are always there never move.
const keyHints = (actionable: boolean) =>
  `↑↓ pick · ⏎  open PR · a toggle all/yours · o open queue · q quit${actionable ? " · e eject · j jump" : ""}`;

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

// Measured in terminal columns, not code units: an emoji is two columns wide and
// a variation selector adds units without adding width.
const STATUS_WIDTH =
  stringWidth("🔀 ") +
  Math.max(...Object.values(REASONS).map((r) => stringWidth(r.label))) +
  stringWidth(" 10h ago");

function reasonOf(reason: string): { emoji: string; label: string } {
  return REASONS[reason] ?? { emoji: "😭", label: reason.replace(/_/g, " ") };
}

function busyness(depth: number): { emoji: string; label: string; color: string } {
  if (depth <= 1) return { emoji: "🧊", label: "chill", color: "cyan" };
  if (depth <= 4) return { emoji: "🍳", label: "warming up", color: "green" };
  if (depth <= 9) return { emoji: "🥵", label: "getting spicy", color: "yellow" };
  return { emoji: "🔥", label: "absolute carnage", color: "red" };
}

const NOTHING_TO_REVIEW = [
  "Nobody is waiting on you — inbox zero, king 👑",
  "No reviews in the pile — dangerously caught up 🫡",
  "Review queue empty — go and touch some grass 🌱",
  "Nobody needs you right now. Devastating 💅",
  "Zero reviews waiting — unemployed behaviour 😌",
  "Not a single review — unbothered, moisturised 🧴",
];

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

const ETA_WIDTH = stringWidth("🔀 in ~") + 1 + stringWidth("10h30m");

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

// The three list panels all lead with these, so the arithmetic that decides how
// much title fits reads the same numbers the markup draws.
const CURSOR_WIDTH = 4;
const NUMBER_WIDTH = 8;
const GAP = 2;

function RowHead({
  repo,
  number,
  title,
  here,
  dim,
}: {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  here: boolean;
  dim?: boolean;
}) {
  return (
    <>
      <Box width={CURSOR_WIDTH} flexShrink={0}>
        <Text color="cyan" bold>
          {here ? "▸" : " "}
        </Text>
      </Box>
      <PrLink repo={repo} number={number} width={NUMBER_WIDTH} bold={here} underline={here} />
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={GAP}>
        <Text wrap="truncate" bold={here} dimColor={dim}>
          {title}
        </Text>
      </Box>
    </>
  );
}

// Three panels say the same three things while they have no rows to show.
function Fallback({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: Error | null;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <Box>
        <Spinner color="cyan" />
        <Text dimColor> looking…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <>
        <Text color="red">✗ {error.message}</Text>
        {error instanceof SetupError && error.hint[0] ? <Text dimColor>{error.hint[0]}</Text> : null}
      </>
    );
  }

  return <Text dimColor>{children}</Text>;
}

// Measured in terminal columns, not code units, so a two-column glyph does not
// shift the column it sits in.
function statusWidth(states: { label: string }[]): number {
  return stringWidth("✓ ") + Math.max(...states.map((state) => stringWidth(state.label)));
}

function Status({
  state,
  width,
}: {
  state: { glyph: string; label: string; color: string; dim: boolean };
  width: number;
}) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={state.color} dimColor={state.dim} wrap="truncate">
        {state.glyph} {state.label}
      </Text>
    </Box>
  );
}

// null is "more than were counted" — the repository has more open pull requests
// than one page, so saying a number would be quoting the page size back.
function More({ hidden }: { hidden: number | null }) {
  if (hidden !== null && hidden <= 0) return null;
  return (
    <Box marginLeft={CURSOR_WIDTH}>
      <Text dimColor>…and {hidden ?? "plenty"} more</Text>
    </Box>
  );
}

// A queue entry keeps its number one level down; everything else in a list
// carries it directly.
type Selectable = Entry | Pr | Review | Outcome;

function numberOf(item: Selectable): number {
  return "pullRequest" in item ? item.pullRequest.number : item.number;
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

// Shared by the two list panels: cursor, number, title, then a right-hand side
// of fixed columns.
const AUTHOR_WIDTH = 12;
const REVIEWER_WIDTH = 14;
const AGE_WIDTH = 4;

// A title truncated to a handful of words says nothing, so the columns beside it
// are given up in order of how much each earns its space.
const TITLE_FLOOR = 24;

// Everything a list row spends before its optional columns: the cursor, the
// number, the title's margin, and the age column with its own.
const ROW_FIXED = CURSOR_WIDTH + NUMBER_WIDTH + GAP + AGE_WIDTH + GAP;

// Ordered by what it is asking you to do, which is also the order the panel
// sorts in: ship it, answer them, fix it, then the ones where waiting is the
// only move.
const PR_STATES = {
  approved: { rank: 0, glyph: "✓", label: "approved", color: "green", dim: false },
  changes: { rank: 1, glyph: "±", label: "changes", color: "yellow", dim: false },
  broken: { rank: 2, glyph: "✗", label: "ci red", color: "red", dim: false },
  waiting: { rank: 3, glyph: "○", label: "waiting", color: "cyan", dim: false },
  building: { rank: 4, glyph: "◐", label: "building", color: "yellow", dim: true },
  draft: { rank: 5, glyph: "✎", label: "draft", color: "gray", dim: true },
};

// A draft says draft even when its build is red: you already know, and nobody
// is going to look at it either way.
function prState(own: Pr) {
  if (own.draft) return PR_STATES.draft;
  if (own.decision === "APPROVED") return PR_STATES.approved;
  if (own.decision === "CHANGES_REQUESTED") return PR_STATES.changes;
  if (own.checks === "failing") return PR_STATES.broken;
  if (own.checks === "running") return PR_STATES.building;
  return PR_STATES.waiting;
}

const PR_STATUS_WIDTH = statusWidth(Object.values(PR_STATES));

function YourPrs({
  shown,
  total,
  repo,
  selected,
  showAuthor,
  error,
  loading,
  now,
  inner,
}: {
  shown: Pr[];
  total: number | null;
  repo: { owner: string; name: string };
  selected: Pr | null;
  showAuthor: boolean;
  error: Error | null;
  loading: boolean;
  now: number;
  inner: number;
}) {
  const hidden = total === null ? null : total - shown.length;
  const rows = shown.map((pr) => {
    const state = prState(pr);
    // Whose it is answers the first question about somebody else's pull request;
    // who still owes it a review answers the first question about your own.
    const nobody = !showAuthor && state === PR_STATES.waiting && pr.reviewers.length === 0;
    const beside = showAuthor
      ? pr.author
      : pr.reviewers.length > 0
        ? pr.reviewers.join(" ")
        : nobody
          ? "nobody"
          : "—";
    return { pr, state, nobody, beside };
  });

  // For your own, this column is mostly "—", so it is sized to what is in it
  // rather than to the longest thing that could be, and the title gets the rest.
  const aside = Math.min(REVIEWER_WIDTH, Math.max(0, ...rows.map((r) => stringWidth(r.beside))));
  const spare = inner - ROW_FIXED - PR_STATUS_WIDTH - TITLE_FLOOR;
  const withAside = spare >= aside + GAP;

  const title = showAuthor ? "OPEN PRS" : "YOUR PRS";

  return (
    <Panel title={total ? `${title} · ${total}` : title}>
      {rows.length === 0 ? (
        <Fallback loading={loading} error={error}>
          Nothing open that is not already queued
        </Fallback>
      ) : null}
      {rows.map(({ pr, state, nobody, beside }) => (
        <Box key={pr.number}>
          <RowHead
            repo={repo}
            number={pr.number}
            title={pr.title}
            here={pr === selected}
            dim={pr.draft}
          />
          {withAside ? (
            <Box width={aside} marginRight={GAP} flexShrink={0}>
              <Text color={nobody ? "yellow" : undefined} dimColor wrap="truncate">
                {beside}
              </Text>
            </Box>
          ) : null}
          <Box width={AGE_WIDTH} marginRight={GAP} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>{ago(pr.updatedAt, now)}</Text>
          </Box>
          <Status state={state} width={PR_STATUS_WIDTH} />
        </Box>
      ))}
      <More hidden={hidden} />
    </Panel>
  );
}

const REVIEW_STATES = {
  broken: { glyph: "✗", label: "ci red", color: "red", dim: false },
  changes: { glyph: "±", label: "changes", color: "yellow", dim: false },
  approved: { glyph: "✓", label: "approved", color: "green", dim: true },
  building: { glyph: "◐", label: "building", color: "yellow", dim: true },
  ready: { glyph: "●", label: "ready", color: "green", dim: false },
};

// The one thing worth knowing before you open it: whether opening it now would
// be wasted. A red build or changes already requested means they are still
// working; an approval means it can land without you.
function reviewState(review: Review) {
  if (review.checks === "failing") return REVIEW_STATES.broken;
  if (review.decision === "CHANGES_REQUESTED") return REVIEW_STATES.changes;
  if (review.decision === "APPROVED") return REVIEW_STATES.approved;
  if (review.checks === "running") return REVIEW_STATES.building;
  return REVIEW_STATES.ready;
}

const REVIEW_STATUS_WIDTH = statusWidth(Object.values(REVIEW_STATES));

const DAY = 86_400_000;

function waitColor(waited: number): string {
  if (waited > 3 * DAY) return "red";
  if (waited > DAY) return "yellow";
  return "gray";
}

function lines(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

const SIZE_WIDTH = stringWidth("+99.9k -99.9k");

function ToReview({
  shown,
  total,
  repo,
  selected,
  error,
  loading,
  now,
  inner,
}: {
  shown: Review[];
  total: number;
  repo: { owner: string; name: string };
  selected: Review | null;
  error: Error | null;
  loading: boolean;
  now: number;
  inner: number;
}) {
  const hidden = total - shown.length;
  const [praise] = useState(
    () => NOTHING_TO_REVIEW[Math.floor(Math.random() * NOTHING_TO_REVIEW.length)]!,
  );

  let spare = inner - ROW_FIXED - REVIEW_STATUS_WIDTH - TITLE_FLOOR;
  const withAuthor = spare >= AUTHOR_WIDTH + GAP;
  if (withAuthor) spare -= AUTHOR_WIDTH + GAP;
  const withSize = spare >= SIZE_WIDTH + GAP;

  return (
    <Panel title={total > 0 ? `TO REVIEW · ${total}` : "TO REVIEW"}>
      {shown.length === 0 ? (
        <Fallback loading={loading} error={error}>
          {praise}
        </Fallback>
      ) : null}
      {shown.map((review) => {
        const state = reviewState(review);
        const waited = now - review.requestedAt.getTime();
        return (
          <Box key={review.number}>
            <RowHead
              repo={repo}
              number={review.number}
              title={review.title}
              here={review === selected}
            />
            {withAuthor ? (
              <Box width={AUTHOR_WIDTH} marginRight={GAP} flexShrink={0}>
                <Text dimColor wrap="truncate">
                  {review.author}
                </Text>
              </Box>
            ) : null}
            {withSize ? (
              <Box width={SIZE_WIDTH} marginRight={GAP} flexShrink={0} justifyContent="flex-end">
                <Text>
                  <Text color="green">+{lines(review.additions)}</Text>
                  <Text color="red"> -{lines(review.deletions)}</Text>
                </Text>
              </Box>
            ) : null}
            <Box width={AGE_WIDTH} marginRight={GAP} flexShrink={0} justifyContent="flex-end">
              <Text color={waitColor(waited)} bold={waited > 3 * DAY}>
                {ago(review.requestedAt, now)}
              </Text>
            </Box>
            <Status state={state} width={REVIEW_STATUS_WIDTH} />
          </Box>
        );
      })}
      <More hidden={hidden} />
    </Panel>
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
  return (
    <Panel title={showAuthor ? "ALL RECENT" : "YOUR RECENT"}>
      {outcomes.length === 0 ? (
        <Fallback loading={loading} error={error}>
          {showAuthor
            ? "Nothing has left the queue lately"
            : "Nothing of yours has left the queue lately"}
        </Fallback>
      ) : null}
      {outcomes.map((outcome) => {
        const merged = outcome.kind === "merged";
        const reason = reasonOf(outcome.reason);
        const here = outcome === selected;
        return (
          <Box key={outcomeKey(outcome)}>
            <RowHead
              repo={repo}
              number={outcome.number}
              title={outcome.title}
              here={here}
              dim={!here}
            />
            {showAuthor ? (
              <Box width={REVIEWER_WIDTH} marginRight={GAP} flexShrink={0}>
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

const ACTIONS: Record<Action, { accent: string; verb: string; question: string; consequence: string }> = {
  eject: {
    accent: "red",
    verb: "Eject",
    question: "Take this out of the merge queue?",
    consequence: "Discards the checks it has run. You can queue it again afterwards, from the back.",
  },
  jump: {
    accent: "yellow",
    verb: "Jump",
    question: "Send this to the front of the queue?",
    consequence:
      "It leaves the queue and rejoins at the front, so its checks start again and everything ahead of it waits longer.",
  },
};

export type Confirming = {
  action: Action;
  entry: Entry;
  focused: boolean;
  pending: boolean;
  error: Error | null;
};

// Brackets so the one you are not on still reads as a button rather than as
// prose that happens to sit nearby.
function Button({
  label,
  focused,
  color,
}: {
  label: string;
  focused: boolean;
  color?: string;
}) {
  return (
    <Box marginRight={2}>
      <Text
        inverse={focused}
        color={focused ? color : undefined}
        dimColor={!focused}
        bold={focused}
      >
        {focused ? `  ${label}  ` : `[ ${label} ]`}
      </Text>
    </Box>
  );
}

function Confirm({
  confirm,
  depth,
  width,
}: {
  confirm: Confirming;
  depth: number;
  width: number;
}) {
  const { action, entry, focused, pending, error } = confirm;
  const { accent, verb, question, consequence } = ACTIONS[action];

  const card = Math.min(72, Math.max(48, width - 8));

  return (
    // Anchored where the main view starts, under the same rule, so answering this
    // does not move the whole display.
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Rule width={width} />

      <Box marginTop={1} width={card} flexDirection="column">
        <TitledBox
          borderStyle="round"
          borderColor={accent}
          titles={[verb.toUpperCase()]}
          titleStyles={titleStyles.rectangle}
          flexDirection="column"
          paddingX={1}
        >
          <Text bold>{question}</Text>

          {/* The title is the one thing here somebody else wrote, so it is
              quoted rather than set as if the interface said it. */}
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={accent}>{"│ "}</Text>
              <Text bold>#{entry.pullRequest.number}</Text>
              <Text>{"  "}</Text>
              <Text wrap="truncate">{entry.pullRequest.title}</Text>
            </Box>
            <Box>
              <Text color={accent}>{"│ "}</Text>
              <Text dimColor>
                position {entry.position} of {depth}
              </Text>
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>{consequence}</Text>
          </Box>

          <Box marginTop={1}>
            {pending ? (
              <Box>
                <Spinner color={accent} />
                <Text dimColor> asking GitHub…</Text>
              </Box>
            ) : error ? (
              <Text color="red" wrap="truncate">
                ✗ {error.message}
              </Text>
            ) : (
              <Box>
                <Button label="Cancel" focused={!focused} />
                <Button label={verb} focused={focused} color={accent} />
              </Box>
            )}
          </Box>
        </TitledBox>

        <Box marginTop={1}>
          <Text dimColor>{error ? "esc go back" : "←→ choose · ⏎  select · esc cancel"}</Text>
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
    >
      {children}
    </TitledBox>
  );
}

// The gap between two panels was already a blank row, so the connector that
// makes them read as one pipeline costs no height. It earns the space by
// lighting up when something of yours is about to move down it.
function Flow({ label, color = "cyan" }: { label?: string; color?: string }) {
  return (
    <Box marginLeft={3}>
      <Text color={label ? color : undefined} bold={Boolean(label)} dimColor={!label}>
        ↓{label ? `  ${label}` : ""}
      </Text>
    </Box>
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
  // One piece of state, so focus and errors cannot outlive the dialog that owns
  // them. Kept apart, a successful action left the destructive button focused and
  // the next dialog opened with it already selected.
  const [confirm, setConfirm] = useState<Confirming | null>(null);

  const loadOutcomes = useCallback(
    () => fetchOutcomes({ ...target, login: showAll ? undefined : viewer }),
    [target, viewer, showAll],
  );
  const loadRate = useCallback(() => fetchRate(target), [target]);
  const loadReviews = useCallback(
    () => fetchReviews({ ...target, login: viewer, self: !target.as }),
    [target, viewer],
  );
  const loadPrs = useCallback(
    () => fetchPrs({ ...target, login: showAll ? undefined : viewer }),
    [target, viewer, showAll],
  );

  const {
    data: outcomeData,
    error: outcomeError,
    loading: outcomesLoading,
  } = usePoll(viewer ? loadOutcomes : null, 60_000);
  const { data: rate } = usePoll(loadRate, 300_000);
  const {
    data: reviewData,
    error: reviewError,
    loading: reviewsLoading,
  } = usePoll(viewer ? loadReviews : null, 60_000);
  const {
    data: prData,
    error: prError,
    loading: prLoading,
  } = usePoll(viewer ? loadPrs : null, 60_000);
  const outcomes = outcomeData ?? NO_OUTCOMES;
  const reviews = reviewData ?? NO_REVIEWS;

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

  const asked = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (reviewData === null) return;

    if (asked.current === null) {
      asked.current = new Set(reviewData.map((review) => review.number));
      return;
    }

    for (const review of reviewData) {
      if (asked.current.has(review.number)) continue;
      asked.current.add(review.number);
      if (review.requestedAt.getTime() < STARTED_AT) continue;
      notify(`👀 #${review.number} wants your review`, `${review.author} — ${review.title}`);
    }
  }, [reviewData]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const stale = updatedAt !== null && now - updatedAt.getTime() > 30_000;
  const entries = queue?.entries ?? [];
  const depth = queue?.totalCount ?? 0;
  const mine = entries.filter((entry) => entry.pullRequest.author?.login === viewer);
  const buildWindow = queue?.maximumEntriesToBuild ?? 0;
  const busy = busyness(depth);

  // Once it is in the queue it belongs to the queue panel, which knows where it
  // sits and when it lands. Listing it twice would only ask which one to believe.
  const queued = new Set(entries.map((entry) => entry.pullRequest.number));
  const open = (prData ?? []).filter((pr) => !queued.has(pr.number));

  // Sorting by what it is asking you to do only means something for your own
  // work. Everybody's is a feed, so it keeps the newest-first order it arrived in.
  const prs = showAll
    ? open
    : [...open].sort(
        (a, b) =>
          prState(a).rank - prState(b).rank || b.updatedAt.getTime() - a.updatedAt.getTime(),
      );

  // What is poised to fall through each join, which is what lights the arrow
  // between the two panels it joins.
  const ready = prs.filter((pr) => prState(pr) === PR_STATES.approved).length;
  const landing = mine.some((entry) => entry.position === 1);

  // Sliced once, here, so a panel cannot disagree with the list the cursor walks.
  const recent = outcomes.slice(0, RECENT_LIMIT);
  const toReview = reviews.slice(0, REVIEW_LIMIT);
  const prsShown = prs.slice(0, PR_LIMIT);
  // A full page back means there are more we never saw, so any total we quote
  // would be the page size rather than the repository's.
  const prsCounted = (prData?.length ?? 0) < PR_FETCH_LIMIT;

  // Every row is the object its panel renders, so a panel asks whether it holds
  // the selection rather than matching on a number. Keep this in the order the
  // panels appear, or the cursor jumps about.
  const selectable = [...toReview, ...prsShown, ...mine, ...recent];
  const selected = selectable[Math.min(selection, selectable.length - 1)] ?? null;

  const actionable = mine.find((entry) => entry === selected) ?? null;
  const selectedEntry = actionable?.pullRequest.number ?? null;
  const selectedOutcome = recent.find((outcome) => outcome === selected) ?? null;
  const selectedReview = toReview.find((review) => review === selected) ?? null;
  const selectedPr = prsShown.find((pr) => pr === selected) ?? null;

  // Dismissing the dialog aborts the attempt, so a jump that is waiting to rejoin
  // the queue does not land after somebody has cancelled it.
  const attempt = useRef<AbortController | null>(null);

  const run = useCallback(
    async (pending: Confirming) => {
      attempt.current?.abort();
      const controller = new AbortController();
      attempt.current = controller;

      setConfirm({ ...pending, pending: true, error: null });
      try {
        await act({
          token: target.token,
          action: pending.action,
          pullRequestId: pending.entry.pullRequest.id,
          signal: controller.signal,
        });
        setConfirm(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setConfirm({ ...pending, pending: false, error: caught as Error });
      }
    },
    [target.token],
  );

  const dismiss = useCallback(() => {
    attempt.current?.abort();
    setConfirm(null);
  }, []);

  useInput((input, key) => {
    if (confirm) {
      if (confirm.pending) return;
      if (key.escape || input === "q") return dismiss();
      if (confirm.error) return;

      // Focus starts on cancel, so a reflex return is the safe answer.
      if (key.leftArrow || key.upArrow) return setConfirm({ ...confirm, focused: false });
      if (key.rightArrow || key.downArrow || key.tab) return setConfirm({ ...confirm, focused: true });
      if (key.return) return confirm.focused ? void run(confirm) : dismiss();
      return;
    }

    if (input === "q" || key.escape || (key.ctrl && input === "c")) return exit();
    if (input === "a") return setShowAll((value) => !value);
    if (key.downArrow)
      return setSelection((value) => Math.min(value + 1, Math.max(0, selectable.length - 1)));
    if (key.upArrow) return setSelection((value) => Math.max(0, value - 1));
    if (key.return && selected)
      return openUrl(pullRequestUrl(target.owner, target.name, numberOf(selected)));
    if (input === "o" && queue) return openUrl(queue.url);
    if (input === "e" && actionable)
      return setConfirm({ action: "eject", entry: actionable, focused: false, pending: false, error: null });
    if (input === "j" && actionable)
      return setConfirm({ action: "jump", entry: actionable, focused: false, pending: false, error: null });
  });

  if (confirm) {
    return (
      <Confirm confirm={confirm} depth={depth} width={width} />
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
        <Spacer />
        {fetching ? <Spinner color="cyan" /> : <Text> </Text>}
      </Box>

      <Box marginBottom={1}>
        <Text dimColor wrap="truncate">
          {keyHints(actionable !== null)}
        </Text>
      </Box>

      {/* A pull request falls down the screen as it progresses: somebody asks
          you for one, yours wait for the same, then the queue, then gone. */}
      <ToReview
        shown={toReview}
        total={reviews.length}
        repo={target}
        selected={selectedReview}
        error={reviewError}
        loading={reviewsLoading}
        now={now}
        inner={width - PANEL_CHROME}
      />

      {/* No arrow here: the panel above is somebody else's work, and nothing
          crosses from it into yours. */}
      <Box height={1} />

      <YourPrs
        shown={prsShown}
        total={prsCounted ? prs.length : null}
        showAuthor={showAll}
        repo={target}
        selected={selectedPr}
        error={prError}
        loading={prLoading}
        now={now}
        inner={width - PANEL_CHROME}
      />

      <Flow label={ready > 0 ? `${ready} ready to queue` : undefined} color="green" />

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
          {error ? <Text color="red">retrying…</Text> : null}
          {!error && stale ? (
            <Text color="yellow" dimColor>
              last update {ago(updatedAt!, now)} ago
            </Text>
          ) : null}
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

      <Flow label={landing ? "yours is next" : undefined} />

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
