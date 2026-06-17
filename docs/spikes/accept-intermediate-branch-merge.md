# Spike: Does `accept` route subtask→parent (intermediate-branch) merges through an MR/PR?

**Date:** 2026-05-27
**Status:** Investigation complete — read-only, no code changed.

## Question

When `lazy accept` merges a subtask into a non-protected intermediate parent
branch (e.g. a child whose parent is `lazy/release-v017`, itself a child of
`lazy/release-v016`), does it create a remote MR/PR, or do a local git merge?

## Answer (definitive)

**It creates a remote MR/PR.** When `config.remote.driver = "gitlab"` (or
`github`), *every* accept — including subtask→intermediate-parent merges —
goes through the remote driver's `merge()`, which creates/uses an MR/PR and
merges via `glab mr merge` / `gh`. There is **no** local-vs-remote routing
based on whether the target branch is protected or is an intermediate task
branch. The observed behavior (GitLab MR #451 for parent `lazy/release-v017`,
task parked in `merging` until CI passed) is exactly what the code does today.

## What determines MR/PR vs local merge

The merge mechanism is determined **solely by `config.remote.driver`**, chosen
once and applied to all merges:

- `createDriver()` switches purely on `config.remote.driver`
  (`src/remote/index.ts:33-42`). The only override is `offline` mode, which
  forces `LocalDriver` (`src/remote/index.ts:29-31`). There is no per-target
  driver selection.
- `acceptTask` builds that single driver
  (`src/daemon/task-lifecycle.ts:1420`) and calls `driver.merge(...)`
  unconditionally for the actual merge (`src/daemon/task-lifecycle.ts:1717`).
  Nothing between preflight and the merge call routes to a local merge based on
  branch protection or task hierarchy.
- `GitLabDriver.merge()` always pushes, ensures an open MR (creating one if
  needed), and runs `glab mr merge --squash --auto-merge`
  (`src/remote/gitlab-driver.ts:333-438`). It has no protected-branch or
  intermediate-branch detection — it unconditionally drives an MR.

### What the hierarchy and protection checks actually do (and don't do)

- `isChildTask` / `mergeTargetBranch` (preflight,
  `src/daemon/task-lifecycle.ts:1318-1339`) only choose the **target branch**
  (parent's branch for a child, else `main`). They do **not** influence the
  merge mechanism.
- `targetIsProtected = driver.isTargetBranchProtected(mergeTargetBranch)`
  (`src/daemon/task-lifecycle.ts:1620-1637`) is consulted **only** for the
  approval gate — i.e. whether an external approval is required before merging,
  and whether to auto-approve (`src/daemon/task-lifecycle.ts:1671-1678`). A
  *non-protected* target simply skips the approval requirement; it still merges
  through the same remote MR path. Protection is never used to switch to a
  local git merge.
- `GitLabDriver.isTargetBranchProtected()` queries the GitLab API
  `protected_branches` endpoint (`src/remote/gitlab-driver.ts:1105-1107`).
- Note: `config.permissions.protected` (`src/config/loader.ts:287-289`) is an
  unrelated concept — **file** glob patterns used by supervisor violation
  detection (`src/supervisor/permissions.ts`), not branch protection. It plays
  no role in merge routing.

## Intended behavior, or a gap?

**Genuine gap vs the CLAUDE.md invariants.** CLAUDE.md states:

> ### PRs only for protected branches
> PRs/MRs should only be created when merging into a branch with protection
> rules. Subtask→parent merges should be local git operations, not remote MRs.

The current accept flow does not implement this. With a hosted driver, the
local-vs-remote decision is made once at the driver level (`config.remote.driver`)
and never reconsidered per-merge. So subtask→parent merges into a non-protected
intermediate branch create MRs — contradicting the invariant. The
`isTargetBranchProtected` signal needed to honor the invariant is already
computed but is only wired into the approval gate, not into merge routing.

## Minimal fix sketch (not implemented)

The decision point already exists. In `acceptTask`, `targetIsProtected` is
computed at `src/daemon/task-lifecycle.ts:1624-1626` for any driver where
`driver.needsSync` is true. The minimal change: **when the target branch is not
protected, perform the merge locally instead of via the remote driver.**

Sketch:

1. Compute `targetIsProtected` unconditionally for `needsSync` drivers (today
   it is, inside the `if (driver.needsSync)` block at line 1625).
2. Choose the merge driver for the actual merge step:
   - If `targetIsProtected` (or driver is already `LocalDriver`) → use the
     configured `driver` as today.
   - Else → use a `LocalDriver` instance for the `merge()` /
     `fastForwardLocal()` path. A local squash merge into the parent branch is
     immediate and never `pending`, so the task completes in one pass instead of
     parking in `merging` waiting on CI.
3. Skip the remote-only steps that only make sense for the MR path when merging
   locally: auto-create-PR (Step 2, lines 1639-1669), pre-merge gate checks
   (Step 3), parent-branch push (Step 4 — `LocalDriver.pushBranch` is already a
   no-op so this is naturally inert), and `postAcceptReview`.

Design decisions the human should weigh before implementing:

- **Where the switch lives.** Cleanest is a single `mergeDriver` selected in
  `acceptTask` right after `targetIsProtected` is known, leaving `createDriver`
  untouched. Avoid pushing the branch logic down into each remote driver's
  `merge()` — that scatters the policy and the local driver wouldn't know about
  protection anyway.
- **Fidelity records.** The remote path keeps fidelity in the MR/PR body
  (`regenerateFidelity`, Step 4b). For a local merge, fidelity must be carried
  into the squash commit via `MergeOptions.fidelityBody` (LocalDriver already
  supports this, `src/remote/local-driver.ts:35,68`). Confirm the parent's
  hosted-body fidelity is still regenerated when that parent itself later merges
  to a protected branch.
- **Re-entry / `merging` state.** Local merges never return `pending`, so the
  intermediate branch won't sit in `merging`. The existing `merging` re-entry
  block (lines 1468-1618) is remote-only and would simply never trigger for
  locally-merged tasks — fine, but worth an explicit test asserting a
  non-protected subtask accept completes synchronously.
- **Determining "protected" offline / without API access.** `isTargetBranchProtected`
  makes a GitLab/GitHub API call. If it fails or is unavailable, decide the safe
  default. Per CLAUDE.md "Defaults are safe", failing toward the remote MR path
  (current behavior) is conservative for protected branches, but defeats the
  invariant for intermediate branches. Consider treating a known
  task-branch target (`isChildTask` with a `lazy/...` parent branch) as
  non-protected without an API round-trip.

No code was changed. Recommend a follow-up task to implement the routing per the
sketch above, with e2e coverage: (a) child→non-protected-parent accept does a
local merge and completes synchronously (no MR), and (b) root→protected-`main`
accept still creates an MR/PR.
