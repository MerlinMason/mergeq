import React, { useCallback, useRef, useState } from "react";
import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "ink";
import { useDashboard, type Target } from "./useDashboard.js";
import { useClock } from "./useClock.js";
import { useArrivals } from "./useArrivals.js";
import { notify } from "./notify.js";
import { openUrl, pullRequestUrl } from "./link.js";
// Inlined at build time, so it reports the version of this build rather than
// whatever package.json happens to sit next to it.
import { version } from "../package.json" with { type: "json" };
import { act, outcomeKey, PR_FETCH_LIMIT, type Action, type Entry, type Pr } from "./github.js";
import { ago, reasonOf } from "./format.js";
import { Badge, Flow, PANEL_CHROME, Rule, Spinner, Wordmark } from "./ui.js";
import { prState, PR_STATES, QueuePanel, Quexits, ToReview, YourPrs } from "./panels.js";
import { ACTIONS, Confirm, type Confirming } from "./Confirm.js";

const RECENT_LIMIT = 6;
const REVIEW_LIMIT = 6;
const PR_LIMIT = 10;

const STALE_AFTER = 30_000;

const STARTED_AT = Date.now();

// Actions are offered only for your own pull requests, so they are listed only
// when one is selected — and last, so the keys that are always there never move.
const keyHints = (actions: Action[]) =>
  [
    "↑↓ pick",
    "⏎  open PR",
    "a toggle all/yours",
    "o open queue",
    "x exit",
    ...actions.map((action) => `${ACTIONS[action].key} ${action}`),
  ].join(" · ");

