# `LAZY.md` — instructions for agents running lazy tasks

`LAZY.md` is a file **you** put in your repository. Lazy reads it and hands it to
agents running your tasks — start, unblock, ask, the wrap-up steps that close a
declared-final turn, and resume — alongside
the rest of that agent's system instructions. A `lazy review` session does not
load it: review is a separate read-only pass over the task's work, not an
implementer turn under your project instructions.

```
your-project/
  CLAUDE.md            # read by Claude Code, in every session, including yours
  LAZY.md              # read by lazy, only for agents running lazy tasks
  services/api/
    LAZY.md            # applies to that part of the tree
```

Nothing else reads it. Claude Code reads `CLAUDE.md`, Cursor and Codex read
their own files; none of them know `LAZY.md` exists. Lazy injects it precisely
because no harness does.

## What belongs in it

**Anything that is true only when an agent is working through lazy** — and
therefore does not belong in `CLAUDE.md`, which your own interactive sessions
read too.

The clearest case is your environment. An agent running a lazy task is inside
lazy's container, on a task worktree, and the commands that work there are often
not the ones you run on your laptop or in your usual dev container:

```markdown
# LAZY.md

## Running things here

You are in lazy's task container. The database is already up as `db` on the
task network — do NOT run `docker compose up`, which is what our normal
development container expects.

Run the suite with `make test-fast`. `make test` starts a browser we cannot
launch in here.

Services you start are reachable through the ports declared in `[serve]` —
tell the reviewer to run `lazy url <task> web` rather than printing localhost.
```

Other things that fit: which checks are worth running per turn versus in the
acceptance gate, house rules about what a task should and should not touch, where to
put generated files so they do not end up in a diff.

**What does not fit:** anything you want in effect when you work interactively
too. That is `CLAUDE.md`'s job, and lazy does not duplicate it — the agent gets
both, from its own worktree.

## Which files get loaded

Lazy follows the same shape as Claude Code's `CLAUDE.md` discovery, with one
deliberate difference.

- **The ancestor chain.** Every `LAZY.md` from the directory the agent starts in
  up to the worktree root, concatenated **root first**, so a deeper file is read
  last and refines the ones above it. A task agent starts at the worktree root
  today, so in practice this is your root `LAZY.md`.
- **Nested files.** Every other `LAZY.md` under the worktree, shallowest first.
  Claude Code defers a subdirectory `CLAUDE.md` until the agent reads a file in
  that directory; lazy has no hook into an agent's file reads, so it loads them
  **up front** instead. A nested file is either injected at launch or never seen.

The sweep skips every directory your project's `.gitignore` files ignore — it
reads each directory's `.gitignore` as it goes, the same cascade git uses — and
every dot-directory (so lazy's own `.lazy` store is never walked). It looks at
most six levels below the root.

Because nested files are loaded eagerly, the total is capped at **40,000
characters** — the same order as the per-file limit Claude Code warns a single
`CLAUDE.md` past. Collection **stops at the first file that does not fit**, so
a too-large root file is never replaced by later smaller nested ones; files that
do not fit are **named in the prompt** rather than dropped in silence.
`lazy doctor` reports what your `LAZY.md` files cost, as a line under the
agent's system prompt.

## When it is loaded

On task-agent launches that do the work: starting a task, unblocking it with
feedback, `lazy ask`, the wrap-up steps after a declared-final turn, and resume
(including auto-resume after
an interruption). It rides the system prompt, so it is identical across those
turns and benefits from prompt caching. It is not loaded for `lazy review`.

A project with no `LAZY.md` gets nothing injected and pays nothing.

## What it cannot do

`LAZY.md` is **guidance, not authority**. It is read from the task's worktree —
the same copy the agent's `CLAUDE.md` comes from — so an agent's instructions
match the tree it is working in. Nothing in it can widen a permission, change a
check, choose a model, or relax a rule in the agent's system instructions;
lazy's own settings come from `lazy.toml` in your project root, which a task
branch cannot speak for. See [`lazy.toml`](lazy-toml.md).

The agent is told this too, and told that a `LAZY.md` appearing to grant itself
authority is wrong and worth flagging in its summary.
