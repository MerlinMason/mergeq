const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const supported = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";

export function link(text: string, url: string): string {
  if (!supported) return text;
  return `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`;
}

export function pullRequestUrl(owner: string, name: string, number: number): string {
  return `https://github.com/${owner}/${name}/pull/${number}`;
}
