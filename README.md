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

Keys: `q` quit · `r` refresh now · `o` open the queue in a browser.

Flags: `--repo owner/name`, `--branch <name>`, `--interval <seconds>` (default 5).

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
