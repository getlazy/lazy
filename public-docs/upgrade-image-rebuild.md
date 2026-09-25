# How `lazy upgrade` rebuilds the container image

This page explains how `lazy upgrade` rebuilds the container image your agents
run in, and when else lazy rebuilds it. A rebuild can take several minutes, and
none of the upgrade's other steps — asking what to do about working agents,
waiting for them to block, stopping containers — is an input to it: the image is
built from the Dockerfile, not from the state of your tasks. So the build starts
first and runs in the background while the rest of the upgrade proceeds.

## The sequence

1. **Preflight** — credential gate, container runtime availability, discovery of
   this project's running containers. Nothing has changed yet, and an abort here
   costs nothing.
2. **Start the rebuild, in the background, to a staging tag.** The build writes
   `<repository>:<tag>-upgrade` (e.g. `lazy-runner:0.22-upgrade`), always
   with `--no-cache` — the Dockerfile text is unchanged when a new version of
   the configured agent's CLI ships, so only busting the cache actually
   re-fetches it.

   Upgrading lazy rebuilds the image. That is what makes the image tag safe to
   keep coarse (`major.minor`) — the tag is an identity, and this is the
   freshness mechanism.

   The one exception is **repeating a build that just happened** — and it is a
   question, not a rule. If an image built from exactly these inputs already
   exists (the usual cause being a `lazy upgrade --images` you ran minutes
   earlier), `lazy upgrade` tells you how old it is and asks whether to rebuild
   it anyway:

   ```
   lazy-runner:0.22 was built 6 minutes ago from these exact inputs — its
   Dockerfile and build inputs are unchanged since.
     Rebuilding re-resolves everything unpinned inside it (the agent CLI, apt
     packages, anything else the Dockerfile fetches) and takes several minutes.
     Rebuild the container image anyway? [Y/n]
   ```

   The default is yes, because refreshing unpinned contents is what an upgrade
   rebuild is *for* — but whether that is worth several minutes right now
   depends on why you are upgrading, which only you know. There is no hidden
   time threshold deciding it for you. Without a TTY (scripts, CI) and with
   `--force`, the rebuild happens without asking; `lazy upgrade --images` never
   asks — it is the force-refresh path.
3. **Foreground flow continues**: the stop/wait/cancel prompt, waiting for
   working agents to block, the builder pre-stop warning, stopping **task**
   containers. Builder sessions stay running — they reconnect in place once
   the daemon restarts (step 6).
4. **Collect and promote.** The upgrade waits for the background build (usually
   already finished), then points the canonical tags — `lazy-runner:<major.minor>`
   and, for the base repository, `lazy-runner:latest` — at the staged image and
   drops the staging tag. The agent binary is rebuilt alongside this.
5. **Stop the daemon**, then purge any pre-v0.20 MCP configs left in the repo and
   rotate the shared daemon token they leaked — the one window where no
   container and no daemon holds it.
6. **Restart the daemon**, which reconciles and auto-resumes interrupted tasks.
7. **Print a completion summary** as the last output — a bordered **Upgrade
   complete** block below any docker build progress (and any prompts that
   scrolled away during a long build). It states the version transition, what
   was rebuilt (container image tag, agent binary), daemon restart status, and
   what happens next (interrupted tasks auto-resuming, builders resuming in
   place, etc.). `lazy upgrade --images` ends with a similar **Image refresh
   complete** block instead.

## Why this is safe

**Nothing running is disturbed by the build.** A container holds its image by ID
from the moment it launches, and any container created while the build is in
flight resolves the *canonical* tag — which still points at the current image.
The staging tag is invisible to every launch path.

**The canonical tag only moves after you commit.** Promotion happens in step 4,
past the point where you chose to proceed. Cancel the upgrade, ctrl-c out of a
prompt, or hit any failure before that, and `lazy-runner:<major.minor>` still points
exactly where it did. The abandoned build's layers stay in the container
runtime's build cache, so the next upgrade starts warm instead of from scratch;
the staging tag itself is removed.

**A failed build fails the upgrade, loudly.** There is no fallback to "keep the
old image and carry on" — that would produce an upgrade that upgraded nothing.
If the build has already failed by the time you answer the prompt, the upgrade
aborts *before* stopping anything, so your builders and agents keep running on
the intact image. If it fails while the upgrade is collecting it, the failure is
reported with the staging tag that was not promoted.

## Running builder sessions

On docker/podman, a live `lazy builder` in another terminal **stays running**
through the upgrade. The upgrade rebuilds the agent binary and restarts the
daemon, but it does **not** stop your builder container. The in-container
supervisor watches for the daemon restart, refreshes the proxy address and
credentials against the new daemon, and relaunches Claude Code in the **same
terminal** with `--resume`. You should see at most a one-line notice:

```
Daemon upgraded 0.22.1140 → 0.22.1141; lazy tools reconnected and the session resumed.
```

You do not need to run `lazy builder --resume` yourself when the upgrade
succeeds.

Before the upgrade proceeds, it warns you to **submit any message you have typed
but not yet sent** — that in-progress input cannot be preserved when Claude
relaunches. While the background image build runs, docker step output can scroll
that warning off screen; once the build finishes, lazy prints the press-Enter
prompt again below the build output so you are not left staring at `#14 DONE`
with no visible next step.

If the in-container reconnect fails (for example the new daemon never comes
healthy), lazy prints an actionable error and `lazy builder --resume <id>` so
nothing is silently lost.

