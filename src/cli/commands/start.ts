import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { getRemoteDefaultBranch } from '../../git/operations';
import { promptYesNo, isTTY } from '../editor';
import { followContainer } from './shared';
import { checkOrphanedChild } from '../orphan';
import { protocolDir as getProtocolDir } from '../../protocol';

import { listAgents } from '../../agent/registry';
import { queryStartTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';
import { formatMarkdown } from '../../utils/markdown';

export async function commandStart(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'model', takesValue: true },
    { name: 'agent', takesValue: true },
    { name: 'follow', takesValue: false },
    { name: 'yes', takesValue: false },
    { name: 'force-local', takesValue: false },

  ], 'start');

  const modelValue = parsed.flags.get('model') as string | undefined;
  const follow = parsed.flags.get('follow') === true;
  const yes = parsed.flags.get('yes') === true;
  const forceLocal = parsed.flags.get('force-local') === true;

  // Determine model override
  let modelOverride: string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Parse --agent flag
  const agentFlag = parsed.flags.get('agent') as string | undefined;
  let agentId: string | undefined;
  if (agentFlag !== undefined) {
    const validAgents = listAgents();
    if (!validAgents.includes(agentFlag)) {
      console.error(`Unknown agent '${agentFlag}'. Available agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
    agentId = agentFlag;
  }

  // Require task ID as the first positional argument
  const taskId = parsed.positional[0];
  if (!taskId) {
    console.error('Error: Task ID is required.');
    console.error('To create a new task, use: lazy create --goal "..." --prompt "..."');
    console.error('Then start it with: lazy start <task_id>');
    process.exit(1);
  }

  // --- Lightweight pre-flight checks (TTY-only interactive concerns) ---
  // The daemon does authoritative validation. These checks are to prevent
  // the user from seeing confusing daemon errors when we can give better UX.
  const root = requireLazyRoot();
  let retargetOrphan = false;

  {
    const storage = await requireStorage();
    try {
      const t = await resolveTaskOrExit(storage, taskId);

      if (!t.prompt) {
        console.error(`Task ${displayId(t)} has no prompt. Set one with: lazy edit ${displayId(t)}`);
        process.exit(1);
      }

      // Check for orphaned child (parent accepted, branch gone) and prompt for retarget
      if (t.parent_task_id) {
        const parentTask = await storage.getTask(t.parent_task_id);
        if (!parentTask) {
          console.error(`Parent task not found: ${t.parent_task_id}`);
          process.exit(1);
        }

        const parentWorktreePath = getWorktreePath(root, parentTask);
        if (!existsSync(parentWorktreePath)) {
          // Check if it's an orphan that can be retargeted
          const orphanStatus = await checkOrphanedChild(t, storage, root);
          if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
            console.log(theme.warning(`\nParent task was accepted and its branch deleted.`));
            console.log(`This task needs to be retargeted to ${theme.taskId(orphanStatus.retargetBranch)} before starting.\n`);

            let shouldRetarget: boolean;
            if (isTTY() && !yes) {
              shouldRetarget = await promptYesNo(`Retarget to ${orphanStatus.retargetBranch}?`, true);
            } else {
              shouldRetarget = true;
              if (!isTTY()) {
                console.log(`Automatically retargeting to ${orphanStatus.retargetBranch} (non-interactive mode).`);
              }
            }

            if (!shouldRetarget) {
              console.error('Cannot start without retargeting. The parent branch no longer exists.');
              process.exit(1);
            }

            retargetOrphan = true;
          } else {
            console.error(`Cannot start child task: parent task has no worktree.`);
            console.error(`Start the parent first with: lazy start ${displayId(parentTask)}`);
            process.exit(1);
          }
        }
      }

      // Warn if task has no parent and there are active tasks on other branches
      if (!t.parent_task_id) {
        const allTasks = await storage.listTasks();
        const activeTasks = allTasks.filter(task => {
          const status = task.status;
          return status === 'working' || status === 'interrupted' || status === 'pairing' || status === 'merging';
        });

        if (activeTasks.length > 0 && !yes) {
          const defaultBranch = await getRemoteDefaultBranch(root);
          console.log(theme.warning(`\nTask '${displayId(t)}' has no parent and will branch from ${defaultBranch}.`));
          console.log(`There are ${activeTasks.length} active task(s) on other branches:`);
          for (const activeTask of activeTasks.slice(0, 5)) {
            console.log(`  - ${displayId(activeTask)}: ${activeTask.goal}`);
          }
          if (activeTasks.length > 5) {
            console.log(`  ... and ${activeTasks.length - 5} more`);
          }
          console.log('');

          if (isTTY()) {
            const confirmed = await promptYesNo('Continue?', true);
            if (!confirmed) {
              console.log('Task not started. To make this a child task, use: lazy create --parent <parent_task_id>');
              process.exit(0);
            }
          }
        }
      }

      // Show task details and ask for confirmation unless --yes was provided
      if (!yes && isTTY()) {
        console.log(`\nTask: ${displayId(t)}`);
        console.log(`Goal: ${t.goal}`);
        console.log(`\nPrompt:`);
        console.log(formatMarkdown(t.prompt).join('\n'));
        console.log('');

        const confirmed = await promptYesNo('Start this task?', false);
        if (!confirmed) {
          console.log(`Task not started. Edit the prompt with: lazy edit ${displayId(t)}`);
          process.exit(0);
        }
      }
    } finally {
      await storage.close();
    }
  }

  // --- Delegate to daemon RPC ---
  try {
    const result = await queryStartTask({
      taskId,
      modelOverride,
      agentId,
      forceLocal,
      retargetOrphan,
    });

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    // Print summary — task is now running asynchronously
    // Need storage briefly for displayIdFor of parent
    const storage = await requireStorage();
    try {
      const t = await resolveTaskOrExit(storage, taskId);
      console.log(theme.success(`\nStarted task ${displayId(t)}`));
      console.log(`  ${theme.label('Goal:')}      ${t.goal}`);
      console.log(`  ${theme.label('Branch:')}    ${result.branchName}`);
      console.log(`  ${theme.label('Worktree:')}  ${result.worktreePath}`);
      console.log(`  ${theme.label('Runner:')}    ${result.containerName}`);
      if (result.parentDisplayId) {
        console.log(`  ${theme.label('Parent:')}    ${theme.taskId(result.parentDisplayId)}`);
      }

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: ${theme.command('lazy blocked')}`);
        console.log(`Or check status with: ${theme.command('lazy status ' + displayId(t))}`);
      }

      // Follow container output
      if (follow) {
        const protoDir = getProtocolDir(t.id);
        const exitCode = await followContainer(result.containerName, storage, root, result.worktreePath, protoDir);
        await storage.close();
        process.exit(exitCode);
      }
    } finally {
      await storage.close();
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function startUsage(): void {
  console.log(`Usage: lazy start <task_id> [--model <model>] [--agent <agent_id>] [--follow] [--yes] [--force-local]

Start an existing task. Creates a worktree, launches a supervisor container, and writes a start command.
The supervisor manages the agent lifecycle (sync-with-upstream, work phases).

To create a new task, use 'lazy create' first, then start it with this command.

Use 'lazy blocked' to check when the agent finishes and needs your input.
Use 'lazy status <task_id>' to check the current state.

Arguments:
  <task_id>          ID of the task to start (short hex prefix or task code)

Options:
  --model <model>    Override model for this session (raw model ID, e.g. claude-sonnet-4-5-20250929)
  --agent <agent_id> Agent to use for this task (default: from task or lazy.toml)
  --follow           Wait for the agent to finish, streaming output in real time
  --yes              Skip confirmation prompts
  --force-local      Start from local HEAD even if remote fetch fails (use with caution)

Model Selection:
  Models are selected in this priority order:
  1. --model flag (session override)
  2. Task's model setting (if set during task creation)
  3. lazy.toml default model
  4. Built-in default (claude-sonnet-4-5-20250929)

Notes:
  - Each task can only have one session (1:1 relationship)
  - If the task already has a session, use 'lazy unblock' instead
  - Tasks automatically fetch the latest remote state before creating worktrees.
    If the remote fetch fails, 'lazy start' will abort unless --force-local is used.
  - For child tasks, the worktree starts from the parent's branch HEAD (fetched from remote)
  - The human turn is recorded before the container launches, so it's
    crash-safe — if the process dies, the turn is preserved

Examples:
  lazy create --goal "Add auth" --prompt "Implement OAuth2 login"
  lazy start abc12345                       # Start the created task
  lazy start abc12345 --yes                 # Start without confirmation
  lazy start abc1 --model claude-haiku-4-5-20251001  # Start with model override
  lazy start abc1 --follow                  # Wait for completion`);
}
