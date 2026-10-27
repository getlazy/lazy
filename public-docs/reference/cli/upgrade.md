# lazy upgrade

This page is generated from `lazy upgrade --help`.

```text
Usage: lazy upgrade [--force] [--wait] [--dry-run] [--skip-store-backup] [--timeout <seconds>]
       lazy upgrade --images [--dry-run] [--timeout <seconds>]

Rebuild the Docker image and agent binary, then restart the daemon.

Non-disruptive image refresh (--images):
  `lazy upgrade --images` rebuilds ONLY the project's container image, with
  --no-cache so a newly-released Claude Code (installed inside the image) is
  actually re-fetched. It stops nothing and does not restart the daemon, so
  running builders and agents keep working uninterrupted. Only newly-created
  containers use the refreshed image:
    - New / queued tasks and interrupted-then-resumed tasks:  immediately
    - Running builders:  on their next relaunch
    - Working agents and blocked tasks:  when their container is next recreated
      (a blocked task reuses its live supervisor on unblock, so it does NOT
      switch on the next turn)
  A full `lazy upgrade` also restarts the daemon and every agent; running task
  containers still keep their image until their environment is restarted.
  Only applies to docker/podman runners.

What happens:
  1. The Docker image rebuild starts immediately, in the BACKGROUND, under a
     temporary staging tag — it does not wait for your decisions and does not
     touch running containers. When an image built from exactly these inputs
     already exists, you are ASKED whether to rebuild it anyway (default: yes) —
     the only gain is re-resolving its unpinned contents, and the question says
     how old it is. Without a TTY it rebuilds; `--images` never asks.
  2. Live builder sessions are warned to submit any in-progress message
  3. Task containers and builders stay running (each task's agent restarts with
     the daemon; a container keeps its image until you restart its environment)
  4. The background image is promoted onto the real image tag (usually already
     built by now) and the agent binary is force-rebuilt
  5. Daemon is restarted with new code
  6. Daemon auto-reconciles and auto-resumes interrupted tasks (~10 seconds)
  7. Running builder sessions reconnect against the new daemon with their
     conversation intact (one-line notice in the session, not a stop/resume cycle)

Because the image tag only moves in step 4, cancelling the upgrade (or ctrl-c)
leaves your current image exactly as it was; the layers already built stay in
the container runtime's build cache, so the next upgrade starts warm. If the
background rebuild fails, the upgrade fails loudly — it never silently carries
on with the old image.

If any containers are in 'working' state (mid-turn), you'll be prompted with
three options: stop and upgrade now, wait for tasks to finish, or cancel.
Mid-turn work will be lost if you stop, but tasks resume from their last
checkpoint.

If any builder sessions are running, you'll be warned to submit any in-progress
message before they restart — their conversation resumes automatically, but a
typed-but-unsent message cannot be preserved. With --force or no TTY this
warning is printed but not blocked on, and unsent builder input may be lost.

When run interactively from a task worktree whose Dockerfile.lazy differs from
the project root's, you'll be asked whether to adopt the worktree's copy for
the image build AND the restarted daemon (and all launches without a per-task
image pin). Adoption sticks until the next upgrade rebuild decides again.
Without a TTY the question is skipped (the default root Dockerfile applies, and
any prior adoption is cleared).

Options:
  --force     Don't prompt, stop everything including working containers
  --wait      Wait for all working tasks to block before upgrading
  --images    Non-disruptive: rebuild only the container image (--no-cache) for
              future sessions; stop nothing, don't restart the daemon. Always
              rebuilds and never asks — this is the force-refresh path
  --dry-run   Show what would be rebuilt and stopped, without doing anything
  --skip-store-backup
              Do not back up the store before the new daemon opens it. Without
              this, a backup that fails stops the upgrade (see
              `lazy system store-backups`)
  --timeout <seconds>
              Kill the image build after N seconds (default: no timeout).
              Builds are unbounded by default: one killed on a timer wastes the
              whole wall-clock it ran for and produces nothing.

--force and --wait are mutually exclusive. --images does not stop containers, so
it cannot be combined with --force or --wait.

Examples:
  lazy upgrade              # Interactive: prompt if working tasks exist
  lazy upgrade --force      # Non-interactive: stop everything and rebuild
  lazy upgrade --wait       # Non-interactive: wait for tasks to finish, then upgrade
  lazy upgrade --images     # Non-disruptive: refresh the image for future sessions
  lazy upgrade --dry-run    # Preview what would happen
```
