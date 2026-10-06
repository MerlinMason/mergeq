# mergeq

Watch a GitHub merge queue from your terminal: what is waiting on your review,
where your pull requests are, and when they will land.

<img width="556" height="583" alt="image" src="https://github.com/user-attachments/assets/53342cb7-745f-44d8-8c3d-38636854f62a" />

## Install

You need Node 22+ and the [GitHub CLI](https://cli.github.com), logged in.
mergeq uses the token from `gh`, so it needs no setup of its own.

```bash
npx @merlinmason/mergeq        # try it
npm i -g @merlinmason/mergeq   # or install it, then run `mergeq`
```

Run it inside a checkout of the repository you want to watch, or pass `--repo`.

## What you see

- **To review**: pull requests waiting on your review, longest wait first.
- **Your PRs**: your open work, with the next thing to do at the top.
- **Queue**: where your pull requests sit in the merge queue, and when each will land.
- **Quexits**: what recently left the queue, merged or ejected, and why.

You get a desktop notification when one of your pull requests merges or is
ejected, and when somebody asks you for a review. Set `MERGEQ_NOTIFY=off` to
turn them off.

Merge times are estimated from how fast your repository has actually merged
recently, not from GitHub's own estimate.

## Keys

| | |
|---|---|
| `↑` `↓` | select a pull request |
| `⏎` | open it in the browser |
| `q` | add your approved pull request to the queue |
| `e` | eject your pull request from the queue |
| `j` | jump your pull request to the front of the queue |
| `a` | toggle between yours and everybody's |
| `o` | open the queue on GitHub |
| `x` | exit |

## Options

| | |
|---|---|
| `--repo owner/name` | repository to watch (default: `$MERGEQ_REPO`, then the current directory) |
| `--branch name` | queued branch (default: the repository's default branch) |
| `--interval 5` | seconds between refreshes, minimum 2 |
| `--all` | start on everybody's pull requests |
| `--as username` | follow somebody else's account |

## Development

```bash
bun install
bun run dev --repo owner/name   # run from source
bun run check                   # typecheck
bun run bundle                  # build dist/cli.js for npm
```

## Licence

MIT
