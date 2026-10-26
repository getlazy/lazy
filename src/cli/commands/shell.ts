import { join } from 'path';
import { shortId, displayId, taskRef, getWorktreePath } from '../../task/identity';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import type { Session, Task } from '../../types';

import { getDataDir, findLazyRoot } from '../../project-paths';
import { spawnSyncInteractive } from '../../utils/spawn';
import { boundCloneLogin, commandTaskTerminalBound } from './bound-session';

export async function commandShell(args: string[]): Promise<void> {
  // SSH into the task (`--ssh-config`, the hidden `--stdio`): solo and in a
  // clone bound to Lazy Teams alike (./shell-ssh.ts). First, because `--root`
  // chooses the project before anything looks for one.
  const { wantsShellSsh, commandShellSsh } = await import('./shell-ssh');
  if (wantsShellSsh(args)) {
    await commandShellSsh(args);
    return;
  }
  // A clone bound to Lazy Teams opens a shell in the task's container ON THE
  // SERVER, through Teams — never one here (design doc §5.1).
  const boundRoot = findLazyRoot();
  if (boundRoot && await boundCloneLogin(boundRoot)) {
    // `--local` is the one exception: a plain-git checkout of the task's
    // branch on THIS machine, which the person pushes from themselves.
    const sep = args.indexOf('--');
    const own = sep === -1 ? args : args.slice(0, sep);
    if (own.includes('--local')) {
      const { commandShellLocal } = await import('./shell-local');
      await commandShellLocal(boundRoot, args);
      return;
    }
    if (own.includes('--host')) {
      console.error('Error: --host does not apply in a clone bound to Lazy Teams: the task\'s worktree is on the server. ' +
        'Use `lazy shell <task> --local` for a checkout of its branch on this machine.');
      process.exit(1);
    }
    await commandTaskTerminalBound('shell', boundRoot, args);
    return;
  }

  // Split argv on the first `--` separator. Everything before it is parsed as
  // flags/positionals; everything after is an arbitrary command to run in the
  // worktree non-interactively. parseFlags doesn't understand `--` (it would
  // reject it as an unknown flag), so we split here before parsing.
  const sepIndex = args.indexOf('--');
  const preArgs = sepIndex === -1 ? args : args.slice(0, sepIndex);
  const command = sepIndex === -1 ? [] : args.slice(sepIndex + 1);

  // Mode flags only; everything else is rejected. `--container` is the old
  // spelling of what is now the default — kept as a no-op alias for one release
  // so scripts do not break.
  const parsed = parseFlags(preArgs, [
    { name: 'container', aliases: ['c'], takesValue: false },
    { name: 'host', takesValue: false },
    { name: 'restart', takesValue: false },
    { name: 'local', takesValue: false },
  ], 'shell');
  if (parsed.flags.get('local') === true) {
    console.error('--local is for a clone bound to Lazy Teams (after `lazy clone <url>`). Here the task\'s worktree is already on this machine — use --host.');
    process.exit(1);
  }
  const containerFlag = parsed.flags.get('container') === true;
  const useHost = parsed.flags.get('host') === true;
  const restart = parsed.flags.get('restart') === true;
  if (containerFlag && useHost) {
    console.error('--container and --host contradict each other — pick one.');
    process.exit(1);
  }
  if (restart && useHost) {
    console.error('--restart recreates the container, so it cannot be combined with --host.');
    process.exit(1);
  }

  const taskId = parsed.positional[0];
  if (!taskId) {
    shellUsage();
    process.exit(1);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Get session
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
      process.exit(1);
    }

    const worktreePath = getWorktreePath(root, task);
    const worktreeMissing = !existsSync(worktreePath);
    if (worktreeMissing && useHost) {
      console.error('Restoring task files…');
      const { queryEnsureTaskWorktree } = await import('../../daemon/rpc-fallback');
      await queryEnsureTaskWorktree(task.id);
    }

    // --- default: enter the task's actual environment, the container ---
    // (`--host` opts out into a shell in the worktree on this machine.)
    if (!useHost) {
      const exitCode = await runInContainer(root, task, sess, command, sepIndex !== -1, restart || worktreeMissing);
      await storage.close();
      process.exit(exitCode);
    }

    const env = {
      ...process.env,
      LAZY_TASK: shortId(task.id),
    };

    // `lazy shell <task> --host -- <command> [args...]` — run the command
    // directly in the worktree, passing argv through (no `sh -c` string-join) so
    // quoting and args are preserved. The child's exit code becomes lazy's exit
    // code so it composes in scripts. No intro banner — keep output clean and
    // scriptable.
    if (sepIndex !== -1) {
      if (command.length === 0) {
        console.error(`No command given after '--'. Usage: lazy shell ${displayId(task)} --host -- <command> [args...]`);
        process.exit(1);
      }
      // Interactive: stdio is inherited and the exit code is available, and the
      // user's command owns the TTY — it may be long-running or interactive, so
      // it must never be timed out.
      const result = spawnSyncInteractive(command, {
        cwd: worktreePath,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env,
      });
      // Close storage before exiting (the finally block won't run after exit).
      await storage.close();
      process.exit(result.exitCode ?? 0);
    }

    console.log(`Entering worktree for task ${displayId(task)}: ${task.goal}`);
    console.log(`  Branch: ${sess.git_branch}`);
    console.log(`  Path:   ${worktreePath}`);
    console.log(`  Type 'exit' to return.\n`);

    const shell = process.env.SHELL || '/bin/sh';
    // Interactive terminal handoff: the child shell takes over the TTY and must
    // block until the user exits.
    spawnSyncInteractive([shell], {
      cwd: worktreePath,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env,
    });
  } finally {
    await storage.close();
  }
}

