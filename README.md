# mergeq

Watch a GitHub merge queue from your terminal: where your pull requests are in
it, what is holding them up, and when they will land.

<img width="833" height="412" alt="mergequeue watching a merge queue" src="https://github.com/user-attachments/assets/89f42722-35ac-499a-a84f-36af8bcc8dba" />

## Install

You need the [GitHub CLI](https://cli.github.com), logged in, and Node 22 or
newer. mergeq has no credentials of its own — it asks `gh` for a token, so if
`gh` works, mergeq works.

```bash
brew install gh   # if you do not have it
gh auth login     # once
```

Then, from inside a checkout of the repository you want to watch:

```bash
npx @merlinmason/mergeq
```

If you keep it, install it once and the command is `mergeq` from then on:

```bash
npm i -g @merlinmason/mergeq
```

The keys are listed under the title as you use it. Pull request numbers are also
hyperlinks, so ⌘-click opens them where your terminal supports it.

## Options

| | |
|---|---|
| `--repo owner/name` | which repository, if not the current directory |
| `--branch name` | which queued branch, if not the default |
| `--interval 5` | seconds between refreshes |
| `--all` | start on the whole queue |
| `--as username` | treat somebody else's GitHub account as "yours" |

`--repo` falls back to `$MERGEQ_REPO`, then to the current directory's
repository, so `export MERGEQ_REPO=owner/name` saves repeating it.

`$GH_TOKEN` or `$GITHUB_TOKEN` override `gh` when set. `NO_COLOR` is honoured.

## Notifications

You get a desktop notification when one of your pull requests merges or is
thrown out — only yours, and only for things that happen while it is running.

Most terminals raise these themselves. Where they cannot, macOS does it through
Script Editor, which needs to be allowed under System Settings › Notifications;
installing `terminal-notifier` avoids that. `MERGEQ_NOTIFY=off` silences them.

## Where the estimate comes from

Your wait is your place in the queue times how long one merge takes. GitHub
offers its own figure, about 1.7 minutes per place, but on a busy repository
merges really came about three minutes apart — so its guess was roughly twice as
fast as real life.

Working out how long one merge takes has a trap in it. GitHub merges several
pull requests at the same moment, in batches. Time the gap from one merge to the
next and most of those gaps are almost nothing, because they are pull requests
from the same batch landing together.

Take the middle gap and you get one of those near-zero numbers. That is what
this used to do, and with 21 pull requests waiting it promised everyone "less
than a minute" when the real wait was about an hour.

So it averages the gaps instead, over the last 24 hours. An average still counts
the long waits between one batch and the next, so it reflects the pace you
actually get.

Averages have a trap of their own: a quiet night leaves one enormous gap that
drags the estimate far too slow. So any gap longer than 30 minutes counts as 30,
because a gap that long means nobody was queueing, not that the queue was slow.
With fewer than five merges to learn from, it falls back to GitHub's figure.

## Development

```bash
bun install
bun run dev --repo owner/name   # from source
bun run check                   # typecheck
bun run bundle                  # dist/cli.js, what npm publishes
bun run build                   # dist/mergeq, a standalone binary
```

`src/` avoids Bun-specific APIs so the same source runs under Node. `cli.tsx`
exists only to translate `NO_COLOR` into `FORCE_COLOR` before anything that
draws is imported, then hands over to `main.tsx` — collapsing the two breaks
`NO_COLOR`.

## Licence

MIT
