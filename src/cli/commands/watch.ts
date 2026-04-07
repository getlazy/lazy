/**
 * lazy watch — Read-only observation of agent sessions.
 *
 * Attaches to a running agent's tmux session in read-only mode, allowing
 * users to see what the agent is doing without being able to interact.
 * Read-only is enforced by tmux's -r flag.
 */

import { requireStorage, displayId, parseFlags, resolveTaskOrExit, shortId } from '../helpers';
import { createTerminal, tmuxSessionName } from '../../terminal';

export async function commandWatch(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'watch');

  if (parsed.positional.length === 0) {
    // No task specified — find all working tasks and let user pick
    const storage = await requireStorage();
    try {
      const tasks = await storage.listTasksWithOptions({ workingOnly: true });

      if (tasks.length === 0) {
        console.log('No tasks are currently running.');
        process.exit(0);
      }

      if (tasks.length === 1) {
        // Only one working task — watch it directly
        const task = tasks[0];
        const sid = shortId(task.id);
        await doWatch(sid, displayId(task));
        return;
      }

      // Multiple working tasks — list them so the user can pick
      console.log('Multiple tasks are running. Specify which one to watch:\n');
      for (const task of tasks) {
        console.log(`  lazy watch ${displayId(task)}    # ${task.goal}`);
      }
      console.log('');
      process.exit(0);
    } finally {
      await storage.close();
    }
    return;
  }

  const taskId = parsed.positional[0];
  const storage = await requireStorage();

  try {
    const task = await resolveTaskOrExit(storage, taskId);

    if (task.status !== 'working') {
      console.error(`Task ${displayId(task)} is not currently running. Status: ${task.status}`);
      process.exit(1);
    }

    await doWatch(shortId(task.id), displayId(task));
  } finally {
    await storage.close();
  }
}

async function doWatch(taskShortId: string, displayName: string): Promise<void> {
  const terminal = createTerminal();
  const sessionName = tmuxSessionName(taskShortId);

  console.log(`Watching task ${displayName} (session: ${sessionName})...`);
  console.log('Read-only mode — you cannot interact with the agent.\n');

  const result = await terminal.watchTask(sessionName);

  if (result.error) {
    console.error(result.error);
    process.exit(result.exitCode);
  }

  process.exit(result.exitCode);
}

export function watchUsage(): void {
  console.log(`Usage: lazy watch [<task-code>]

Watch an agent working on a task in real-time (read-only).

Opens a read-only tmux view of the agent's terminal session. You can see
everything the agent does, but cannot type or interact. This is by design —
micromanaging agents gives worse long-term results.

Arguments:
  <task-code>    Task to watch (code or short ID). If omitted and only one
                 task is running, watches that task automatically.

Requirements:
  - tmux must be installed
  - Task must be in 'working' status
  - Agent must be running in a tmux session (created by the supervisor)

Examples:
  lazy watch fix-auth      # Watch a specific task
  lazy watch               # Watch the only running task
  lazy watch abc12345      # Watch by short ID`);
}
