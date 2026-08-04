import { execFile, execFileSync } from "node:child_process";
import { BEL, ESC } from "./link.js";

type Send = (title: string, body: string) => void;

const OSC_777_TERMINALS = new Set(["WarpTerminal", "WezTerm", "ghostty"]);

function supportsEscapeNotifications(): boolean {
  const program = process.env.TERM_PROGRAM ?? "";
  if (OSC_777_TERMINALS.has(program)) return true;
  if (process.env.KITTY_WINDOW_ID) return true;
  return (process.env.TERM ?? "").startsWith("foot");
}

function terminalNotifier(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("which", ["terminal-notifier"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function resolve(): Send {
  if (supportsEscapeNotifications()) {
    // Semicolons separate the fields of the escape, so they cannot appear in one.
    const oscSafe = (value: string) => value.replace(/[;\r\n]/g, " ").trim();
    return (title, body) =>
      process.stdout.write(`${ESC}]777;notify;${oscSafe(title)};${oscSafe(body)}${BEL}`);
  }

  const notifier = terminalNotifier();
  if (notifier) {
    return (title, body) =>
      execFile(notifier, ["-title", title, "-message", body, "-sound", "Ping"]);
  }

  if (process.platform !== "darwin") return () => {};

  const appleScriptSafe = (value: string) => value.replace(/["\\]/g, "\\$&");
  return (title, body) =>
    execFile("osascript", [
      "-e",
      `display notification "${appleScriptSafe(body)}" with title "${appleScriptSafe(title)}" sound name "Ping"`,
    ]);
}

let send: Send | null = null;

export function notify(title: string, body: string): void {
  if (process.env.MERGEQ_NOTIFY === "off") return;
  send ??= resolve();
  send(title, body);
}
