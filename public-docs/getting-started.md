# Getting started: your first task

By the end of this page you will have installed lazy, set it up in a repository,
and worked with the builder in your terminal to take one agent task from
creation through review to a merge. It is for someone who has not used lazy
before, and it is the command-line path. Prefer a browser? Start with the
[dashboard tutorial](tutorials/dashboard.md) or the
[Lazy Teams tutorial](tutorials/lazy-teams.md).

## What you need

- **git** and a git repository you want an agent to work on.
- **[Bun](https://bun.sh)** 1.4.3 or newer, to build lazy from source.
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

Run it in a git repository that has at least one commit, in an interactive terminal. `lazy init` asks where to keep task history and, if it detects a GitHub or GitLab remote, whether to configure that integration; answer the prompts. If your project has a README or a Dockerfile it also offers to create starter tasks, which you can decline. You should end with `Initialized lazy in …`, a `Storage:` line and a "Checking authentication…" report.

`lazy init` writes a `lazy.toml` at the root of your repository and sets up
where lazy keeps its task history. It detects your git remote and, for GitHub
or GitLab, offers to turn on the integration that pushes branches and opens pull
requests. It then reports the model credential it found, or tells you how to
set one up. Every setting is described in
[lazy.toml](lazy-toml.md). If something is not right, `lazy doctor` says what
and how to fix it; see [Troubleshooting](troubleshooting.md).

`lazy init` also keeps lazy's own runtime files out of git by adding them to your `.gitignore` (commit it) and to `.git/info/exclude`.

## 3. Create and start a task

A task is one piece of work: a goal, a prompt, and a branch of its own. In the
terminal you hand that to the builder, a conversation with an agent that has
lazy's tools. Start it from your repository:

```bash
lazy builder
```

In an interactive terminal it shows what the builder can reach and asks you to
type `yes`; pass `--yes` to skip that. See [How to use a builder](how-to/use-a-builder.md)
for the options.

Then ask in plain words:

> Create a task to add user authentication, using JWT tokens and bcrypt for
> passwords, and start it.

The builder creates the task and starts an agent on it. The agent works in its
own worktree and container, on its own branch, so your checkout is not touched.

Where the finished work will land is fixed when the task is created. A top-level task targets your repository's default integration branch (`origin/HEAD`, or `main` if that is not set). Your current checkout is never adopted silently, even if you are on a feature branch. A subtask targets its parent task. To target another branch, create the task with `--parent <branch>`; you can tell the builder to do that.

## 4. Wait for it and look at the work

Ask the builder to wait for the task and show you what it did:

> Wait for it, then show me the report and the diff.

When the agent has finished, the task is `blocked`: it is waiting for you. The
builder reads the agent's report and the actual changes, and tells you what it
found. Ask it anything about the work, for example "why JWT over sessions?".

To look yourself, run `lazy dashboard` and open the task's **Current review**;
the [dashboard tutorial](tutorials/dashboard.md) walks through it.

## 5. Give feedback, or accept

If the work needs changes, tell the builder what to change:

> Tell it to store refresh tokens server-side.

The builder sends your feedback to the agent, which continues. When you are
happy with it, ask the builder to accept the task. That merges it into the
task's target (see step 3), so check with the builder where it will land before you ask.

If you turned on branch protection during `lazy init`, a merge into your default branch needs you: the builder's accept is refused, so run `lazy accept <task>` yourself in a terminal and type your approval passphrase (set it once with `lazy system passphrase set`). See [Protected branches](protected-branches.md).

If it should not land, tell the builder to reject or close
the task instead.

## Doing it by hand

The builder drives the same commands you can run yourself. They are useful in
scripts, or when you want one step without a conversation:

```bash
lazy create --code add-auth --goal "Add user authentication" --prompt "Use JWT tokens, bcrypt for passwords"
lazy start add-auth
lazy wait add-auth
lazy show add-auth
lazy diff add-auth
lazy ask add-auth --message "why did you choose JWT over sessions?"
lazy unblock add-auth --message "Store refresh tokens server-side"
lazy accept add-auth
```

- `lazy create` leaves the task in the backlog; `lazy start` launches the agent.
  `--parent <branch>` targets a branch other than the default, and `--parent <task>`
  makes a subtask.
  Without the flags, `lazy create` asks for the goal and opens your `$EDITOR`
  for the prompt.
- `lazy wait` blocks until the task stops working and exits 0 when it is
  `blocked`. It gives up after 600 seconds with exit code 1; the task keeps
  running, so run it again. `--follow` streams the agent's output meanwhile.
- `lazy show` prints the status, the agent's report and any questions it raised;
  `lazy diff` summarises the changes and `lazy diff add-auth --full` shows all
  of them.
- `lazy ask` asks a question without the agent changing anything.
- `lazy reject add-auth --reason "..."` or `lazy close add-auth --reason "..."`
  ends a task without merging.

## Where to go next

- [Dashboard tutorial](tutorials/dashboard.md) — the same journey in the
  browser, with screenshots of every step.
- [How to use a builder](how-to/use-a-builder.md) — resuming sessions, models and
  options.
- [How to review and accept a task](how-to/review-and-accept.md) and
  [How to give feedback](how-to/give-feedback.md) — the everyday steps in detail.
- [How lazy reviews work](review-paradigm.md) — what happens between the
  agent finishing and you accepting.
- [Raised items](raised-items.md) — questions and decisions an agent leaves for
  you.
- [Protected branches](protected-branches.md) — requiring your approval before
  work merges into a branch.
- [Cluster tasks](cluster-tasks.md) — letting one task drive several others.
- [Self-hosting Lazy Teams](self-hosting-lazy-teams.md) — running lazy for a
  team, in the browser.
