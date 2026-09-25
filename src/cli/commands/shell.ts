import { join } from 'path';
import { shortId, displayId, taskRef, getWorktreePath } from '../../task/identity';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import type { Session, Task } from '../../types';

import { getDataDir, findLazyRoot } from '../../project-paths';
import { spawnSyncInteractive } from '../../utils/spawn';
import { boundCloneLogin, commandTaskTerminalBound } from './bound-session';

export async function commandShell(args: string[]): Promise<void> {
  // A clone bound to Lazy Teams opens a shell in the task's container ON THE
  // SERVER, through Teams — never one here (design doc §5.1).
  const boundRoot = findLazyRoot();
  if (boundRoot && await boundCloneLogin(boundRoot)) {
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
  ], 'shell');
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
    if (!existsSync(worktreePath)) {
      console.error(`Worktree not found at ${worktreePath}. Session may have been cleaned up.`);
      process.exit(1);
    }

    // --- default: enter the task's actual environment, the container ---
    // (`--host` opts out into a shell in the worktree on this machine.)
    if (!useHost) {
      const exitCode = await runInContainer(root, task, sess, command, sepIndex !== -1, restart);
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
  if (restart || !running) {
    const ensured = await queryEnsureTaskContainer({ taskId: task.id, restart });
    containerName = ensured.containerName;
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
  console.log(`  Type 'exit' to return.\n`);

  // Prefer bash, fall back to sh — the image is the user's, and it may not have
  // bash. Deciding that INSIDE the container beats guessing out here.
  //
  // No `-l`: a login shell would cd to HOME, and the container's working
  // directory is already the worktree, which is where the user means to be.
  const code = await runner.execInRun(
    containerName,
    ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; fi; exec sh'],
    { interactive: true },
  );
  return code ?? 0;
}

export function shellUsage(): void {
  console.log(`Usage: lazy shell <task_id> [--host | --restart] [-- <command> [args...]]

Open an interactive shell in a task's CONTAINER — the same environment the
agent works in, with its toolchain — or run a one-off command there. If the
container is not running it is started first (with a notice).

Arguments:
  <task_id>           ID of the task (prefix matching works)
  -- <command> ...    Run <command> non-interactively and exit with the
                      command's exit code. argv is passed through, so quoting
                      and arguments are preserved (no shell wrapping).

Flags:
      --host          Open the shell (or run the command) in the task's
                      worktree on THIS machine instead of the container — the
                      right thing for git and host editors.
      --restart       Recreate the container even if it is running, then enter
                      it. Published ports are fixed when a container is created,
                      so this is how a [serve] change takes effect on a task
                      that is already up. Anything running inside stops.
                      Refused while the agent is working; not with --host.
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
  lazy shell my-task --host -- code .     # Open an IDE in the worktree`);
}
