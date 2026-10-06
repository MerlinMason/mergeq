import React from "react";
import { Box, Spacer, Text } from "ink";
import stringWidth from "string-width";
import type { Checks, Entry, EntryState, Outcome, Pr, Queue, Rate, Review } from "./github.js";
import { outcomeKey } from "./github.js";
import type { Repo } from "./link.js";
import {
  ago,
  bar,
  busyness,
  DAY,
  ETA_WIDTH,
  etaLabel,
  lines,
  minutes,
  OUTCOME_WIDTH,
  reasonOf,
  waitColor,
} from "./format.js";
import {
  Cell,
  CURSOR_WIDTH,
  Fallback,
  GAP,
  NUMBER_WIDTH,
  Overflow,
  Panel,
  PrLink,
  RowHead,
  Spinner,
  Status,
  statusWidth,
  usePick,
} from "./ui.js";

const AUTHOR_WIDTH = 12;
const REVIEWER_WIDTH = 14;
const AGE_WIDTH = 4;
const SIZE_WIDTH = stringWidth("+99.9k -99.9k");

// A title truncated to a handful of words says nothing, so the columns beside
// it are dropped before the title shrinks past this.
const TITLE_FLOOR = 24;

const ROW_FIXED = CURSOR_WIDTH + NUMBER_WIDTH + GAP + AGE_WIDTH + GAP;

type Loading = { loading: boolean; error: Error | null };

const NOTHING_TO_REVIEW = [
  "Nothing to review — inbox zero, king 👑",
  "Nothing to review — dangerously caught up 🫡",
  "Nothing to review — go and touch some grass 🌱",
  "Nothing to review — nobody needs you, devastating 💅",
  "Nothing to review — unemployed behaviour 😌",
  "Nothing to review — unbothered, moisturised 🧴",
];

const NOTHING_QUEUED = [
  "Nothing of yours in the queue — yassify something 💅",
  "Nothing of yours in the queue — make something magic ✨",
  "Nothing of yours in the queue — slay 👑",
  "Nothing of yours in the queue — get ticket-maxxing 🚢",
  "Nothing of yours in the queue — start aura farming 🚜",
];

const REVIEW_STATES = {
  broken: { glyph: "✗", label: "ci red", color: "red" },
  changes: { glyph: "±", label: "changes", color: "yellow" },
  building: { glyph: "◐", label: "building", color: "yellow", dim: true },
  ready: { glyph: "●", label: "ready", color: "green" },
};

// Whether opening it now would be wasted, because they are still working.
// Somebody else's approval is not that: the request is still yours until you
// answer it, and showing "approved" made an untouched pull request look done.
function reviewState(review: Review) {
  if (review.checks === "failing") return REVIEW_STATES.broken;
  if (review.decision === "CHANGES_REQUESTED") return REVIEW_STATES.changes;
  if (review.checks === "running") return REVIEW_STATES.building;
  return REVIEW_STATES.ready;
}

const REVIEW_STATUS_WIDTH = statusWidth(Object.values(REVIEW_STATES));

export function ToReview({
  shown,
  total,
  repo,
  selected,
  error,
  loading,
  now,
  inner,
}: Loading & {
  shown: Review[];
  total: number;
  repo: Repo;
  selected: unknown;
  now: number;
  inner: number;
}) {
  const praise = usePick(NOTHING_TO_REVIEW);

  let spare = inner - ROW_FIXED - REVIEW_STATUS_WIDTH - TITLE_FLOOR;
  const withAuthor = spare >= AUTHOR_WIDTH + GAP;
  if (withAuthor) spare -= AUTHOR_WIDTH + GAP;
  const withSize = spare >= SIZE_WIDTH + GAP;

  return (
    <Panel title="TO REVIEW">
      {shown.length === 0 ? (
        <Fallback loading={loading} error={error}>
          {praise}
        </Fallback>
      ) : null}
      {shown.map((review) => {
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
              <Cell width={AUTHOR_WIDTH}>
                <Text dimColor wrap="truncate">
                  {review.author}
                </Text>
              </Cell>
            ) : null}
            {withSize ? (
              <Cell width={SIZE_WIDTH} right>
                <Text>
                  <Text color="green">+{lines(review.additions)}</Text>
                  <Text color="red"> -{lines(review.deletions)}</Text>
                </Text>
              </Cell>
            ) : null}
            <Cell width={AGE_WIDTH} right>
              <Text color={waitColor(waited)} bold={waited > 3 * DAY}>
                {ago(review.requestedAt, now)}
              </Text>
            </Cell>
            <Status state={reviewState(review)} width={REVIEW_STATUS_WIDTH} />
          </Box>
        );
      })}
      <Overflow arrow="↓" count={total - shown.length} />
    </Panel>
  );
}

