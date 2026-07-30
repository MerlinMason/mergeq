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

Keys are listed under the title: `↑↓` pick · `⏎` open the selected pull
request · `a` toggle all/mine · `o` open the queue on GitHub · `q` quit.

Flags: `--repo owner/name`, `--branch <name>`, `--interval <seconds>` (default
5), `--all` to start on the full queue, `--as <login>` to follow someone else's
pull requests.

## What it shows

The default view is only your pull requests. Everything ahead of them collapses
into a `▸ n ahead` divider carrying the wait those entries represent, so the
question "how long until mine lands" is answerable at a glance. Each of yours
gets a check-progress bar, the check currently running, and an estimate.

`RECENTLY` covers what happened after pull requests left the queue — yours, or
everyone's when the full queue is showing — with an
emoji per outcome — 🚀 shipped, 💥 failed, 🥊 conflict, ✋ yanked, 😭 for
anything else. macOS gets a desktop notification for each.

Move the selection with `↑`/`↓` (or `j`/`k`) and press `⏎` to open the
highlighted pull request on GitHub. Pull request numbers are also OSC 8
hyperlinks, so ⌘-click opens them in iTerm2, Ghostty, WezTerm, Kitty and
Terminal.app. Warp merged OSC 8 support in July 2026 behind a feature flag, so
whether ⌘-click works there depends on your build.

Notifications pick the best available route, in order:

1. **OSC 777 escape** — Warp, WezTerm, Ghostty, Kitty and foot raise the
   notification themselves. No dependency, no separate permission.
2. **`terminal-notifier`** — used automatically if it is on `$PATH`.
3. **`osascript`** — the fallback. macOS attributes these to Script Editor, so
   if nothing appears, enable Script Editor under System Settings ›
   Notifications.

Set `MERGEQ_NOTIFY=off` to silence them.

## Colour

Text that carries no meaning of its own takes the terminal's default
foreground, and recedes with `dimColor` rather than a grey from the palette:
`white` and `black` name the ends of the palette rather than "readable", so on
a light theme white text lands on a white background. Named colours elsewhere
are palette indices, which the theme remaps, so red still reads as red under
Solarized.

The wordmark and rules are true colour and do not adapt — they are decoration
and carry nothing you need.

`NO_COLOR` is honoured. Chalk ignores it under Bun but respects `FORCE_COLOR`,
so `src/cli.tsx` translates one into the other before anything that draws is
imported.

Times are relative throughout, and nothing counts up second by second — the
display only refreshes twice a minute. If polling stalls the header says so.

## Where the estimate comes from

GitHub's own `estimatedTimeToMerge` assumes roughly 1.7 minutes per position.
Measured against the last 50 merges of incident-io/core, the queue actually
merges one pull request every ~3.1 minutes, so that estimate runs about 1.8×
optimistic.

The estimate here is `position × observed gap`, where the gap comes from the
timestamps of recent merges and so tracks the time of day.

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
- `src/cli.tsx` only sets `FORCE_COLOR` and then dynamically imports
  `src/main.tsx`, which does the arg parsing and rendering. The indirection is
  load-bearing — see Colour above.

Shipping later as a `gh` extension means renaming the repo to `gh-mergeq`,
adding the `gh-extension` topic and wiring `cli/gh-extension-precompile` to the
build command above.
