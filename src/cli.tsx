import React from "react";
import { render } from "ink";
import App from "./App.js";
import {
  resolveDefaultBranch,
  resolveRepo,
  resolveToken,
  SetupError,
} from "./auth.js";

const HELP = `
  mergeq — watch a GitHub merge queue in your terminal

  Usage
    $ mergeq [--repo owner/name] [--branch master] [--interval 5]

  Options
    --repo      Repository to watch (defaults to the current directory's repo)
    --branch    Queued branch (defaults to the repository's default branch)
    --interval  Seconds between polls (default 5)

  Keys
    q  quit      r  refresh now      o  open the queue in a browser

  Auth comes from the GitHub CLI. Run 'gh auth login' if you have not already.
`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function fail(error: unknown): never {
  if (error instanceof SetupError) {
    process.stderr.write(`\n  ✗ ${error.message}\n`);
    for (const hint of error.hint) process.stderr.write(`    ${hint}\n`);
    process.stderr.write("\n");
  } else {
    process.stderr.write(`\n  ✗ ${(error as Error).message}\n\n`);
  }
  process.exit(1);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const token = await resolveToken();

  const repoFlag = flag("repo");
  let owner: string;
  let name: string;

  if (repoFlag) {
    const [o, n] = repoFlag.split("/");
    if (!o || !n) throw new SetupError(`Invalid --repo "${repoFlag}".`, ["Use owner/name"]);
    owner = o;
    name = n;
  } else {
    ({ owner, name } = await resolveRepo());
  }

  const branch = flag("branch") ?? (await resolveDefaultBranch(owner, name));
  const interval = Math.max(2, Number(flag("interval") ?? 5)) * 1000;

  render(<App target={{ token, owner, name, branch }} interval={interval} />);
}

main().catch(fail);
