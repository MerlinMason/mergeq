import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { execFile } from "node:child_process";
import { useQueue, type Event, type Target } from "./useQueue.js";
import { SetupError } from "./auth.js";
import type { Entry, EntryState } from "./github.js";

const STATES: Record<EntryState, { glyph: string; color: string; label: string }> = {
  QUEUED: { glyph: "○", color: "gray", label: "queued" },
  AWAITING_CHECKS: { glyph: "◐", color: "yellow", label: "checks" },
  MERGEABLE: { glyph: "●", color: "green", label: "mergeable" },
  UNMERGEABLE: { glyph: "✗", color: "red", label: "failing" },
  LOCKED: { glyph: "▲", color: "magenta", label: "locked" },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 100);
  useEffect(() => {
    const onResize = () => setWidth(stdout.columns || 100);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return width;
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
  return `${Math.round(seconds / 3600)}h`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function clock(at: Date): string {
  return at.toTimeString().slice(0, 8);
}

function Row({ entry, mine, now }: { entry: Entry; mine: boolean; now: number }) {
  const state = STATES[entry.state];
  const author = entry.pullRequest.author?.login ?? "unknown";

  return (
    <Box>
      <Box width={3} marginRight={1} flexShrink={0}>
        <Text color={mine ? "cyan" : "gray"}>{String(entry.position).padStart(2)}</Text>
      </Box>
      <Box width={7} marginRight={1} flexShrink={0}>
        <Text color={mine ? "cyan" : undefined} bold={mine}>
          #{entry.pullRequest.number}
        </Text>
      </Box>
      <Box width={10} marginRight={1} flexShrink={0}>
        <Text color={state.color} wrap="truncate">
          {state.glyph} {state.label}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginRight={1}>
        <Text bold={mine} color={mine ? "white" : undefined} wrap="truncate">
          {entry.pullRequest.title}
        </Text>
      </Box>
      <Box width={14} marginRight={1} flexShrink={0}>
        <Text color="gray" wrap="truncate">
          {author}
        </Text>
      </Box>
      <Box width={4} marginRight={1} flexShrink={0}>
        <Text color="gray">{ago(new Date(entry.enqueuedAt), now)}</Text>
      </Box>
      <Box width={5} flexShrink={0}>
        <Text color={mine ? "cyan" : "gray"} wrap="truncate">
          ~{duration(entry.estimatedTimeToMerge)}
        </Text>
      </Box>
    </Box>
  );
}

function Header({ target, width }: { target: Target; width: number }) {
  return (
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
      <Text color="gray">{width >= 80 ? "q quit · r refresh · o open" : ""}</Text>
    </Box>
  );
}

function Events({ events, now }: { events: Event[]; now: number }) {
  if (events.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray" dimColor>
        recent
      </Text>
      {events.slice(0, 3).map((event) => (
        <Box key={event.id}>
          <Text color="gray">{clock(event.at)} </Text>
          <Text
            color={event.tone === "good" ? "green" : event.tone === "bad" ? "red" : "white"}
            bold={event.mine}
          >
            {event.text}
          </Text>
          {event.mine ? <Text color="cyan"> (yours)</Text> : null}
        </Box>
      ))}
      <Box marginTop={0}>
        <Text color="gray" dimColor>
          {ago(events[0]!.at, now)} ago
        </Text>
      </Box>
    </Box>
  );
}

function Failure({ error }: { error: SetupError }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="red">✗ {error.message}</Text>
      {error.hint.map((line) => (
        <Text key={line} color="gray">
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

export default function App({ target, interval }: { target: Target; interval: number }) {
  const { exit } = useApp();
  const width = useWidth();
  const { queue, events, error, fetching, updatedAt, refresh } = useQueue(target, interval);
  const spinner = useSpinner(fetching);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
    if (input === "r") refresh();
    if (input === "o" && queue) execFile("open", [queue.url]);
  });

  if (error instanceof SetupError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Header target={target} width={width} />
        <Failure error={error} />
      </Box>
    );
  }

  const buildWindow = queue?.maximumEntriesToBuild ?? null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header target={target} width={width} />

      <Box marginTop={1}>
        <Text color={fetching ? "cyan" : "gray"}>{fetching ? spinner : "·"} </Text>
        {queue ? (
          <Text>
            <Text bold>{queue.totalCount}</Text>
            <Text color="gray"> in queue</Text>
          </Text>
        ) : (
          <Text color="gray">connecting…</Text>
        )}
        <Box flexGrow={1} />
        {error ? (
          <Text color="red">retrying — {error.message} </Text>
        ) : null}
        {updatedAt ? <Text color="gray">updated {ago(updatedAt, now)} ago</Text> : null}
      </Box>

      {queue && queue.entries.length === 0 ? (
        <Box marginTop={1}>
          <Text color="green">✓ queue is empty</Text>
        </Box>
      ) : null}

      {queue && queue.entries.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {queue.entries.map((entry, index) => (
            <React.Fragment key={entry.pullRequest.number}>
              {buildWindow !== null && index === buildWindow ? (
                <Box>
                  <Text color="gray" dimColor>
                    {"─".repeat(Math.max(0, Math.min(width - 4, 24)))} not building yet
                  </Text>
                </Box>
              ) : null}
              <Row
                entry={entry}
                mine={entry.pullRequest.author?.login === queue.viewer}
                now={now}
              />
            </React.Fragment>
          ))}
        </Box>
      ) : null}

      <Events events={events} now={now} />
    </Box>
  );
}
