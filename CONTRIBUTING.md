# Contributing to sshshot

Short version: open a PR. The release pipeline is fully automated; if your PR title is in Conventional Commits format, it ships within a minute of merge.

## Local setup

```bash
git clone https://github.com/flamerged/sshshot.git
cd sshshot
corepack enable                # activates the pinned Yarn 4
yarn install                   # generates yarn.lock + node_modules
yarn build                     # tsc → dist/
yarn typecheck                 # tsc --noEmit (fast, no output)
yarn test                      # vitest
yarn lint                      # eslint (type-aware rules — slow first time)
yarn format                    # prettier --write
```

Node ≥ 20 is the runtime requirement; the project pins Node 24 for development (`.nvmrc`) so `yarn` and `npm` versions match what CI ships releases with.

## Branch + PR conventions

- **Branch names**: `<type>/<short-desc>` where `<type>` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`, `build`, `style`, `revert`. Husky's `pre-push` rejects anything else.
- **PR title**: same prefix, e.g. `feat: add X` or `fix: handle Y`. The PR-title lint workflow validates this on every PR.
- **Squash-merge only**: the PR title becomes the commit message on `master`. semantic-release reads that to decide the version bump:
  - `fix:` / `perf:` → patch release (`0.7.0 → 0.7.1`)
  - `feat:` → minor release (`0.7.0 → 0.8.0`)
  - `chore:` / `docs:` / `refactor:` / `test:` / `ci:` / `build:` / `style:` / `revert:` → no release
  - Major bumps are explicitly _not_ auto-released — tag manually when ready.
- **Signed commits**: `master` requires GPG/SSH-signed commits. Set `git config commit.gpgsign true` and configure a signing key locally before your first commit.

## Tests

Tests live under `test/` and run against the source files. Add coverage when:

- You change a regex / parser (see `test/monitor-helpers.test.ts` and `test/config.test.ts` for patterns)
- You add a pure helper (export it and write a test)
- You fix a bug (add a regression test in the same PR)

Most of `monitor.ts` is OS-specific shell-outs that aren't unit-testable in CI — those changes land with manual smoke notes in the PR description ("tested on macOS Cmd+Shift+4 → ...").

## Security issues

Don't open a public Issue. See [SECURITY.md](./SECURITY.md) for the disclosure path.

## License

MIT. By submitting a PR you agree your contribution is licensed under the same.
