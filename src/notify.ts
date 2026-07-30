import { execFile, execFileSync } from "node:child_process";

function resolveNotifier(): string | null {
  try {
    return execFileSync("which", ["terminal-notifier"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const notifier = process.platform === "darwin" ? resolveNotifier() : null;

function escape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

export const usingTerminalNotifier = notifier !== null;

export function notify(title: string, body: string): void {
  if (process.platform !== "darwin") return;

  if (notifier) {
    execFile(notifier, ["-title", title, "-message", body, "-sound", "Ping"]);
    return;
  }

  execFile("osascript", [
    "-e",
    `display notification "${escape(body)}" with title "${escape(title)}" sound name "Ping"`,
  ]);
}