// Ordered by what it is asking you to do, which is also the order the panel
// sorts in: ship it, answer them, fix it, then the ones where waiting is the
// only move.
export const PR_STATES = {
  approved: { rank: 0, glyph: "✓", label: "approved", color: "green" },
  changes: { rank: 1, glyph: "±", label: "changes", color: "yellow" },
  broken: { rank: 2, glyph: "✗", label: "ci red", color: "red" },
  waiting: { rank: 3, glyph: "○", label: "waiting", color: "cyan" },
  building: { rank: 4, glyph: "◐", label: "building", color: "yellow", dim: true },
  draft: { rank: 5, glyph: "✎", label: "draft", color: "gray", dim: true },
};

// A draft says draft even when its build is red: you already know, and nobody
// is going to look at it either way.
export function prState(pr: Pr) {
  if (pr.draft) return PR_STATES.draft;
  if (pr.decision === "APPROVED") return PR_STATES.approved;
  if (pr.decision === "CHANGES_REQUESTED") return PR_STATES.changes;
  if (pr.checks === "failing") return PR_STATES.broken;
  if (pr.checks === "running") return PR_STATES.building;
  return PR_STATES.waiting;
}

const PR_STATUS_WIDTH = statusWidth(Object.values(PR_STATES));

export function YourPrs({
  shown,
  above,
  total,
  repo,
  selected,
  showAuthor,
  error,
  loading,
  now,
  inner,
}: Loading & {
  shown: Pr[];
  above: number;
  total: number | null;
  repo: Repo;
  selected: unknown;
  showAuthor: boolean;
  now: number;
  inner: number;
}) {
  const rows = shown.map((pr) => {
    const state = prState(pr);
    // Whose it is answers the first question about somebody else's pull request;
    // who still owes it a review answers the first question about your own.
    const nobody = !showAuthor && state === PR_STATES.waiting && pr.reviewers.length === 0;
    const beside = showAuthor ? pr.author : pr.reviewers.join(" ") || (nobody ? "nobody" : "—");
    return { pr, state, nobody, beside };
  });

  // For your own, this column is mostly "—", so it is sized to what is in it
  // rather than to the longest thing that could be, and the title gets the rest.
  const aside = Math.min(REVIEWER_WIDTH, Math.max(0, ...rows.map((r) => stringWidth(r.beside))));
  const withAside = inner - ROW_FIXED - PR_STATUS_WIDTH - TITLE_FLOOR >= aside + GAP;

  return (
    <Panel title={showAuthor ? "OPEN PRS" : "YOUR PRS"}>
      {rows.length === 0 ? (
        <Fallback loading={loading} error={error}>
          Nothing open that is not already queued
        </Fallback>
      ) : null}
      <Overflow arrow="↑" count={above} />
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
            <Cell width={aside}>
              <Text color={nobody ? "yellow" : undefined} dimColor wrap="truncate">
                {beside}
              </Text>
            </Cell>
          ) : null}
          <Cell width={AGE_WIDTH} right>
            <Text dimColor>{ago(pr.updatedAt, now)}</Text>
          </Cell>
          <Status state={state} width={PR_STATUS_WIDTH} />
        </Box>
      ))}
      <Overflow arrow="↓" count={total === null ? null : total - above - shown.length} />
    </Panel>
  );
}

export function Quexits({
  outcomes,
  repo,
  selected,
  showAuthor,
  error,
  loading,
  now,
}: Loading & {
  outcomes: Outcome[];
  repo: Repo;
  selected: unknown;
  showAuthor: boolean;
  now: number;
}) {
  return (
    <Panel title={showAuthor ? "ALL QUEXITS" : "QUEXITS"}>
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
              <Cell width={REVIEWER_WIDTH}>
                <Text dimColor wrap="truncate">
                  {outcome.author}
                </Text>
              </Cell>
            ) : null}
            <Box width={OUTCOME_WIDTH} flexShrink={0}>
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

const ENTRY_STATES: Record<EntryState, { glyph: string; color: string; label: string }> = {
  QUEUED: { glyph: "○", color: "gray", label: "queued" },
  AWAITING_CHECKS: { glyph: "◐", color: "yellow", label: "checks" },
  MERGEABLE: { glyph: "●", color: "green", label: "mergeable" },
  UNMERGEABLE: { glyph: "✗", color: "red", label: "failing" },
  LOCKED: { glyph: "▲", color: "magenta", label: "locked" },
};

const NOT_BUILDING = `${"─".repeat(24)} not building yet`;

const AHEAD_GUTTER = 4;

