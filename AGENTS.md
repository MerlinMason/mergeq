# AGENTS.md

Notes for anyone — human or otherwise — picking this up. The README says what the
app does; this says what has already been learned the hard way.

## Never mutate a real queue to find something out

`e` (eject) and `j` (jump) call GraphQL mutations against whatever repository is
being watched, which in practice is a shared one. A dequeue delays somebody's
work; a failed jump leaves their pull request out of the queue entirely. Do not
fire them to explore behaviour. Read the schema, reason, and let the person
driving test on a pull request they own.

The same applies to `--repo` defaults: the app resolves the current directory's
repository, so running it inside a work checkout points it at production.

## Glyph width is the recurring bug

Three separate rendering faults in this project came from one cause: a character
whose measured width and drawn width disagree. Ink lays out using `string-width`;
if a terminal draws something wider, every column to its right shifts and Ink's
cursor arithmetic stops matching what is on screen.

Rules that hold:

- **Single-codepoint emoji only.** A variation selector (`U+FE0F`) makes the two
  disagree. `⏱️` and `🌶️` both had to be replaced.
- **Avoid `U+23xx`.** `⏱️` and `⏎` measure narrow and draw wide in Warp. `⏎`
  survives only in the key hints, and only with **two** spaces after it — a single
  space closes up. Do not "tidy" that whitespace.
- **Measure with `string-width`, never `.length`.** `.length` counts UTF-16 units.
- Check a new glyph before using it in an aligned column:
  ```bash
  bun -e 'import sw from "string-width"; const g="🔀"; console.log(sw(g), [...g].length)'
  ```

## How to actually look at the output

There is no TTY in a tool call, so run it under a pty and measure:

```bash
COLUMNS=118 perl -e 'alarm 13; exec @ARGV' -- script -q /dev/null \
  bun run src/cli.tsx --repo owner/name </dev/null > /tmp/out.txt
```

Then strip escapes and measure with the same library Ink uses — every panel line
should be exactly `COLUMNS - 1`:

```js
const frame = raw.split("\x1b[?2026h").at(-1);          // last rendered frame
const lines = frame.replace(/\x1b\]8;;[^\x07]*\x07/g,"")  // hyperlinks
  .split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,"").replace(/\s+$/,""));
```

Two traps: strip `\r` rather than converting it to `\n`, or every line appears
doubled; and do not hand-roll a width regex, or `⏳`-class glyphs get undercounted
and you will chase an off-by-one that is not there.

To drive keys, use `expect` — but synchronise with `expect`, not `sleep`. `sleep`
does not drain the pty, so keystrokes batch and Ink receives `"j\r"` as one input
with `key.return` unset. That looks exactly like a broken key handler.

Anything only reachable through unreproducible state (a specific queue shape, a
confirmation screen) is worth a throwaway harness that imports the component,
renders it with fabricated props, and is **deleted afterwards** — temporarily
exporting the component and un-exporting it after. Do not leave test files behind;
they are not wanted here.

## Ink 7 specifics

- `render(node, { alternateScreen: true })` exists. Do not hand-roll `?1049h`.
- `instance.clear()` **does not force a redraw.** It erases and then re-seeds
  log-update with what it erased, so an unchanged render writes nothing and the
  screen stays blank. To force one, `process.stdout.emit("resize")` — Ink's resize
  handler resets `lastOutput` and redraws, and is the only public path to it.
- Ink only notices a resize from the stdout event. Sleep suppresses it, which is
  why waking emits one.
- `useWindowSize`, `useAnimation` and `Spacer` are built in; all three were
  hand-rolled here once and removed.
- `wrap="truncate"` appends an **ellipsis**, so it cannot draw a rule.
  `overflowX="hidden"` bleeds into neighbouring rows. Rules are computed from
  `width` minus `PANEL_CHROME` — the arithmetic is deliberate, not laziness.
- Frames taller than the viewport get stranded in scrollback; the alternate screen
  is what prevents it.

## GitHub merge queue facts that cost time

- **`jump` is not a move.** It is a flag on joining, so `enqueuePullRequest`
  refuses a pull request already in the queue. Jumping is dequeue-then-enqueue,
  and the dequeue is not always visible to the next call — hence the bounded
  retry.
- **`dequeuePullRequest` takes the pull request id**, not the queue entry id.
- **No `viewerCan*` field exists** for either action, so permission is only
  discoverable by trying. Ejecting needs write access; jumping is admin-only by
  default and documented nowhere. The error is the interface.
- **`sort:updated-desc` is a poor proxy for "recently queued".** The outcomes
  query fetches 50 because the most recently *updated* pull requests are mostly
  open review with no queue history — at 10 it returned nothing at all on a busy
  repository. Do not trim it without checking against a real queue.
- **The merge rate is a median of consecutive gaps, not a mean.** A mean over the
  window read three times too slow on a real repository, because merges are not
  evenly spread and one stale row poisons it.

## Working preferences

- Use the editing tools, not scripted `str.replace`. A silent no-op once produced
  a dead constant plus a commit message claiming otherwise.
- Comments are near zero by default. The ones that exist say *why* something
  non-obvious is load-bearing; leave those.
- Do not add tests unless asked.
- Do not push to `main` — a `pre-push` hook asks a human to confirm, deliberately.
- `src/cli.tsx` exists **only** to translate `NO_COLOR` into `FORCE_COLOR` before
  anything that draws is imported. Collapsing it into `main.tsx` silently breaks
  `NO_COLOR`, because imports hoist and chalk reads the environment on import.

## Releasing

`npm version patch|minor` then `npm publish --otp=<code>` (2FA is on, so the code
is required) and `git push --follow-tags`. The version in the top right corner is
inlined at build time, which is how you tell which build somebody is running —
ask for it before debugging a rendering report.

The package is scoped because npm blocks unscoped names resembling existing ones:
both `mergeq` and `mergequeue` were refused against `merge`/`merge2` and
`merge-queue`. The command stays `mergeq` regardless, since that is the `bin` name.
