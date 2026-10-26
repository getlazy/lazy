# The agent container

Every task's agent runs in a Docker container of its own. This page is for anyone
whose agents need tools the default image does not have, or who is diagnosing an
agent that cannot start: what the default image contains, how to give your
project its own image, and when lazy rebuilds it.

## A container lasts across turns

A task keeps its container between turns. A failed agent, a timeout, or Stop
ends the turn without replacing the container. Services and files outside the
task's checkout stay there for the next turn. This applies in Lazy Teams and
when running lazy on your own machine.

Accepting, rejecting or closing the task cleans up its container. Explicitly
restarting the environment, changing its agent, environment variables or image,
and daemon upgrades or restarts can also replace it. An out-of-memory kill or
an external container stop can end it independently of lazy.

Before creating a replacement, lazy records the loss in the task's journal and
tells the next work turn. For an exited container, the record includes its exit
code, whether Docker reported an out-of-memory kill, and when it exited, when
those facts are available. Lazy Teams also keeps an **Environment replaced**
notice on the task page after the agent has seen it.

Keep data you need beyond the task in durable storage: container files outside
the checkout do not survive environment replacement or task cleanup.

## The default image

A project with no `[docker] dockerfile` in its `lazy.toml` and no `Dockerfile.lazy`
at its root runs agents in lazy's default image, `lazy-runner`, which is deliberately minimal. It is Debian
(bookworm-slim) with:

| Package | Why |
| --- | --- |
| `git`, `curl`, `jq`, `wget`, `unzip`, `less`, `openssh-client`, `gnupg`, `sudo` | Basic tools |
| Chromium (`$CHROME_BIN`) | Screenshots for visual checks of UI work |
| Claude Code, Codex, Cursor CLI, Pi | Every agent lazy can run in a container, so one image serves whichever agent a task uses |

The agent runs as `user`, with passwordless `sudo`, so it can install what it
needs for one task. Lazy itself is never baked into an image: it is
mounted in when the container starts, so an image never pins you to an older
lazy.

To see exactly what the default image is built from:

```bash
lazy system export-dockerfile --stdout
```

Every lazy release publishes this image as `ghcr.io/getlazy/lazy-runner` (also
on Docker Hub as `getlazy/lazy-runner`), tagged with the release version (for example
`v0.91.1402`), `v0.91`, `latest`, and a content tag `sha-<fingerprint>` naming
the exact Dockerfile it was built from. The first task on a machine **pulls**
the content tag your lazy version builds from and tags it locally as
`lazy-runner:<major.minor>` and `lazy-runner:latest`, so `FROM lazy-runner`
keeps working. Lazy builds the image locally instead, and says why, when:

- it is offline;
- no release published the image your lazy version builds from, for example
  when you run lazy from a source checkout with a changed runner Dockerfile;
  lazy then also tags its own build with that content tag;
- the pull fails;
- the published image was built from a different Dockerfile than the one your
  lazy version uses.

A pulled image keeps the agent CLIs it was pulled with; lazy never refreshes it
behind your back. To get newer versions of Claude Code, Codex, Cursor or Pi,
upgrade lazy, which pulls the newest published image for its runner.

## Giving your project its own image

