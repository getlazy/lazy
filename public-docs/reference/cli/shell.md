# lazy shell

This page is generated from `lazy shell --help`.

```text
Usage: lazy shell <task_id> [--host | --local | --restart] [-- <command> [args...]]
       lazy shell <task_id> --ssh-config [--install] [--yes]

Open an interactive shell in a task's CONTAINER — the same environment the
agent works in, with its toolchain — or run a one-off command there. If the
container is not running it is started first (with a notice). On entry it
says who else is in the task right now — other people's terminals (session
names and whether they are attached or idle, never what they run), the
task's own sessions such as its services, and whether the agent is running a
turn. `lazy sessions <task>` asks again.

Arguments:
  <task_id>           ID of the task (prefix matching works)
  -- <command> ...    Run <command> non-interactively and exit with the
                      command's exit code. argv is passed through, so quoting
                      and arguments are preserved (no shell wrapping).

Flags:
      --host          Open the shell (or run the command) in the task's
                      worktree on THIS machine instead of the container — the
                      right thing for git and host editors.
      --local         Only in a clone bound to Lazy Teams: fetch the task's
                      branch and open a shell in a LOCAL checkout of it (a git
                      worktree beside this clone, tracking origin/lazy/<task>).
                      Plain git: lazy never pushes from it — "git push" sends
                      your commits to the task, and "lazy sync" merges them.
                      Re-running fast-forwards a clean checkout and never
                      discards unpushed or uncommitted work.
      --restart       Recreate the container even if it is running, then enter
                      it. Published ports are fixed when a container is created,
                      so this is how a [serve] change takes effect on a task
                      that is already up. Anything running inside stops.
                      Refused while the agent is working; not with --host.
      --ssh-config    Print the ~/.ssh/config Host block that reaches this
                      task over SSH (an SSH-only name), for tools that
                      speak SSH: VS Code Remote-SSH, JetBrains Gateway, scp,
                      sftp and port forwards. In Lazy Teams it lands in your own
                      environment for the task, as the Shell does; locally,
                      in the task's container.
      --install       With --ssh-config: make this machine's key
                      (~/.lazy/ssh/id_ed25519), register it with Lazy Teams,
                      pin the task's host key and write the block to
                      ~/.lazy/ssh/config. Ask to add its Include at the top
                      of ~/.ssh/config, backing up the old file first.
      --yes           Add the SSH Include without prompting (with --install).
  -c, --container     DEPRECATED no-op: the container is the default now. This
                      alias is kept for one release so scripts do not break —
                      drop it.

Environment variables set for the host shell/command (--host only):
  LAZY_TASK    Short ID of the task

The default drops you where the agent runs — set the project up and start
servers there; see `lazy url` for reaching ports declared in [serve]. Use
--host to inspect or modify the worktree from this machine.

Examples:
  lazy shell abc123                       # Shell inside the task's container
  lazy shell abc1                         # Prefix matching works
  lazy shell my-task -- npm run dev       # Start a dev server in the container
  lazy shell my-task --restart            # Recreate the container, then enter
  lazy shell my-task --host               # Shell in the worktree on this machine
  lazy shell my-task --host -- code .     # Open an IDE in the worktree
  lazy shell my-task --ssh-config --install && ssh my-task.<project>.<team>.<teams-host>
```
