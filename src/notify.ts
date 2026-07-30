import { execFile, execFileSync } from "node:child_process";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const OSC_777_TERMINALS = new Set(["WarpTerminal", "WezTerm", "ghostty"]);

function supportsEscapeNotifications(): boolean {
  const program = process.env.TERM_PROGRAM ?? "";
  if (OSC_777_TERMINALS.has(program)) return true;
  if (process.env.KITTY_WINDOW_ID) return true;
  return (process.env.TERM ?? "").startsWith("foot");
}

function resolveNotifier(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("which", ["terminal-notifier"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const escapes = supportsEscapeNotifications();
const notifier = escapes ? null : resolveNotifier();

export const method: "escape" | "terminal-notifier" | "osascript" | "none" = escapes
  ? "escape"
  : notifier
    ? "terminal-notifier"
    : process.platform === "darwin"
      ? "osascript"
      : "none";

function clean(value: string): string {
  return value.replace(/[;\r\n]/g, " ").trim();
}

export function notify(title: string, body: string): void {
  if (process.env.MERGEQ_NOTIFY === "off") return;

  if (escapes) {
    process.stdout.write(`${ESC}]777;notify;${clean(title)};${clean(body)}${BEL}`);
    return;
  }

  if (notifier) {
    execFile(notifier, ["-title", title, "-message", body, "-sound", "Ping"]);
    return;
  }

  if (process.platform !== "darwin") return;

  const escape = (value: string) => value.replace(/["\\]/g, "\\$&");
  execFile("osascript", [
    "-e",
    `display notification "${escape(body)}" with title "${escape(title)}" sound name "Ping"`,
  ]);
}
