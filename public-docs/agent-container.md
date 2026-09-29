# The agent container

Every task's agent runs in a Docker container of its own. This page is for anyone
whose agents need tools the default image does not have, or who is diagnosing an
agent that cannot start: what the default image contains, how to give your
project its own image, and when lazy rebuilds it.

## The default image

A project with no `[docker] dockerfile` in its `lazy.toml` runs agents in lazy's
default image, `lazy-runner`, which is deliberately minimal. It is Debian
(bookworm-slim) with:

| Package | Why |
| --- | --- |
| `git`, `curl`, `jq`, `wget`, `unzip`, `less`, `openssh-client`, `gnupg`, `sudo` | Basic tools |
| Chromium (`$CHROME_BIN`) | Screenshots for visual checks of UI work |
| Claude Code | The agent binary |

The agent runs as `user`, with passwordless `sudo`, so it can install what it
needs for one task. Agents other than Claude Code get their own variant of this
image with their binary added. Lazy itself is never baked into an image: it is
mounted in when the container starts, so an image never pins you to an older
lazy.

To see exactly what the default image is built from:

```bash
lazy system export-dockerfile --stdout
```

## Giving your project its own image

When agents keep installing the same toolchain (a language runtime, a database
client, your project's dependencies), build it into an image instead. Write a
Dockerfile, usually starting from the default image, and point `lazy.toml` at
it:

```dockerfile
FROM lazy-runner
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends postgresql-client
```

```toml
[docker]
dockerfile = "Dockerfile.lazy"
```

The path is relative to the project root. If `FROM lazy-runner` names a base
image that is not built yet, lazy builds it first. The build is done by the
daemon on your machine, from the project root's copy of the file; an agent
editing the Dockerfile on its task branch does not change the image your tasks
run in. All `[docker]` settings, including `build_inputs` (rebuild when a
lockfile changes), are in [lazy.toml](lazy-toml.md#docker).

If your task containers need to be *created* with extra Docker flags (for
example `--cap-add=SYS_PTRACE`), that is `[docker] run_args` — a container
setting, not an image one, so no Dockerfile change can provide it.

### Scripts that call `node`

`bun install` writes `node_modules/.bin/*` shims that start with
`#!/usr/bin/env node`. If your image has no `node` (the default image has none),
any `package.json` script that runs a dependency's CLI by name — `tsc --noEmit`,
`eslint .` — fails with **exit 127** before the tool runs. Either install node
in your image, or run the tool's entry module through bun:

```json
"typecheck": "bun node_modules/typescript/lib/tsc.js --noEmit"
```

Watch for this in `[checks] post_turn`: a check whose scripts all exit 127
checks nothing.

## The headless browser

Agents find the browser through `$CHROME_BIN` (and `chromium` on `PATH`). If you
build your own image from something other than `lazy-runner`, set `CHROME_BIN`
too, so agents do not try to install a browser in every task. Rendering an HTML
file to an image is one command:

```
"$CHROME_BIN" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1280,1600 --screenshot=/tmp/shot.png file:///tmp/page.html
```

Chromium logs D-Bus and GPU warnings on every run in a container; they are noise,
not failure. The exit code and a non-empty output file are the signals.

## Rebuilding

Lazy names a custom image after the content of its Dockerfile
(`lazy-custom-<hash>`), so editing the Dockerfile in the project root rebuilds
it on the next task launch — no manual step.

A Dockerfile's text says nothing about what it *pulls*: the same file builds a
different image a month later. So lazy also rebuilds on two schedules:

- **`lazy upgrade` always rebuilds**, from scratch.
- **After 14 days**, the next task launch rebuilds an older image once, without
  the build cache.

The image *tag* is lazy's major.minor version (for example
`lazy-custom-<hash>:0.22`); it is an identity, not a freshness signal.
`lazy doctor` lists older images left behind. What happens during a rebuild, and
how to watch it, is in [Image rebuilds on upgrade](upgrade-image-rebuild.md).

## When an agent cannot start

`lazy doctor` checks the container runtime, the image and the agent binary, and
says what to fix. The most common causes:

- **Docker is not running.** Start Docker Desktop (or your Docker daemon) and
  retry.
- **The image failed to build.** The build output names the failing step; fix
  your Dockerfile and launch again. `lazy system build` rebuilds on demand.
- **Lazy's agent binary is not the compiled one.** Lazy mounts its own
  `lazy-agent` binary into every container; if that file is missing or is not a
  built lazy agent, the agent starts with no `lazy_*` tools. Reinstall lazy,
  then run `lazy upgrade`.

See also [Troubleshooting](troubleshooting.md).

## What the container can and cannot change in git

An agent works in its task's own git worktree. Inside the container, the
repository's shared git directory (branches, config, hooks) is read-only; the
agent can stage, diff, check out files and create commit objects, and lazy
records its commits for it.

Three small files tell git where a worktree's repository is: the worktree's
`.git` file, and `commondir` and `gitdir` in the worktree's own git directory.
A task that could rewrite them could point git at a directory it controls, whose
configuration runs a program — and the next `git` you or lazy ran in that
worktree, outside the container, would run it. So:

- **The container sees read-only copies of those three files.** It cannot
  rewrite, move or delete them.
- **lazy checks them before every git command it runs in a task worktree**,
  without running git to do it, and refuses with a message naming the task if
  they differ from what lazy created.
- **The daemon puts them back** within one reconcile tick if they were changed
  anyway (for example by an agent on the host-process runner, which has no
  container), and `lazy doctor` reports any it finds as an error.
  `lazy doctor --repair-git-pointers` repairs them on demand.

The same applies to the repositories of the worktree's **submodules**, which
git keeps inside the worktree's own git directory where the container can
write. lazy checks them the same way and refuses while one has a setting
`git submodule` never writes, a live hook, or a work-tree setting pointing
outside the task's worktree. `lazy accept`, `reject` and `close` refuse too,
naming the file. The daemon puts them back between turns, and
`lazy doctor --repair-git-pointers` does it on demand. Nothing is deleted:
the original config is kept beside it as `config.lazy-quarantine-<id>`. The
repair also reverts a setting you made yourself inside a task worktree's
submodule.
A worktree's `HEAD` file has to stay writable inside the container — git rewrites
it on every checkout — so a task could point it at another branch (a sibling
task's, its parent's, `main`). Before lazy commits, syncs, accepts or records
commits in a task worktree, it reads `HEAD` and refuses unless it names the
task's own branch; a detached `HEAD` is refused too, and `lazy doctor` reports
the worktree.

How it is put right depends on what happened:

- **Only the `HEAD` file was changed** (the worktree's staged content is still
  the task's branch). When no turn or pairing session is running, the daemon
  points `HEAD` back within one reconcile tick, and
  `lazy doctor --repair-git-pointers` does it on demand. Only `HEAD` is
  rewritten, so uncommitted edits are kept.
- **The worktree was really checked out on another branch**, or is detached.
  lazy leaves it alone: pointing `HEAD` back under another branch's files would
  make the next commit undo the task's work. `lazy doctor` tells you what to
  run: `git checkout <task branch>` in that worktree (`git stash` first if it
  has uncommitted changes).

lazy also refuses a task worktree while the repository has
`extensions.worktreeConfig` turned on, because git would then read a
per-worktree config file the task can write.

A task can also create a whole repository INSIDE its worktree — a `.git`
folder in some subfolder, or a folder shaped like a bare repository — whose
configuration runs a program for anyone who runs `git` in that subfolder, or
opens the worktree in an editor that scans for nested repositories. So:

- **`lazy doctor` reports any nested repository** your base branch does not
  have as an error, naming its path. Submodules listed in the base branch's
  `.gitmodules` are normal and not reported.
- **lazy's own git does not look inside it.** In a task worktree, lazy runs
  git without asking submodules whether they have uncommitted changes, and the
  agent's commit tool refuses to stage while a nested repository is present.
- **The daemon moves it aside between turns** (never while a turn is running):
  `sub/.git` becomes `sub/.git.lazy-quarantine-1`; a symbolic link to a
  repository is moved out of the worktree into the project's `.lazy` folder.
  Nothing is deleted.
  `lazy doctor --repair-git-pointers` does the same on demand.
- **`lazy accept` refuses** while one is present, and names it.

Until it has been moved aside, do not run git in that subfolder or open the
worktree in an IDE.

This protection does not rely on git's own "dubious ownership" check, which some
setups (including container images that trust every directory) turn off.