function Ahead({ count, rate, inner }: { count: number; rate: Rate | null; inner: number }) {
  const wait = rate ? rate.gapMinutes * count : null;
  const label = `${count} ahead`;
  const right = wait === null ? "" : `~${minutes(wait)}`;
  const spent = AHEAD_GUTTER + stringWidth(label) + 1 + (right ? stringWidth(right) + 1 : 0);

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
  repo: Repo;
  here: boolean;
}) {
  const state = ENTRY_STATES[entry.state];
  const first = entry.position === 1;
  const counted = checks !== undefined && checks.total > 0;

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
          number={entry.number}
          width={8}
          color={building ? "cyan" : undefined}
          bold
          underline={here}
        />
        <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
          <Text bold={first} wrap="truncate">
            {entry.title}
          </Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text color="gray">pos {entry.position}</Text>
        </Box>
        <Box width={ETA_WIDTH} flexShrink={0} justifyContent="flex-end">
          <Text color={first ? "green" : "cyan"}>{etaLabel(entry, rate)}</Text>
        </Box>
      </Box>

      {first || counted ? (
        <Box marginLeft={4}>
          {first ? (
            <Text color="green" bold>
              🔀 you&apos;re up next{" "}
            </Text>
          ) : null}
          {counted ? (
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

function AllRow({
  entry,
  mine,
  repo,
  rate,
}: {
  entry: Entry;
  mine: boolean;
  repo: Repo;
  rate: Rate | null;
}) {
  return (
    <Box>
      <Box width={3} marginRight={1} flexShrink={0}>
        <Text color={mine ? "cyan" : "gray"}>{String(entry.position).padStart(2)}</Text>
      </Box>
      <Box marginRight={1} flexShrink={0}>
        <PrLink
          repo={repo}
          number={entry.number}
          width={7}
          color={mine ? "cyan" : undefined}
          bold={mine}
        />
      </Box>
      <Box marginRight={1} flexShrink={0}>
        <Status state={ENTRY_STATES[entry.state]} width={10} />
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
        <Text bold={mine} wrap="truncate">
          {entry.title}
        </Text>
      </Box>
      <Box width={14} marginRight={1} flexShrink={0}>
        <Text color="gray" wrap="truncate">
          {entry.author}
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

function Empty() {
  return <Text dimColor>{usePick(NOTHING_QUEUED)}</Text>;
}

type QueueProps = {
  queue: Queue | null;
  mine: Entry[];
  showAll: boolean;
  viewer: string;
  rate: Rate | null;
  checks: Map<string, Checks>;
  selected: unknown;
  repo: Repo;
  inner: number;
};

function QueueBody({ queue, mine, showAll, viewer, rate, checks, selected, repo, inner }: QueueProps) {
  if (!queue) return null;
  const buildWindow = queue.maximumEntriesToBuild ?? 0;

  if (showAll) {
    if (queue.entries.length === 0) {
      return <Text>Nothing in the queue — everyone must be at the pub 🍺</Text>;
    }
    return queue.entries.map((entry, index) => (
      <React.Fragment key={entry.number}>
        {index === buildWindow && buildWindow > 0 ? <Text dimColor>{NOT_BUILDING}</Text> : null}
        <AllRow entry={entry} mine={entry.author === viewer} repo={repo} rate={rate} />
      </React.Fragment>
    ));
  }

  if (mine.length === 0) return <Empty />;

  let walked = 0;
  return mine.map((entry) => {
    const ahead = entry.position - 1 - walked;
    walked = entry.position;
    return (
      <React.Fragment key={entry.number}>
        {ahead > 0 ? <Ahead count={ahead} rate={rate} inner={inner} /> : null}
        <Mine
          entry={entry}
          checks={entry.headOid ? checks.get(entry.headOid) : undefined}
          rate={rate}
          building={entry.position <= buildWindow}
          repo={repo}
          here={entry === selected}
        />
      </React.Fragment>
    );
  });
}

export function QueuePanel({ stale, ...props }: QueueProps & { stale: string | null }) {
  const { queue, rate, inner } = props;
  const busy = busyness(queue?.totalCount ?? 0);

  return (
    <Panel title="QUEUE">
      <Box>
        {queue ? (
          <Text>
            <Text bold>{queue.totalCount}</Text>
            <Text dimColor> queued{"   "}</Text>
            <Text>{busy.emoji} </Text>
            <Text color={busy.color}>{busy.label}</Text>
            {rate ? (
              <Text dimColor>
                {"   "}join now 🔀 in ~{minutes((queue.totalCount + 1) * rate.gapMinutes)}
              </Text>
            ) : null}
          </Text>
        ) : (
          <Text color="gray">connecting…</Text>
        )}
        <Spacer />
        {stale ? <Text color="yellow">{stale}</Text> : null}
      </Box>

      <Box marginY={1}>
        <Text color="gray">{"─".repeat(Math.max(10, inner))}</Text>
      </Box>

      <QueueBody {...props} />
    </Panel>
  );
}
