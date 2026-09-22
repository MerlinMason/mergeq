# mergeq

Watch a GitHub merge queue from your terminal: where your pull requests are in
it, what is holding them up, and when they will land.

What other people are waiting on you for sits at the top. Below it your own
work falls down the screen as it progresses — waiting for review, then the
queue, then gone — and a pipe joins each stage to the next.

That pipe lights up when something of yours is about to move down it: green
for an approved pull request waiting to be queued, cyan when one of yours is
next to land.

<img width="556" height="583" alt="image" src="https://github.com/user-attachments/assets/53342cb7-745f-44d8-8c3d-38636854f62a" />


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
| `--interval 5` | seconds between refreshes, minimum 2 |
| `--all` | start on the whole queue |
| `--as username` | treat somebody else's GitHub account as "yours" |

`--repo` falls back to `$MERGEQ_REPO`, then to the current directory's
repository, so `export MERGEQ_REPO=owner/name` saves repeating it.

`--interval` sets one clock that every panel refreshes on, and every panel is
filled by a single GraphQL query, so a pull request cannot appear to leave
review and join the queue at different moments. Two seconds is the floor: a
refresh spends one of the 5000 GraphQL points an hour GitHub gives you — two
when something of yours is in the queue and its checks are worth reading — and
your token spends that budget on `gh` and everything else you run as well.
Anything lower is rejected in favour of the floor.

`$GH_TOKEN` or `$GITHUB_TOKEN` override `gh` when set. `NO_COLOR` is honoured.

Under `--as`, review requests made to somebody's teams are not listed — GitHub
only resolves those for the account asking.

## To review

The top panel is everything open in the repository that is waiting on you,
including requests made to a team you are in. Drafts are left out.

Longest wait first, because that is the one somebody has given up on. Each row
carries the author, the diff size, how long they have waited, and one status —
the thing worth knowing before you open it:

| | |
|---|---|
| `● ready` | it is yours to answer |
| `◐ building` | checks still running |
| `✗ ci red` | a check is failing, so they are probably still working |
| `± changes` | somebody has already asked for changes |

Somebody else approving it does not change any of that, and is not shown. You
were asked, so it stays here until you answer — and the moment you review it,
GitHub drops the request and the row goes.

The columns give way to the title as the terminal narrows: the diff size goes
first, then the author.

## Your PRs

Everything of yours open in the repository that has not reached the queue yet.
A pull request drops out of this panel the moment it joins the queue, into the
panel below, which can say where it sits and when it lands.

Most actionable first, so the top of the list is the next thing to do:

| | |
|---|---|
| `✓ approved` | queue it |
| `± changes` | somebody has asked for changes |
| `✗ ci red` | a check is failing |
| `○ waiting` | nobody has reviewed it yet |
| `◐ building` | checks still running |
| `✎ draft` | a draft says draft even when its build is red |

Beside it are the reviewers still to answer, or `nobody` in yellow when you have
not asked anyone, and how long it has been since anything happened.

Five rows show at a time. Keep pressing `↓` and the panel scrolls through the
rest, so every pull request fetched stays within reach.

Press `a` and it becomes OPEN PRS: the most recently touched pull requests
in the repository, whoever wrote them. Ordering by what it is asking you to do
only means anything for your own work, so this one is a feed — newest first,
and the column beside the title carries the author rather than the reviewers.

## Quexits

Queue exits: what has come out the far end, merged or thrown out, newest first.
An ejected pull request says why it left — failed, conflict, yanked — which is
the reason the panel is not called "recently merged". `a` widens it to
everybody's.

## Notifications

You get a desktop notification when one of your pull requests merges or is
thrown out, and when somebody asks you for a review — only yours, and only for
things that happen while it is running.

Most terminals raise these themselves. Where they cannot, macOS does it through
Script Editor, which needs to be allowed under System Settings › Notifications;
installing `terminal-notifier` avoids that. `MERGEQ_NOTIFY=off` silences them.

## Where the estimate comes from

GitHub provide their own estimates for merge times which seem inaccurate and 
often overly optimistic. Instead of relying on their numbers the estimated merge
times is calculated by observing and averaging recent merge times within your
repo.

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
