import { execFile } from "node:child_process";

export const ESC = String.fromCharCode(27);
export const BEL = String.fromCharCode(7);

const supported = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";

export function link(text: string, url: string): string {
  if (!supported) return text;
  return `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`;
}

export type Repo = { owner: string; name: string };

export function pullRequestUrl(repo: Repo, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${number}`;
}

export function openUrl(url: string): void {
  execFile("open", [url]);
}