When agents keep installing the same toolchain (a language runtime, a database
client, your project's dependencies), build it into an image instead. Write a
`Dockerfile.lazy` at the root of your repository, usually starting from the
default image:

```dockerfile
FROM lazy-runner
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends postgresql-client
```

No configuration is needed: when `[docker] dockerfile` is unset, lazy uses a
`Dockerfile.lazy` at the project root, once it is committed on the checked-out
branch. An uncommitted one, staged or not, is ignored (tasks use the default
image and `lazy doctor` says so). Lazy
builds exactly the committed version: uncommitted edits to the file are not
used, and it must be a regular file, not a symbolic link.

On a Lazy Teams install that runs projects on the host's own Docker rather than
in a virtual machine per project, a committed `Dockerfile.lazy` is not built
automatically either: its build would run on a machine shared with other
projects. Tasks there use the default image. The project gets a system message saying
so, the agent is told the file will not change its container, and the task's
launch progress says it too. The project owner can still choose the file explicitly with
`[docker] dockerfile` in the project configuration.

To use a file with another name or in
another directory, name it instead (relative to the project root):

```toml
[docker]
dockerfile = "docker/agents.Dockerfile"
```

A file named there must exist — a missing one fails the launch rather than
falling back to the default image, and so does a Dockerfile that fails to build
(the error names the file and shows the end of the build output). If
`FROM lazy-runner` names a base image that is not built yet, lazy builds it
first. All `[docker]` settings, including `build_inputs` (rebuild when a
lockfile changes), are in [lazy.toml](lazy-toml.md#docker).

The build is done by the daemon, from the project root's copy of the file. An
agent editing `Dockerfile.lazy` on its task branch does not change the image
its own task runs in; the change takes effect for tasks started after that
branch is accepted. Agents know this: when a task needs a toolchain the
container lacks (asking for a Rust service in a project with no `cargo`, say),
the agent adds it to `Dockerfile.lazy`, installs it in its own container for
the task at hand, and tells you what it added.

### When `Dockerfile.lazy` does not build

If the project's `Dockerfile.lazy` fails to build, nothing that needs an agent
waits on it silently: builders start on the default image and say so, and a
task's agent runs on the default image only if somebody confirms that on the
task. On Lazy Teams the project page shows the failure and its build output,
with two ways out:

- **Use `Dockerfile.lazy` from another branch or task** (team admins). Pick a
  branch, or a task whose branch has a working file. Its committed file is shown
  next to the project branch's; on confirmation lazy builds it, with that
  branch's committed files as the build context, and only if it builds does the
  whole project — every builder and task — switch to it. The page says who
  adopted it and from where. Long lines wrap and long runs of spaces are drawn,
  so nothing hides past the edge; a file containing invisible or
  text-direction characters is marked where they are and cannot be adopted
  until they are removed. It stays in use when the project branch's own file
  changes later: the page says so and offers **Switch back**, and nothing
  switches until an admin chooses it. An adopted image also survives lazy
  upgrades, being rebuilt for the new version. On installs that run projects on
  the host's own Docker rather than in a virtual machine, this is not offered:
  the project owner names a Dockerfile in the project configuration instead.
- **Create a task to fix it.** The new-task form arrives filled in with the
  build output. On projects that run in a virtual machine, the task's agent can
  check its fix with the `lazy_image_build` tool. It builds the task's own
  `Dockerfile.lazy` (including an uncommitted change to it) against the task's
  committed files, inside the project's virtual machine, and returns the
  output. The build runs in a separate builder of its own that is removed
  afterwards, so it shares no build cache with the project's real image and
  produces no image at all; it has no access to secrets, SSH keys or registry
  logins. Once it builds,
  an admin adopts the file from the task's branch as above.

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

## When the image is built

The daemon builds your project's image **when it starts**, in the background —
not inside the first task or builder launch. Everything except running an agent
keeps working while it builds: creating tasks, reviewing, commenting, browsing.
Lazy Teams shows the build on the project page, the dashboard shows it at the
top, and `lazy system runner-image` prints it.

Until the image is ready:

- **A builder starts on lazy's default image**, and says so in a banner.
- **An agent runs on the default image only if you confirm it.** Start, resume
  and feedback ask first: in Lazy Teams and the dashboard with a "run on the
  default image" button or tick, at the terminal with a prompt (or
  `--default-image` / `--yes`), and over MCP with a confirmation code. If you
  would rather wait, do nothing; tasks waiting to be resumed automatically wait
  for the image too.
- **Questions and reviews never wait.** Asking a task something and reviewing
  it are read-only, so they run on lazy's default image straight away, without
  a confirmation, and do not change which image the task's own work runs on.
- **Every turn shows the image it ran on**, next to its agent and model.
- **A failed build stays visible**, with its reason and the Dockerfile it came
  from, until you fix it and build again (the project page's "Build it again",
  or `lazy system runner-image retry`). No launch quietly starts its own build.

### Watching, rebuilding and cancelling the build

The build has a log you can follow while it runs: every line the container
builder prints, each Dockerfile step with how long it took (or that it came
from the cache), and where the build is — "step 4 of 9". When a build fails,
the step that failed is named with its own output, and the project's state
says whether it is something you can fix (a step of your Dockerfile) or
something for whoever runs the machine (the container runtime is down, the
disk is full).

```sh
lazy system runner-image log --follow   # stream the build, step by step
lazy system runner-image rebuild        # build again, even if it is up to date
lazy system runner-image cancel         # stop the running build
```

**Rebuild** builds the image again even when it is current (`--no-cache` also
refetches everything the Dockerfile pulls). A rebuild of a ready image does not
take it away: launches keep using it until the new one has built, and after a
failed rebuild. **Cancel** stops the build at once. Adopting a Dockerfile from
another branch in Lazy Teams is a build like any other: it returns straight
away, and its log shows the branch being exported and checked before the build
itself.

Logs never show a credential: lazy removes every secret it holds — your
credentials and the stand-ins it gives task containers — before a line reaches
you. `lazy system machine` shows the rest of the machine the same way: the
container runtime, the project daemon and its proxy, each one's recent log
(`--logs`), and CPU, memory and disk use. On a Lazy Teams host shared by several
projects, the host's name and its CPU, memory and disk figures are withheld,
because they describe every project there.

## Resetting a machine's Docker storage

On a Lazy Teams project's own machine, if Docker keeps running out of memory or
its disk is full, its storage can be emptied and started clean. A project admin
(or the installation's administrator in god mode) does it from the **Machine**
page under **Docker storage**; an operator on the machine runs

```
lazy system machine reset-docker-storage    # asks first; --yes skips the question
```

**This deletes every image, container, volume and build cache on the machine**
and stops everything running in Docker, so it asks for confirmation. It then
holds lazy's automatic Docker recovery off, stops Docker, unmounts everything
under its storage, removes the storage without crossing a mount point, and
starts Docker again, telling you each step as it happens (on the page, or in the
terminal).
**Builds and task starts are cold afterwards**: images are pulled again and
layers rebuilt, so the first ones take longer. If a step fails, the page says
which and Docker is started again anyway. Plain members do not see the button.

Nothing switches back on its own once the image is ready. A task or builder
that runs on the default image keeps a banner that turns into **Restart with
the project's image**: for a task the switch applies from its next turn (a turn
in progress is not interrupted; `lazy system runner-image use-project <task>`
from a terminal), and for a builder it is a stop and a start that keeps the
conversation.

## Rebuilding

Lazy names a custom image after the content of its Dockerfile
(`lazy-custom-<hash>`), so editing the Dockerfile in the project root makes
the daemon build the new image the next time a launch asks for it — the launch
itself waits or runs on the default image, as above.

Lazy also rebuilds an image it BUILT on two schedules:

- **`lazy upgrade` always rebuilds**, from scratch.
- **After 14 days**, an older image is rebuilt once, without the build cache —
  when the daemon starts, or in the background while it runs. Launches keep
  using the current image until the new one is built.

A default image that was pulled from a release is never rebuilt for its age.
A default image lazy BUILT is replaced, when it reaches 14 days, by the
published image if one exists, and rebuilt only if not. `lazy upgrade` pulls
the newest published image instead of building one.

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
Lazy protects them as follows:

- **The container sees read-only copies of those three files.** It cannot
  rewrite, move or delete them.
- **lazy checks them before every git command it runs in a task worktree**,
  without running git to do it, and refuses with a message naming the task if
  they differ from what lazy created.
- **The daemon puts them back** within one reconcile tick if they were changed
  anyway, and `lazy doctor` reports any it finds as an error.
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

### Git hooks do not run on lazy's own git

lazy runs every git command of its own — the agent's commits, `lazy accept`'s
merge, syncs, worktree setup and pushes — with git hooks turned off
(`core.hooksPath` pointed at nothing).

What that means for you:

- **Pre-commit checks (husky, lint-staged, `pre-commit`) do not run** on
  commits lazy makes. Run them in the agent's own work instead — for example
  as a `[checks] post_turn` command, or with `[automation.pre_accept]`, which
  runs in a container before the merge.
- **Git LFS still uploads.** git-lfs normally uploads files from its pre-push
  hook; when a branch lazy pushes tracks files with LFS, lazy runs
  `git lfs push` itself before the push.
- **Your own git is unchanged.** Hooks still run when you commit or push
  yourself.
