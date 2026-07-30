# mergeq

Watch a GitHub merge queue in your terminal.

```bash
bun install
bun run dev --repo incident-io/core
```

With no `--repo`, it falls back to `$MERGEQ_REPO` and then to the current
directory's repository — so `bun run dev` on its own works from inside a
checkout of the repo you want to watch, but not from this one, which has no
GitHub remote. Set a default with:

```bash
export MERGEQ_REPO=incident-io/core
```

Keys: `q` quit · `a` yours/all · `r` refresh now · `o` open in a browser.

Flags: `--repo owner/name`, `--branch <name>`, `--interval <seconds>` (default
5), `--all` to start on the full queue, `--as <login>` to follow someone else's
pull requests.

## What it shows

The default view is only your pull requests. Everything ahead of them collapses
into a `▸ n ahead` divider carrying the wait those entries represent, so the
question "how long until mine lands" is answerable at a glance. Each of yours
gets a check-progress bar, the check currently running, and an estimate.

`RECENTLY` covers what happened after your pull requests left the queue, with an
emoji per outcome — 🚀 shipped, 💥 checks blew up, 🥊 merge conflict, ✋ yanked
by hand, 😭 for anything else. macOS gets a desktop notification for each.

Move the selection with `↑`/`↓` (or `j`/`k`) and press `⏎` to open the
highlighted pull request on GitHub. That works everywhere.

Pull request numbers are also OSC 8 hyperlinks, so ⌘-click opens them directly
in iTerm2, Ghostty, WezTerm, Kitty and Terminal.app. Warp does not implement
OSC 8, so the numbers render as plain text there and `⏎` is the way in.

Times are relative throughout, and nothing counts up second by second — the
display only refreshes twice a minute. If polling stalls the header says so.

## Where the estimate comes from

GitHub's own `estimatedTimeToMerge` assumes roughly 1.7 minutes per position.
Measured against the last 50 merges of incident-io/core, the queue actually
merges one pull request every ~3.1 minutes, so that estimate runs about 1.8×
optimistic.

The estimate here is `position × observed gap`, where the gap comes from the
timestamps of recent merges and so tracks the time of day. When that sample
spans more than six hours the queue is too idle to extrapolate from, and the
header marks the figure `(rough)`.

## Polling

Queue every 5s, your recent outcomes every 60s, merge rate every 5 minutes.
Around 800 GraphQL points an hour against a 5,000 budget.

## Auth

Borrowed from the GitHub CLI — run `gh auth login` once and you are done. Falls
back to `$GH_TOKEN` / `$GITHUB_TOKEN` for CI. A missing login, missing `repo`
scope or unauthorised SSO each print the command that fixes it.

## Build a standalone binary

```bash
bun run build                     # dist/mergeq, runs without node or bun
bun build --compile src/cli.tsx --target=bun-linux-x64 --outfile dist/mergeq-linux
```

## Choices that keep options open

- No Bun-specific APIs in `src/` — runs on Node 22+ too, so publishing to npm
  stays available alongside the compiled binary.
- `react-devtools-core` is a real dependency, not a peer. Ink imports it eagerly
  and `--compile` fails at runtime without it.
- Auth lives behind `resolveToken()` in `src/auth.ts`, so a `gh` extension, an
  npm package and CI all use the same path.
- `src/cli.tsx` is a thin entry point: arg parsing, then render.

Shipping later as a `gh` extension means renaming the repo to `gh-mergeq`,
adding the `gh-extension` topic and wiring `cli/gh-extension-precompile` to the
build command above.
