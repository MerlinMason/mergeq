import React, { useMemo, useState } from "react";
import { Box, Text, useAnimation, useWindowSize } from "ink";
import Gradient from "ink-gradient";
import stringWidth from "string-width";
import { TitledBox, titleStyles } from "@mishieck/ink-titled-box";
import { SetupError } from "./auth.js";
import { link, pullRequestUrl, type Repo } from "./link.js";

// root paddingX (2) + panel border (2) + panel paddingX (2)
export const PANEL_CHROME = 6;

// The list panels all lead with these, so the arithmetic that decides how much
// title fits reads the same numbers the markup draws.
export const CURSOR_WIDTH = 4;
export const NUMBER_WIDTH = 8;
export const GAP = 2;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ color, label }: { color: string; label?: string }) {
  const { frame } = useAnimation({ interval: 80 });
  const glyph = <Text color={color}>{SPINNER[frame % SPINNER.length]}</Text>;
  if (!label) return glyph;
  return (
    <Box>
      {glyph}
      <Text dimColor> {label}</Text>
    </Box>
  );
}

export function usePick<T>(choices: T[]): T {
  const [choice] = useState(() => choices[Math.floor(Math.random() * choices.length)]!);
  return choice;
}

export function PrLink({
  repo,
  number,
  width,
  color,
  bold,
  underline,
}: {
  repo: Repo;
  number: number;
  width: number;
  color?: string;
  bold?: boolean;
  underline?: boolean;
}) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={color} bold={bold} underline={underline}>
        {link(`#${number}`, pullRequestUrl(repo, number))}
      </Text>
    </Box>
  );
}

export function RowHead({
  repo,
  number,
  title,
  here,
  dim,
}: {
  repo: Repo;
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

export function Cell({
  width,
  right,
  children,
}: {
  width: number;
  right?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      width={width}
      marginRight={GAP}
      flexShrink={0}
      justifyContent={right ? "flex-end" : undefined}
    >
      {children}
    </Box>
  );
}

export type State = { glyph: string; label: string; color: string; dim?: boolean };

export function statusWidth(states: State[]): number {
  return stringWidth("✓ ") + Math.max(...states.map((state) => stringWidth(state.label)));
}

export function Status({ state, width }: { state: State; width: number }) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={state.color} dimColor={state.dim} wrap="truncate">
        {state.glyph} {state.label}
      </Text>
    </Box>
  );
}

export function Fallback({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: Error | null;
  children: React.ReactNode;
}) {
  if (loading) return <Spinner color="cyan" label="looking…" />;

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

// null is "more than were counted" — the repository has more open pull requests
// than one page, so saying a number would be quoting the page size back.
export function Overflow({ arrow, count }: { arrow: "↑" | "↓"; count: number | null }) {
  if (count !== null && count <= 0) return null;
  return (
    <Box marginLeft={CURSOR_WIDTH}>
      <Text dimColor>
        {arrow} {count ?? "plenty"} more
      </Text>
    </Box>
  );
}

export function Panel({
  title,
  color = "gray",
  children,
}: {
  title: string;
  color?: string;
  children: React.ReactNode;
}) {
  // A new titles array makes the box re-measure its border, which costs a second
  // commit, so it changes only when the title or the terminal width does.
  const { columns } = useWindowSize();
  const titles = useMemo(() => [title], [title, columns]);

  return (
    <TitledBox
      borderStyle="round"
      borderColor={color}
      titles={titles}
      titleStyles={titleStyles.rectangle}
      flexDirection="column"
      paddingX={1}
    >
      {children}
    </TitledBox>
  );
}

// The gap between two panels was already a blank row, so the connector that
// makes them read as one pipeline costs no height.
export function Flow({ label, color = "cyan" }: { label?: string; color?: string }) {
  const lit = Boolean(label);
  return (
    <Box flexDirection="column" marginLeft={3}>
      <Text color={lit ? color : undefined} dimColor={!lit}>
        │
      </Text>
      <Text color={lit ? color : undefined} bold={lit} dimColor={!lit}>
        ▼{label ? `  ${label}` : ""}
      </Text>
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

export const Wordmark = React.memo(function Wordmark() {
  return (
    <Gradient name={BRAND}>
      <Text>{WORDMARK}</Text>
    </Gradient>
  );
});

export const Rule = React.memo(function Rule({ width }: { width: number }) {
  return (
    <Gradient name={BRAND}>
      <Text dimColor>{"─".repeat(Math.max(10, width - 2))}</Text>
    </Gradient>
  );
});

export const Badge = React.memo(function Badge() {
  return (
    <Gradient name={BRAND}>
      <Text bold>mergequeue</Text>
    </Gradient>
  );
});
