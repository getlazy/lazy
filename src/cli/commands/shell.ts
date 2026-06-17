import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, taskRef, getWorktreePath } from '../helpers';

import { getDataDir } from '../init';
import { spawnSync } from '../../utils/spawn';

export async function commandShell(args: string[]): Promise<void> {
  // Parse and validate flags (no flags supported, but validate against unknown flags)
  const parsed = parseFlags(args, [], 'shell');

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

    console.log(`Entering worktree for task ${displayId(task)}: ${task.goal}`);
    console.log(`  Branch: ${sess.git_branch}`);
    console.log(`  Path:   ${worktreePath}`);
    console.log(`  Type 'exit' to return.\n`);

    const shell = process.env.SHELL || '/bin/sh';
    // spawnSync (sync) is required: this is an interactive terminal handoff —
    // the child shell takes over the TTY and must block until the user exits.
    spawnSync([shell], {
      cwd: worktreePath,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        LAZY_TASK: shortId(task.id),
      },
    });
  } finally {
    await storage.close();
  }
}

export function shellUsage(): void {
  console.log(`Usage: lazy shell <task_id>

Open an interactive shell in a task's worktree.

Arguments:
  <task_id>    ID of the task

Environment variables set in the shell:
  LAZY_TASK    Short ID of the task

Use this to manually inspect or modify the worktree.

Examples:
  lazy shell abc123
  lazy shell abc1        # Prefix matching works`);
}
