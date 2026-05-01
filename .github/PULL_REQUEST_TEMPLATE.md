<!--
PR title format: `<type>: <description>` (Conventional Commits) or
`<type>: [TICKET-123] <description>` if you're tracking against an issue.

Allowed types:
  feat:     a new feature       → minor release on merge
  fix:      a bug fix           → patch release on merge
  perf:     a performance fix   → patch release on merge
  chore:    tooling/deps        → no release
  docs:     docs only           → no release
  refactor: no behavior change  → no release
  test/ci/build/style/revert    → no release

Branches must be named `<type>/<short-description>` (Husky enforces this).
Master is squash-merged so the PR title is what lands as the commit message
on master — semantic-release reads that to decide the version bump.
-->

## What

<!-- One-sentence summary of the change. -->

## Why

<!-- The problem this solves, the context, etc. Skip if obvious from the title. -->

## Test plan

<!-- How a reviewer can verify this. -->

- [ ] `yarn lint && yarn typecheck && yarn test && yarn build` passes locally
- [ ] Smoke-tested on at least one platform (note which one)
