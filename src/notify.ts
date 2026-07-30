import { execFile } from "node:child_process";

function escape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

export function notify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  execFile("osascript", [
    "-e",
    `display notification "${escape(body)}" with title "${escape(title)}" sound name "Ping"`,
  ]);
}
