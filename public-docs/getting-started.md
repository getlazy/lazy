# Getting started: your first task

This page takes you from installing lazy to reviewing and merging the work of
your first agent task. It is for someone who has not used lazy before. Each
step names the command to run and what you should see; the other pages go
deeper into each part.

## What you need

- **git** and a git repository you want an agent to work on.
- **[Bun](https://bun.sh)**, to build lazy from source.
- **Docker** (Docker Desktop on a Mac). Every task's agent runs in its own
  container.
- **A model credential**, for example a Claude subscription or an Anthropic API
  key. See [Credentials](credentials.md).

## 1. Install lazy

```bash
git clone https://github.com/getlazy/lazy.git
cd lazy
bun run install:local
```

This builds lazy and installs it into `~/.lazy/bin`. If `lazy` is not found
afterwards, add that directory to your `PATH`, as the install prints.

## 2. Set lazy up in your repository

```bash
cd your-project/
lazy init
```

`lazy init` writes a `lazy.toml` at the root of your repository and sets up
where lazy keeps its task history. It detects your git remote and, for GitHub
or GitLab, offers to turn on the integration that pushes branches and opens pull
requests. It then reports the model credential it found, or tells you how to
set one up. Every setting is described in
[lazy.toml](lazy-toml.md). If something is not right, `lazy doctor` says what
and how to fix it; see [Troubleshooting](troubleshooting.md).

## 3. Create and start a task

A task is one piece of work: a goal, a prompt, and a branch of its own.

```bash
lazy create --code add-auth --goal "Add user authentication" --prompt "Use JWT tokens, bcrypt for passwords"
lazy start add-auth
```

The agent works in its own worktree and container, on its own branch. Your
checkout is not touched.

## 4. Wait for it and look at the work

```bash
lazy wait add-auth
lazy show add-auth
lazy diff add-auth
```

`lazy show` prints the task's status, the agent's report, and any questions it
raised for you. `lazy diff` shows what it changed. For a browser view, run
`lazy dashboard`; see [Reviewing in the browser](web-review.md).

To ask a question about the work without the agent changing anything:

```bash
lazy ask add-auth --message "why did you choose JWT over sessions?"
```

## 5. Give feedback, or accept

If the work needs changes, send the agent feedback and it continues:

```bash
lazy unblock add-auth --message "Store refresh tokens server-side"
```

When you are happy with it, merge it into the branch it came from:

```bash
lazy accept add-auth
```

If it should not land, `lazy reject add-auth --reason "..."` or
`lazy close add-auth --reason "..."` ends the task without merging.

## Where to go next

- [How lazy reviews work](review-paradigm.md) — what happens between the
  agent finishing and you accepting.
- [Raised items](raised-items.md) — questions and decisions an agent leaves for
  you.
- [Protected branches](protected-branches.md) — requiring your approval before
  work merges into a branch.
- [Cluster tasks](cluster-tasks.md) — letting one task drive several others.
- [Self-hosting Lazy Teams](self-hosting-lazy-teams.md) — running lazy for a
  team, in the browser.