export const KEY_HINTS = keyHints(Object.keys(ACTIONS) as Action[]);

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
  const [showAll, setShowAll] = useState(all);
  const [selection, setSelection] = useState(0);
  const prScroll = useRef(0);
  // One piece of state, so focus and errors cannot outlive the dialog that owns
  // them. Kept apart, a successful action left the destructive button focused and
  // the next dialog opened with it already selected.
  const [confirm, setConfirm] = useState<Confirming | null>(null);

  const tick = useClock(interval);
  const {
    queue,
    reviews: reviewData,
    prs: prData,
    outcomes: outcomeData,
    rate,
    at: updatedAt,
    viewer,
    checks,
    fatal,
    failing,
    fetching,
  } = useDashboard(target, tick, !showAll);

  // The clock re-renders on every tick, so ages read from it stay current.
  const now = Date.now();

  // A panel with rows keeps them and lets the header date them. Only one that
  // has never had any reports the failure itself.
  const blank = (rows: unknown[] | null) => ({
    loading: rows === null && !failing,
    error: rows === null ? failing : null,
  });

  useArrivals(outcomeData, outcomeKey, (outcome) => {
    if (outcome.author !== viewer || outcome.at.getTime() < STARTED_AT) return;
    const reason = reasonOf(outcome.reason);
    if (outcome.kind === "merged") notify(`🔀 #${outcome.number} shipped`, outcome.title);
    else notify(`${reason.emoji} #${outcome.number} out of the queue`, `${reason.label} — ${outcome.title}`);
  });

  useArrivals(
    reviewData,
    (review) => review.number,
    (review) => {
      if (review.requestedAt.getTime() < STARTED_AT) return;
      notify(`👀 #${review.number} wants your review`, `${review.author} — ${review.title}`);
    },
  );

  // Say how old once a refresh has failed, or once one is late enough to have
  // been missed — a sleeping laptop fires no timers.
  const stale =
    updatedAt !== null && (failing || now - updatedAt.getTime() > STALE_AFTER)
      ? `${failing ? "stale · " : ""}last update ${ago(updatedAt, now)} ago`
      : null;
  const mine = (queue?.entries ?? []).filter((entry) => entry.author === viewer);

  // Once it is in the queue it belongs to the queue panel, which knows where it
  // sits and when it lands. Listing it twice would only ask which one to believe.
  const queued = new Set(queue?.entries.map((entry) => entry.number));
  const open = (prData ?? []).filter((pr) => !queued.has(pr.number));

  // Sorting by what it is asking you to do only means something for your own
  // work. Everybody's is a feed, so it keeps the newest-first order it arrived in.
  const prs = showAll
    ? open
    : [...open].sort(
        (a, b) =>
          prState(a).rank - prState(b).rank || b.updatedAt.getTime() - a.updatedAt.getTime(),
      );

  // Lights the arrow between the panels either one joins.
  const ready = prs.filter((pr) => prState(pr) === PR_STATES.approved).length;
  const landing = mine.some((entry) => entry.position === 1);

  // Sliced once, here, so a panel cannot disagree with the list the cursor walks.
  const recent = (outcomeData ?? []).slice(0, RECENT_LIMIT);
  const reviews = reviewData ?? [];
  const toReview = reviews.slice(0, REVIEW_LIMIT);
  // A full page back means there are more we never saw, so any total we quote
  // would be the page size rather than the repository's.
  const prsCounted = (prData?.length ?? 0) < PR_FETCH_LIMIT;

  // Every row is the object its panel renders, so a panel asks whether it holds
  // the selection rather than matching on a number. Keep this in the order the
  // panels appear, or the cursor jumps about.
  const selectable = [...toReview, ...prs, ...mine, ...recent];
  const cursor = Math.min(selection, selectable.length - 1);
  const selected = selectable[cursor] ?? null;

  const prCursor = cursor - toReview.length;
  if (prCursor >= 0 && prCursor < prs.length) {
    if (prCursor < prScroll.current) prScroll.current = prCursor;
    else if (prCursor >= prScroll.current + PR_LIMIT) prScroll.current = prCursor - PR_LIMIT + 1;
  }
  prScroll.current = Math.min(prScroll.current, Math.max(0, prs.length - PR_LIMIT));
  const prsShown = prs.slice(prScroll.current, prScroll.current + PR_LIMIT);

  const queuedPr = mine.find((entry) => entry === selected);
  const approvedPr = prs.find(
    (pr) => pr === selected && pr.author === viewer && prState(pr) === PR_STATES.approved,
  );
  const subject: Entry | Pr | undefined = queuedPr ?? approvedPr;
  const offered: Action[] = queuedPr ? ["eject", "jump"] : approvedPr ? ["queue"] : [];

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
          pullRequestId: pending.pr.id,
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
      if (key.escape || input === "x") return dismiss();
      if (confirm.error) return;

      if (key.leftArrow || key.upArrow) return setConfirm({ ...confirm, focused: false });
      if (key.rightArrow || key.downArrow || key.tab) return setConfirm({ ...confirm, focused: true });
      if (key.return) return confirm.focused ? void run(confirm) : dismiss();
      return;
    }

    if (input === "x" || key.escape || (key.ctrl && input === "c")) return exit();
    if (input === "a") return setShowAll((value) => !value);
    if (key.downArrow)
      return setSelection((value) => Math.min(value + 1, Math.max(0, selectable.length - 1)));
    if (key.upArrow) return setSelection((value) => Math.max(0, value - 1));
    if (key.return && selected) return openUrl(pullRequestUrl(target, selected.number));
    if (input === "o" && queue) return openUrl(queue.url);

    const action = offered.find((offer) => ACTIONS[offer].key === input);
    if (action && subject) {
      setConfirm({
        action,
        pr: subject,
        focused: ACTIONS[action].eager ?? false,
        pending: false,
        error: null,
      });
    }
  });

  if (confirm) return <Confirm confirm={confirm} depth={queue?.totalCount ?? 0} width={width} />;

  if (fatal) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Badge />
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">✗ {fatal.message}</Text>
          {fatal.hint.map((line) => (
            <Text key={line} color="gray">
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  const inner = width - PANEL_CHROME;

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
        <Text dimColor> → {target.branch}</Text>
        <Spacer />
        {fetching ? <Spinner color="cyan" /> : <Text> </Text>}
      </Box>

      <Box marginBottom={1}>
        <Text dimColor wrap="truncate">
          {keyHints(offered)}
        </Text>
      </Box>

      {/* A pull request falls down the screen as it progresses: somebody asks
          you for one, yours wait for the same, then the queue, then gone. */}
      <ToReview
        shown={toReview}
        total={reviews.length}
        repo={target}
        selected={selected}
        {...blank(reviewData)}
        now={now}
        inner={inner}
      />

      {/* No arrow here: the panel above is somebody else's work, and nothing
          crosses from it into yours. */}
      <Box height={1} />

      <YourPrs
        shown={prsShown}
        above={prScroll.current}
        total={prsCounted ? prs.length : null}
        showAuthor={showAll}
        repo={target}
        selected={selected}
        {...blank(prData)}
        now={now}
        inner={inner}
      />

      <Flow label={ready > 0 ? `${ready} ready to queue` : undefined} color="green" />

      <QueuePanel
        queue={queue}
        mine={mine}
        showAll={showAll}
        viewer={viewer}
        rate={rate}
        checks={checks}
        selected={selected}
        repo={target}
        inner={inner}
        stale={stale}
      />

      <Flow label={landing ? "yours is next" : undefined} />

      <Quexits
        outcomes={recent}
        repo={target}
        selected={selected}
        showAuthor={showAll}
        {...blank(outcomeData)}
        now={now}
      />
    </Box>
  );
}
