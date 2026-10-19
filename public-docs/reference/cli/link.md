# lazy link

This page is generated from `lazy link --help`.

```text
Usage: lazy link <ref> [--parent <task_id>] [--code <code>]

Link a pull request or a git branch as a lazy task.

Arguments:
  <ref>              PR/MR URL, branch URL, <remote>/<branch>, or a branch name

Options:
  --parent <task_id>  Set a parent task for the linked task
  --code <code>       Human-readable code (e.g. "fix-auth", "add-login")

A PR URL needs a remote driver (driver = "github" or "gitlab" in lazy.toml).
A bare branch works with the local driver too.

Supported patterns:
  GitHub PRs:     https://github.com/<owner>/<repo>/pull/<number>
  GitLab MRs:     https://gitlab.com/<owner>/<repo>/-/merge_requests/<number>
  Branch URLs:    https://github.com/<owner>/<repo>/tree/<branch>
  Bare branch:    feature/auth   or   origin/feature/auth

What happens:
  1. The argument is classified as a PR URL, a branch URL, or a branch
  2. A PR URL is imported (title, branch, comments). A branch is fetched
     and an open PR for it is attached when one exists
  3. A lazy task is created on that existing branch (not a new lazy/ branch)
  4. The task starts in blocked status — it is never auto-started
  5. A PR opened later is attached by the daemon's periodic forge pass

A linked branch is never auto-synced or auto-pushed. Sync or merge into it
is an explicit command (lazy sync / lazy accept).

Examples:
  lazy link https://github.com/org/repo/pull/42
  lazy link https://github.com/org/repo/tree/feature/auth
  lazy link feature/auth
  lazy link origin/feature/auth --parent auth-rewrite --code fix-auth

Documentation: https://docs.getlazy.dev/link
```
