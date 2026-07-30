import { execFile, execFileSync } from "node:child_process";
import { BEL, ESC } from "./link.js";

export type Method = "escape" | "terminal-notifier" | "osascript" | "none";

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

const CHANNELS: Record<Exclude<Method, "none">, (title: string, body: string) => void> = {
  escape(title, body) {
    const clean = (value: string) => value.replace(/[;\r\n]/g, " ").trim();
    process.stdout.write(`${ESC}]777;notify;${clean(title)};${clean(body)}${BEL}`);
  },
  "terminal-notifier"(title, body) {
    execFile(notifier!, ["-title", title, "-message", body, "-sound", "Ping"]);
  },
  osascript(title, body) {
    const clean = (value: string) => value.replace(/["\\]/g, "\\$&");
    execFile("osascript", [
      "-e",
      `display notification "${clean(body)}" with title "${clean(title)}" sound name "Ping"`,
    ]);
  },
};

let notifier: string | null = null;
let resolved: Method | null = null;

function method(): Method {
  if (resolved) return resolved;

  if (supportsEscapeNotifications()) {
    resolved = "escape";
  } else {
    notifier = resolveNotifier();
    resolved = notifier
      ? "terminal-notifier"
      : process.platform === "darwin"
        ? "osascript"
        : "none";
  }

  return resolved;
}

export function notify(title: string, body: string): void {
  if (process.env.MERGEQ_NOTIFY === "off") return;
  const channel = method();
  if (channel === "none") return;
  CHANNELS[channel](title, body);
}