/**
 * `lazy shell <task>` (the default) — enter the task's real environment.
 *
 * The container's working directory is already the worktree, so an exec lands
 * where the agent works, with the agent's toolchain rather than the host's.
 *
 * On a container that is not running this RELAUNCHES it, with a notice. That is
 * deliberate: "enter the environment" is unambiguous, and refusing with "start
 * the task first" would tell the user to run a turn they did not ask for. The
 * relaunch goes through the daemon so the container gets its MCP token, and it
 * picks up the project's current `[serve]` ports — which is the only moment
 * published ports can change.
 *
 * `--restart` recreates a container that IS running, for the same reason: it is
 * the supported way to make a `[serve]` edit take effect on a live task.
 */
async function runInContainer(
  root: string,
  task: Task,
  sess: Session,
  command: string[],
  hasCommand: boolean,
  restart: boolean,
): Promise<number> {
  const { createRunner } = await import('../../runner');
  const { queryEnsureTaskContainer } = await import('../../daemon/rpc-fallback');

  const runner = await createRunner(root, sess.runner_type ?? task.runner_type ?? undefined);
  if (!runner.usesSandbox()) {
    console.error(
      `Task ${displayId(task)} runs on the ${runner.type} runner, which has no container to ` +
      `enter — its agent is a plain process on this machine. Use \`lazy shell ${displayId(task)} --host\` ` +
      `for a shell in its worktree.`,
    );
    return 1;
  }

  let containerName = sess.container_name ?? runner.runNameForTask(taskRef(task));
  const running = await runner.isRunning(containerName);
  if (restart && running) {
    console.log(`Recreating container ${containerName} — anything running inside it stops.`);
  } else if (!running) {
    console.log(`Container for task ${displayId(task)} is not running — starting it...`);
  }
  const ensured = await queryEnsureTaskContainer({ taskId: task.id, restart });
  containerName = ensured.containerName;
  if (!ensured.alreadyRunning) {
    console.log(`Started ${containerName}.`);
  }

  if (hasCommand) {
    if (command.length === 0) {
      console.error(
        `No command given after '--'. Usage: lazy shell ${displayId(task)} -- <command> [args...]`,
      );
      return 1;
    }
    // Not interactive: this form is for scripts, and a pty would mangle the
    // output they parse. Same contract as the worktree form — argv passes
    // through untouched and the command's exit code becomes lazy's.
    const code = await runner.execInRun(containerName, command);
    return code ?? 1;
  }

  console.log(`Entering container for task ${displayId(task)}: ${task.goal}`);
  console.log(`  Container: ${containerName}`);
  console.log(`  Branch:    ${sess.git_branch}`);
  console.log(`  Type 'exit' to end the shell; with tmux in the image, Ctrl-b d leaves it running for next time.`);
  // Who else is working here right now: other shells, services, the agent.
  const { printPresenceBanner } = await import('./sessions');
  const notice = await printPresenceBanner(task.id);
  console.log('');

  // The container's `shell` tmux session — created by the first `lazy shell`,
  // re-entered by every later one, so a dropped connection loses nothing — or
  // a plain shell when the image has no tmux (../../terminal/shell-session.ts).
  const { shellSessionCommand } = await import('../../terminal/shell-session');
  const code = await runner.execInRun(containerName, shellSessionCommand(undefined, notice), { interactive: true });
  return code ?? 0;
}

export function shellUsage(): void {
  console.log(`Usage: lazy shell <task_id> [--host | --local | --restart] [-- <command> [args...]]
       lazy shell <task_id> --ssh-config [--install] [--yes]

Open an interactive shell in a task's CONTAINER — the same environment the
agent works in, with its toolchain — or run a one-off command there. If the
container is not running it is started first (with a notice). On entry it
says who else is in the task right now — other people's terminals (session
names and whether they are attached or idle, never what they run), the
task's own sessions such as its services, and whether the agent is running a
turn. \`lazy sessions <task>\` asks again.

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
servers there; see \`lazy url\` for reaching ports declared in [serve]. Use
--host to inspect or modify the worktree from this machine.

Examples:
  lazy shell abc123                       # Shell inside the task's container
  lazy shell abc1                         # Prefix matching works
  lazy shell my-task -- npm run dev       # Start a dev server in the container
  lazy shell my-task --restart            # Recreate the container, then enter
  lazy shell my-task --host               # Shell in the worktree on this machine
  lazy shell my-task --host -- code .     # Open an IDE in the worktree
  lazy shell my-task --ssh-config --install && ssh my-task.<project>.<team>.<teams-host>`);
}
