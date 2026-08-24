import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, taskRef, getWorktreePath } from '../helpers';

import { getDataDir } from '../init';
import { spawnSyncInteractive } from '../../utils/spawn';

export async function commandShell(args: string[]): Promise<void> {
  // Split argv on the first `--` separator. Everything before it is parsed as
  // flags/positionals; everything after is an arbitrary command to run in the
  // worktree non-interactively. parseFlags doesn't understand `--` (it would
  // reject it as an unknown flag), so we split here before parsing.
  const sepIndex = args.indexOf('--');
  const preArgs = sepIndex === -1 ? args : args.slice(0, sepIndex);
  const command = sepIndex === -1 ? [] : args.slice(sepIndex + 1);

  // Parse and validate flags (no flags supported, but validate against unknown flags)
  const parsed = parseFlags(preArgs, [], 'shell');

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

    const env = {
      ...process.env,
      LAZY_TASK: shortId(task.id),
    };

    // `lazy shell <task> -- <command> [args...]` — run the command directly in
    // the worktree, passing argv through (no `sh -c` string-join) so quoting and
    // args are preserved. The child's exit code becomes lazy's exit code so it
    // composes in scripts. No intro banner — keep output clean and scriptable.
    if (sepIndex !== -1) {
      if (command.length === 0) {
        console.error(`No command given after '--'. Usage: lazy shell ${displayId(task)} -- <command> [args...]`);
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

export function shellUsage(): void {
  console.log(`Usage: lazy shell <task_id> [-- <command> [args...]]

Open an interactive shell in a task's worktree, or run a one-off command in it.

Arguments:
  <task_id>           ID of the task (prefix matching works)
  -- <command> ...    Run <command> in the worktree non-interactively and exit
                      with the command's exit code. argv is passed through, so
                      quoting and arguments are preserved (no shell wrapping).

Environment variables set for the shell/command:
  LAZY_TASK    Short ID of the task

Use this to manually inspect or modify the worktree, or to run tooling against it.

Examples:
  lazy shell abc123                 # Interactive shell in the worktree
  lazy shell abc1                   # Prefix matching works
  lazy shell my-task -- code .      # Open an IDE in the worktree
  lazy shell my-task -- npm test    # Run tests in the worktree
  lazy shell abc1 -- git status     # Run a one-off command`);
}
