# AGENTS.md

What the source cannot tell you. The README covers what the app does.

## Do not mutate a real queue to find things out

`e` (eject) and `j` (jump) mutate the watched repository, usually a shared one.
Ejecting delays someone's work; a failed jump leaves their pull request out of the
queue. Read the schema instead, and let whoever is driving test on their own pull
request. `--repo` defaults to the current directory, so running it in a work
checkout points at production.

## Glyph width

Three rendering bugs here shared one cause: a character measured narrower than it
draws. Ink lays out with `string-width`, so columns shift and its cursor
arithmetic desynchronises.

- Single-codepoint emoji only — a variation selector (`U+FE0F`) breaks the match.
- Avoid `U+23xx`. `⏎` survives only in the key hints, with **two** spaces after
  it; one closes up. Don't "tidy" that whitespace.
- Measure with `string-width`, never `.length` (which counts UTF-16 units).
- Check before using a new glyph in an aligned column:
  ```bash
  bun -e 'import sw from "string-width"; const g="🔀"; console.log(sw(g), [...g].length)'
  ```

## Seeing the output

No TTY in a tool call, so use a pty:

```bash
COLUMNS=118 perl -e 'alarm 13; exec @ARGV' -- script -q /dev/null \
  bun run src/cli.tsx --repo owner/name </dev/null > /tmp/out.txt
```

Take the last frame, strip escapes, and measure with `string-width` — panel lines
should be exactly `COLUMNS - 1`:

```js
const frame = raw.split("\x1b[?2026h").at(-1);
const lines = frame.replace(/\x1b\]8;;[^\x07]*\x07/g, "")
  .split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+$/, ""));
```

- Strip `\r`, don't convert it to `\n`, or every line looks doubled.
- Don't hand-roll a width regex; `⏳`-class glyphs get undercounted and you chase
  an off-by-one that isn't there.
- Drive keys with `expect`, synchronising on `expect` rather than `sleep`. `sleep`
  doesn't drain the pty, so keys batch and Ink sees `"j\r"` as one input with
  `key.return` unset — indistinguishable from a broken handler.
- For states you can't reproduce, a throwaway harness rendering the component with
  fabricated props works. Delete it afterwards and un-export whatever it needed.
  No test files here.

## Ink 7

- `render(node, { alternateScreen: true })` exists; don't hand-roll `?1049h`. It
  stops tall frames stranding in scrollback.
- `instance.clear()` does **not** redraw. It erases, then re-seeds log-update with
  what it erased, so an unchanged render writes nothing and the screen stays blank.
  `process.stdout.emit("resize")` is the only public path to a redraw.
- Ink learns of a resize only from the stdout event, which sleep suppresses — hence
  the wake watcher in `main.tsx`.
- `useWindowSize`, `useAnimation` and `Spacer` are built in. All three were
  hand-rolled here and removed.
- `wrap="truncate"` appends an ellipsis, so it can't draw a rule.
  `overflowX="hidden"` bleeds into neighbouring rows. `PANEL_CHROME` arithmetic is
  deliberate — replacing it with flexbox has already been tried and reverted.

## One query, one clock

Every panel comes from the single `DASHBOARD` document, fired by one clock
(`useClock`), so `--interval` is the only knob. You need both. Separate timers
on an identical interval drift apart within a minute, because each waits from
when its own request finished. And even in step, the queue answers in 0.5s
while the searches take 1.5s, so the panels would paint a second apart.

GitHub prices a query by nodes, not by fields, so this costs what the cheapest
single search used to: measured `cost` is 1 at `nodeCount` 1090, against 5 for
the five calls it replaced. That is what the 2 second floor is protecting — 5000
points an hour, shared with `gh` and everything else on the same token. Measure
before widening anything:

```bash
gh api graphql -f query='query{ rateLimit{cost remaining limit nodeCount} ... }'
```

Combining costs time: the one document takes ~2.2s against ~1.5s for the
slowest of the five in parallel. Fine at a 5s tick, and the reason the floor is
2 and not lower.

`fetchChecks` stays a second round trip because it is keyed by the commit oids
the first reply carries. Folding it into the entries instead would ask for 100
entries × 100 contexts — about 100 points — so it is left conditional, and only
fires for your own queued pull requests.

## A reply can be half an answer

GraphQL returns `data` and `errors` together, so `request()` hands both back and
only `graphql()` throws. The dashboard needs the difference: a section that came
back null is named in `missing` and the hook keeps the rows it already had,
because stale rows with an honest age beat a blank panel.

The same null means opposite things depending on the company it keeps. A null
`repository` **with** errors is GitHub failing and will fix itself; the identical
null in a clean reply means the repository is not there, which is a `SetupError`
that takes over the screen. Check `errors.length` before concluding anything from
a null.

## Merge queue API

- `jump` is a flag on *joining*, not a move: `enqueuePullRequest` refuses a pull
  request already queued. Jumping is dequeue-then-enqueue, and the dequeue isn't
  immediately visible to the next call — hence the bounded retry.
- `dequeuePullRequest` takes the pull request id, not the entry id.
- No `viewerCan*` field exists for either action, so permission is only
  discoverable by trying. Ejecting needs write access; jumping is admin-only by
  default and undocumented. The error is the interface.
- The outcomes query fetches 50 because `sort:updated-desc` surfaces mostly open
  review with no queue history; at 10 it returned nothing on a busy repository.
- The merge rate is the average gap between merges over 24 hours, with each gap
  counted as at most 30 minutes. Don't switch it back to a median. GitHub merges
  pull requests in batches, so most gaps are the split second between two landing
  together, and a median picks one of those and promises a wait of almost nothing.
  The average used to read too slow for two reasons, both now fixed: quiet periods
  (the 30 minute cap) and old pull requests pulled into the sample by a recent
  comment (the `merged:>=` bound).

## Preferences

- Use the editing tools, not scripted `str.replace`: a silent no-op once left a
  dead constant and a commit message claiming otherwise.
- Comments are near zero. The ones present say why something non-obvious is
  load-bearing; leave them.
- No tests unless asked. Don't push to `main` — the `pre-push` hook asks a human,
  deliberately.
- `src/cli.tsx` exists only to set `FORCE_COLOR` from `NO_COLOR` before anything
  that draws is imported. Merging it into `main.tsx` breaks `NO_COLOR`, because
  imports hoist and chalk reads the environment on import.

## Releasing

`npm version patch|minor` then `git push --follow-tags`. The tag triggers
`.github/workflows/release.yml`, which typechecks, bundles, publishes to npm and
cuts the GitHub release. It publishes over OIDC as a trusted publisher, so there
is no npm token or one-time code in the loop. The version in the top-right corner
is inlined at build time — ask for it before debugging a rendering report.

The package is scoped because npm refuses unscoped names resembling existing ones
(`mergeq` against `merge`/`merge2`, `mergequeue` against `merge-queue`). The command
is `mergeq` regardless — that's the `bin` name.
