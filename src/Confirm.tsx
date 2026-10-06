import React from "react";
import { Box, Text } from "ink";
import type { Action, Entry, Pr } from "./github.js";
import { Panel, Rule, Spinner } from "./ui.js";

export const ACTIONS: Record<
  Action,
  {
    key: string;
    accent: string;
    verb: string;
    question: string;
    consequence: string;
    // Nothing to talk you out of, so the dialog opens on the action, not cancel.
    eager?: boolean;
  }
> = {
  eject: {
    key: "e",
    accent: "red",
    verb: "Eject",
    question: "Take this out of the merge queue?",
    consequence: "Discards the checks it has run. You can queue it again afterwards, from the back.",
  },
  jump: {
    key: "j",
    accent: "yellow",
    verb: "Jump",
    question: "Send this to the front of the queue?",
    consequence:
      "It leaves the queue and rejoins at the front, so its checks start again and everything ahead of it waits longer.",
  },
  queue: {
    key: "q",
    accent: "green",
    verb: "Queue",
    question: "Add this to the merge queue?",
    consequence: "It joins at the back. You can eject it again from the queue panel.",
    eager: true,
  },
};

export type Confirming = {
  action: Action;
  pr: Entry | Pr;
  focused: boolean;
  pending: boolean;
  error: Error | null;
};

// Brackets so the one you are not on still reads as a button rather than as
// prose that happens to sit nearby.
function Button({ label, focused, color }: { label: string; focused: boolean; color?: string }) {
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

export function Confirm({
  confirm,
  depth,
  width,
}: {
  confirm: Confirming;
  depth: number;
  width: number;
}) {
  const { action, pr, focused, pending, error } = confirm;
  const { accent, verb, question, consequence } = ACTIONS[action];

  const card = Math.min(72, Math.max(48, width - 8));

  return (
    // Anchored where the main view starts, under the same rule, so answering this
    // does not move the whole display.
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Rule width={width} />

      <Box marginTop={1} width={card} flexDirection="column">
        <Panel title={verb.toUpperCase()} color={accent}>
          <Text bold>{question}</Text>

          {/* The title is the one thing here somebody else wrote, so it is
              quoted rather than set as if the interface said it. */}
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={accent}>{"│ "}</Text>
              <Text bold>#{pr.number}</Text>
              <Text>{"  "}</Text>
              <Text wrap="truncate">{pr.title}</Text>
            </Box>
            <Box>
              <Text color={accent}>{"│ "}</Text>
              <Text dimColor>
                {"position" in pr ? `position ${pr.position} of ${depth}` : `${depth} already queued`}
              </Text>
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>{consequence}</Text>
          </Box>

          <Box marginTop={1}>
            {pending ? (
              <Spinner color={accent} label="asking GitHub…" />
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
        </Panel>

        <Box marginTop={1}>
          <Text dimColor>{error ? "esc go back" : "←→ choose · ⏎  select · esc cancel"}</Text>
        </Box>
      </Box>
    </Box>
  );
}