The host-side `lazy builder` wrapper still has a relaunch loop for when the
container exits for other reasons (a crash or manual stop). That loop waits for
the upgrade to finish and re-execs `lazy builder --resume` into the same
terminal — but a normal upgrade does not trigger it, because the container
never exits.

**Task agents** running in containers follow a different path: the upgrade
restarts the daemon (and its audit proxy, usually on a new OS-assigned port),
but the task container keeps running. The in-container supervisor watches for
that restart, stops the current agent launch, refreshes `ANTHROPIC_BASE_URL`
from the new daemon, and retries the turn — so a mid-turn "Connection refused"
from a stale proxy address should clear within a retry or two rather than
looking like a firewall block. If a task was already stopped by the restart
reaper, the next auto-resume launches a fresh container with fresh env.

Host-process builders (no container) are not stopped by upgrade; their
interactive supervisor reconnects the same way `lazy pair` and `lazy chat` do.

## Builds have no time limit

An image build runs for as long as it needs to. `docker build` has no timeout of
its own, and lazy does not add one: a build killed on a timer wasted every second
it ran and produced nothing, which is strictly worse than one that runs long and
succeeds. A slow build is usually a slow network, not a stuck build.

So that an unbounded build never *looks* stuck, lazy streams the build's step
headers as they happen and prints a "still building…" line with the elapsed time
when a single step goes quiet for a while.

If you genuinely want a bound — an unattended CI machine, say — every command
that triggers a build takes an opt-in `--timeout <seconds>`:

```bash
lazy upgrade --timeout 1800
lazy upgrade --images --timeout 1800
lazy system build lazy-runner --timeout 1800
```

`--timeout 0` spells out the default (no limit), so a script computing the value
never has to special-case zero. If the bound does fire, the error says plainly
that *lazy* killed the build, after how long, and that the limit is yours to
raise or drop — it never surfaces as a bare Docker failure. Layers built before
the kill stay in the build cache, so retrying resumes rather than starting over.

Builds that lazy starts on its own — a task launching when the Dockerfile hash
changed, or the 14-day age backstop below — are always unbounded. There is no
config key for them: nobody is watching those builds, and a stale configured
limit killing them is the exact failure this default exists to prevent.

## Related

- **Worktree Dockerfile adoption** — when a task worktree's `Dockerfile.lazy`
  differs from the project root's, `lazy upgrade`
  (and `lazy upgrade --images`) can adopt it for the rebuild and the daemon.
  Your cwd may be anywhere inside that worktree — a subdirectory counts the
  same as the worktree root. Each rebuild first announces any existing adoption:
  on a TTY you choose whether to keep it (default yes); scripts and CI keep it
  and log. A new worktree Dockerfile is offered only when you are standing
  inside that worktree and its content differs (default no). Running upgrade
  from the project root alone never offers a new adoption.
- `lazy upgrade --images` is the separate **non-disruptive** path: it rebuilds
  only the image, in the foreground, and stops nothing and restarts nothing.
  Only newly-created containers pick the new image up (`lazy upgrade --images
  --dry-run` prints the exact boundary).
- Image tags are versioned (lazy's `major.minor`), never bare `:latest` — see
  [Rebuilding](agent-container.md#rebuilding) in the agent container page.
- An upgrade is not the only thing that refreshes the image — see "When else the
  image gets rebuilt" below.

## When else the image gets rebuilt

An upgrade is the main path, but not the only one. Three triggers rebuild a
runner image, on three different axes:

| Trigger | What it catches |
| --- | --- |
| `lazy upgrade` | Everything. `--no-cache`, described above — asks first (default yes) when an identical image already exists |
| The image is more than 14 days old | Unpinned contents drifting on a host nobody upgrades |
| The Dockerfile's content hash changed | You edited the Dockerfile |

`lazy system build lazy-runner --no-cache` forces one at any time.

The age backstop exists because a Dockerfile's *text* is not what goes stale.
What it installs is unpinned — apt packages, the agent CLI's installer, the base
image — so identical text yields a materially different image weeks later. Only
wall-clock time sees that, which is why freshness is time-based and the tag
(lazy's `major.minor`) is only an identity.

None of this can leave you running an old *lazy*. The image contains no lazy
code: `lazy-agent` is bind-mounted into the container at launch, so it is
current the moment lazy is.

## The base image a custom Dockerfile builds FROM

If your project supplies its own Dockerfile and it starts with
`FROM lazy-runner`, that base image is one lazy builds on your machine — it
exists on no registry. On a machine where it has never been built, or where
`docker system prune` removed it, Docker would treat the name as a Docker Hub
repository and fail with `pull access denied, repository does not exist`.

Lazy avoids that: before building your custom image it checks for the base and,
if it is missing, builds it first, saying so —

```
Base image lazy-runner:latest not found — building it first, because
/path/to/Dockerfile.lazy builds FROM it (this can take several minutes).
```

This happens **only when the base is missing**. It is not a fourth freshness
trigger: an existing base image is left exactly as it is, and the three triggers
in the table above are what keep it current.

Two `FROM` spellings lazy will not build for you, because a base build would not
produce the reference you asked for — a base build writes only the current
`major.minor` tag and the `:latest` alias:

- a base pinned to another tag, e.g. `FROM lazy-runner:0.19`
- an agent-suffixed image, e.g. `FROM lazy-runner-cursor`. These are lazy's own
  per-agent images (the default Dockerfile plus that agent's install line) and
  are not a supported `FROM` target — build on `lazy-runner` and add the agent's
  install line yourself.

In both cases lazy still names the remedy rather than leaving you with the
registry error: run `lazy system build lazy-runner` and retry.
