# `lazy link` — adopt a pull request or branch as a task

`lazy link <ref>` turns someone else's pull request or git branch into a lazy
task you can review, comment on, and (when you choose) work on.

The task uses **that existing branch**. Lazy does not create a new `lazy/…`
branch, does not start an agent, and does not push or merge into the branch
unless you run an explicit command.

```
lazy link https://github.com/org/repo/pull/42
lazy link https://github.com/org/repo/tree/feature/auth
lazy link feature/auth
lazy link origin/feature/auth --parent auth-rewrite --code fix-auth
```

`--parent` nests the linked task under another task. `--code` sets the
human-readable id (otherwise lazy derives one from the branch name).

In the web UI, **Link…** on the Tasks list is the same flow: a form for the
URL or branch, optional parent and code. See [the web review page](web-review.md#linking-a-branch-or-pr).

## What you can pass

| Argument | What happens |
| --- | --- |
| Pull or merge request URL | Imports the title, head branch, and comments. Needs a GitHub or GitLab remote driver. |
| Branch page URL (`/tree/…`) | Treats the path after `/tree/` as the branch name. |
| `origin/feature/auth` | Fetches `feature/auth` from that remote. |
| Bare branch name | Fetches that branch (works with the local driver too). |

A pull-request URL still needs `driver = "github"` or `driver = "gitlab"` in
`lazy.toml`. A bare branch does not.

## The description lazy writes for you

Adopting a branch gives you a title and little else, so the last thing `lazy
link` does is read the work and write the task's description. It looks at the
pull request body, the comments and review threads, the commits on the branch,
and the diff against the base branch, and writes a prompt saying what the branch
does, how far it got, what reviewers asked for, and what is still open.

That prompt is what you see on the task page and in `lazy show`, and it is what
an agent is handed when you `lazy unblock` the task — so work can continue
without anyone reconstructing the branch from its diff first.

On a project where every member runs on their own Claude account (Lazy Teams),
that model run is billed to whoever linked the branch, and a member with no
account connected is refused before anything is linked — **Link a branch** on
the Tasks page is the same flow there.

Writing it needs a model, so it is the one part of linking that can fail on its
own (no credential, no network). When it does, **the link still succeeds** — you
get a warning, and you can write the description afterwards:

```
lazy describe fix-auth
```

`lazy describe <task>` works on any linked task, as many times as you like. Run
it again after the branch has moved on to refresh the description; the previous
one is kept as a prompt version. It never writes to the linked branch.

If you have edited the prompt yourself since lazy wrote it — say you replaced the
summary with your own instructions — `lazy describe` asks before replacing it, and
`--yes` answers for you in a script. Every description carries a line saying when
lazy wrote it and which branch or pull request it came from, so you can always
tell lazy's summary from words you or the PR author wrote.

The description is written from the branch's own work: its commits and its diff
against the branch it would merge into, resolved the same way `lazy diff` and
`lazy accept` resolve it. So upstream commits a long-lived PR has merged in are
not described as if this branch had written them. When lazy cannot read some of
the material — an unreachable forge, a branch with no comparable base — it says
so in a warning instead of quietly describing less.

One thing it deliberately leaves alone: when the task came from a pull request,
its **title stays the goal**. Those are the author's words about their own work.
For a branch with no pull request — where the goal would otherwise be the branch
name — lazy writes a real one-line goal.

## After you link

The new task starts **blocked** — ready for review or for you to start work.
`lazy show`, `lazy list`, and the task page mark it as linked and show the
branch (and the PR, once one is known), with the generated description as the
task's prompt.

If you linked a branch that has no pull request yet, lazy keeps looking during
its normal remote check. When someone opens a PR for that branch later, the
task picks it up. Lazy does not open a PR for you.

## What linked does *not* do

- It does not start an agent.
- It does not auto-sync or auto-push the branch. `lazy sync` and `lazy accept`
  stay explicit: that branch belongs to someone else until you decide otherwise.
  An agent cannot sync a linked task (that would merge into someone else's
  branch). A human or the builder still can.
- It does not rewrite the branch name to `lazy/<task>`.

From an agent, `lazy_link` can only create a child of the agent's own task —
the same parent rule as `lazy_create`. It writes the description the same way
`lazy link` does; re-writing one later is a human verb only (see
[surface asymmetries](surface-asymmetries.md)).
