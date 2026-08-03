import React from "react";
import { render } from "ink";
import App, { KEY_HINTS } from "./App.js";
import { resolveRepo, resolveToken, SetupError } from "./auth.js";

const HELP = `
  mergequeue — watch a GitHub merge queue in your terminal

  Usage
    $ mergeq [--repo owner/name] [--branch master] [--interval 5]

  Options
    --repo      Repository to watch (defaults to $MERGEQ_REPO, then the
                current directory's repo)
    --branch    Queued branch (defaults to the repository's default branch)
    --interval  Seconds between polls (default 5)
    --all       Start on the full queue rather than just your pull requests
    --as        A GitHub username to follow instead of your own

  Keys
    ${KEY_HINTS}

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

  const spec = flag("repo") ?? process.env.MERGEQ_REPO;
  if (spec && !/^[^/]+\/[^/]+$/.test(spec)) {
    throw new SetupError(`Invalid --repo "${spec}".`, ["Use owner/name"]);
  }

  const [token, repo] = await Promise.all([resolveToken(), resolveRepo(spec)]);

  const branch = flag("branch") ?? repo.defaultBranch;
  const seconds = Number(flag("interval") ?? 5);
  const interval = Math.max(2, Number.isFinite(seconds) ? seconds : 5) * 1000;

  const app = (
    <App
      target={{ token, owner: repo.owner, name: repo.name, branch, as: flag("as") }}
      interval={interval}
      all={process.argv.includes("--all")}
    />
  );

  // A frame is updated by moving the cursor up by the height of the last one. On
  // the alternate screen there is no scrollback for a mis-counted frame to be
  // stranded in, and Ink restores the primary screen on the way out.
  const instance = render(app, { alternateScreen: true });

  // Timers do not fire while the machine sleeps, so a gap far longer than the
  // tick means it just woke. Whatever is on screen was drawn for a terminal that
  // may since have been resized without anyone saying so, and a frame wider than
  // its window wraps — which is exactly what breaks the cursor arithmetic. Start
  // again from a blank screen instead of trusting the old measurements.
  const TICK = 5_000;
  let previousTick = Date.now();
  const watchForWake = setInterval(() => {
    const now = Date.now();
    if (now - previousTick > TICK * 3) {
      instance.clear();
      instance.rerender(app);
    }
    previousTick = now;
  }, TICK);
  watchForWake.unref();
}

main().catch(fail);
