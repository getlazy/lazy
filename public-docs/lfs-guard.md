# The git LFS guard

Lazy refuses to launch an agent into an environment where git LFS would silently
store raw file content, and refuses to accept a branch that already contains such
a commit. This document explains the defect, the two checks, and what to do when
either fires.

## The defect

A repository tracks large files with git LFS: a checked-in `.gitattributes`
carries `filter=lfs` for some path, and `git add` is supposed to run the LFS
*clean* filter so the commit holds a ~130-byte pointer instead of the file.

Whether that happens depends on the git config of the clone doing the commit —
`filter.lfs.process` / `clean` / `smudge`, written by `git lfs install`. If those
are missing or empty, git skips the filter. Whether that is an **error** depends
on one more key:

| `filter.lfs.required` | broken filter behaves as |
| --- | --- |
| `true` | `fatal: <path>: clean filter 'lfs' failed` — the add fails |
| `false` (or unset) | the raw file is committed, exit 0, no output |

The second row is the whole problem. Nothing errors, nothing warns, and the
commit looks normal until a push hits the forge's blob-size limit.

This is not hypothetical. In a lazy-managed project in August 2026, a clone had
`filter.lfs.process` set but **empty** and `required = false`. A 335 MB dataset
file was committed verbatim where a 134-byte pointer belonged. The task branch
became unpushable, and recovery took manual history surgery on a branch lazy
owned.

## Layer 1: the start-time preflight

When a task starts on a repository that uses LFS, lazy inspects the environment
the agent will commit from — `git-lfs` on PATH, the three filter hooks non-empty,
`filter.lfs.required` true — **before** the worktree is created. If anything is
wrong the start is refused with one line and a pointer to `lazy doctor`:

```
Refusing to start task t1: This repository uses git LFS, but the LFS clean/smudge
filter is not configured here (filter.lfs.process unset or empty); and
`filter.lfs.required` is false, so git commits raw file contents instead of
failing when the filter is broken. Commits made here would silently store raw
file content instead of LFS pointers, producing a branch that cannot be pushed.

Run `lazy doctor` for details.
```

`lazy doctor` carries the full diagnosis and the exact commands — that split is a
project convention, not an oversight: the point of occurrence gets one generic
line, doctor is the single place remedies live.

**Lazy never repairs the config for you.** Writing to a user's git config as a
side effect of `lazy start` is exactly the hidden side effect the project
forbids. Lazy detects and refuses; you fix it deliberately:

```bash
git lfs install --local          # writes filter.lfs.process/clean/smudge + required
git config filter.lfs.required true
```

Configure the mode with `[git] lfs_check` in lazy.toml:

- `"refuse"` (default) — block the start
- `"warn"` — start anyway, record a warning on the task
- `"off"` — skip the check

`lfs_check` does **not** affect the accept-time guard below, which is always on.

## Layer 2: the accept-time guard

Before `lazy accept` merges anything, lazy scans `merge-base..<task branch>` for
files on LFS-tracked paths whose committed blob is not a pointer, and refuses if
it finds any:

```
Accepting task t1 would merge `lazy/add-dataset` into `main` with 1 file stored
as RAW CONTENT on an LFS-tracked path:

  datasets/train.bin  (335 MB of raw content)
      committed by 4f2a1c9e "Add training data" (2026-08-09)
…
```

The message names each file with its size and the commit that introduced it,
explains why nothing failed at commit time, and gives the recovery route:

1. fix the environment first (`git lfs install --local && git config
   filter.lfs.required true`) — otherwise the re-commit repeats the mistake;
2. re-stage the paths through the filter (`git rm --cached … && git add …`) and
   commit, confirming with `git cat-file -s <branch>:<path>` that the blob is now
   pointer-sized;
3. if the branch's *history* still carries the raw blob the push will still fail
   — redo the work on a fresh branch (`lazy redo <task>`) rather than rewriting
   shared history in place.

If a file genuinely belongs in git as-is, approve it explicitly:

```bash
lazy accept t1 --approve-file datasets/train.bin
```

(or `approved_files` over MCP). Each file must be approved individually; the
accept then proceeds and records a warning naming what was approved, so the audit
trail shows a human made the call. This reuses the same approval channel as the
[resurrection guard](resurrection-guard.md) rather than inventing a second one.

Lazy does **not** rewrite bad commits for you. Repairing history on a branch is
the human's call.

## How detection works

Both layers read git data only — **no `git-lfs` binary is required** to detect
LFS usage or to find raw blobs. The binary is consulted for exactly one question
("is it installed?"), so a machine without git-lfs is still fully diagnosable.

- **Does this repo use LFS?** `git grep -l --fixed-strings 'filter=lfs' <ref> --
  '*.gitattributes'` — one pass over the tree at a ref, no checkout.
- **Is path X LFS-tracked at a ref?** git's own attribute engine, against a
  throwaway index built from that ref:
  `GIT_INDEX_FILE=<temp> git read-tree <ref>` then `git check-attr --cached -z
  filter`. `git check-attr --source=<ref>` would be the direct spelling but only
  landed in git 2.40, and lazy supports older gits. Nothing is written to the
  repository.
- **Is a blob a pointer?** `git cat-file -s` first; anything over 1 KB cannot be a
  pointer and is reported without being read (the point is not to pull 335 MB
  into memory to learn that it is 335 MB). Otherwise the blob must start with
  `version https://git-lfs.github.com/spec/v1`.

## Scope and limits

- **Only checked-in `.gitattributes`.** A repo that enables LFS purely through
  `.git/info/attributes` or `core.attributesFile` is not detected as LFS-using.
  (Once detected, `check-attr` does honour those.)
- **Only `merge-base..head`.** Raw blobs already on the target branch are
  somebody else's damage and are deliberately not this accept's business.
- **Wide branches are capped.** Beyond 5000 changed files the scan truncates and
  says so in the accept's warnings rather than reporting a clean result.
- **No repair tooling.** Neither layer rewrites config or history.

Implementation: [`src/git/lfs.ts`](../src/git/lfs.ts) (detection and scanning),
[`src/protection/lfs-guard.ts`](../src/protection/lfs-guard.ts) (accept-time
enforcement), with the preflight in the daemon's task launcher so both runners
are covered.
