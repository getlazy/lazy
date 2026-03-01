import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, validateCode, resolveTaskOrExit, taskRef, getWorktreePath, MAX_TASK_CODE_LENGTH } from '../helpers';
import { removeWorktree, deleteBranch, getDiffStat, hasUncommittedChanges } from '../../git/operations';
import { cleanupTaskContainer } from './shared';
import { commandStart } from './start';
import { loadConfig } from '../../config/loader';
import { createDriver } from '../../remote';
import { logger } from '../../utils/logger';
import type { ModelName } from '../../types';
import { getActor } from '../../constants';

import { getDataDir } from '../init';
import { theme } from '../theme';

function cleanupWorktreeAndBranch(worktreePath: string, branch: string, root: string): void {
  if (existsSync(worktreePath)) {
    try {
      removeWorktree(worktreePath, root);
    } catch {
      // Worktree may be corrupted. Fall back to manual removal + prune.
      Bun.spawnSync(['rm', '-rf', worktreePath]);
      Bun.spawnSync(['git', 'worktree', 'prune'], { cwd: root });
    }
  }
  try {
    deleteBranch(branch, root);
  } catch {
    // Branch may already be gone
  }
}

/**
 * Generate a redo code from the old task's code.
 * Convention: append -redo-1, -redo-2, etc. Truncate base if needed to fit 80-char limit.
 */
export function generateRedoCode(oldCode: string): string {
  // Check if old code already has a -redo-N suffix
  const redoMatch = oldCode.match(/^(.+)-redo-(\d+)$/);
  let base: string;
  let n: number;
  if (redoMatch) {
    base = redoMatch[1];
    n = parseInt(redoMatch[2], 10) + 1;
  } else {
    base = oldCode;
    n = 1;
  }

  const suffix = `-redo-${n}`;
  // Truncate base to fit within max code length limit
  const maxBase = MAX_TASK_CODE_LENGTH - suffix.length;
  if (base.length > maxBase) {
    base = base.substring(0, maxBase);
    // Remove trailing hyphen from truncation
    base = base.replace(/-$/, '');
  }

  const code = base + suffix;
  // Validate the generated code — if it's invalid, skip setting code
  if (validateCode(code) !== null) {
    return '';
  }
  return code;
}

export async function commandRedo(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'no-start', takesValue: false },
    { name: 'yes', takesValue: false },
  ], 'redo');

  const taskId = parsed.positional[0];
  if (!taskId) {
    redoUsage();
    process.exit(1);
  }

  const promptOverride = parsed.flags.get('prompt') as string | undefined;
  const noStart = parsed.flags.get('no-start') === true;
  const yes = parsed.flags.get('yes') === true;

  let modelOverride: ModelName | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  let newTaskShortId: string;

  try {
    // Resolve old task
    const oldTask = await resolveTaskOrExit(storage, taskId);

    // Validate: can't redo a task that's already complete (merged)
    if (oldTask.status === 'complete') {
      console.error(`Task ${displayId(oldTask)} is already complete (merged). Nothing to redo.`);
      process.exit(1);
    }

    // Validate: can't redo a task already closed
    if (oldTask.status === 'closed') {
      console.error(`Task ${displayId(oldTask)} is already closed.`);
      console.error(`To restart this work, create a new task with the same goal.`);
      process.exit(1);
    }

    // Check worktree for uncommitted changes
    const worktreePath = getWorktreePath(root, oldTask);
    if (existsSync(worktreePath) && hasUncommittedChanges(worktreePath)) {
      console.error('Error: Task has uncommitted changes!');
      console.error('Commit or stash your changes before redoing.');
      console.error('Options:');
      console.error(`  1. Unblock and ask agent to commit: lazy unblock ${displayId(oldTask)} --message "Please commit your changes"`);
      console.error(`  2. Manually commit in shell: lazy shell ${displayId(oldTask)}`);
      process.exit(1);
    }

    // Gather context from old task before closing
    const sess = await storage.getSessionByTaskId(oldTask.id);
    let redoContext = '';

    if (sess) {
      // Get last agent turn summary
      const turns = await storage.getSessionTurns(sess.id);
      const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
      if (lastAgentTurn) {
        // Truncate to a reasonable size for context injection
        const summary = lastAgentTurn.content.length > 4000
          ? lastAgentTurn.content.substring(0, 4000) + '\n... (truncated)'
          : lastAgentTurn.content;
        redoContext += `\n## Previous Attempt Context\n\nThis task is a redo of a previous attempt (${shortId(oldTask.id)}). The previous agent's last response:\n\n${summary}\n`;
      }

      // Get diff stat from old task
      try {
        const diffStat = getDiffStat(sess.git_start_sha, 'HEAD', worktreePath);
        if (diffStat.trim()) {
          redoContext += `\nFiles changed in previous attempt:\n\`\`\`\n${diffStat}\`\`\`\n`;
        }
      } catch {
        // Worktree may not exist or diff may fail — that's fine
      }

      if (redoContext) {
        redoContext = '\n' + redoContext + '\nUse this context as a starting point, but work from the current state of main.\n';
      }
    }

    // Get the latest prompt version
    const promptHistory = await storage.getPromptHistory(oldTask.id);
    const latestPrompt = promptHistory.length > 0
      ? promptHistory[promptHistory.length - 1].content
      : oldTask.prompt;

    // Build new prompt: user override > old prompt + redo context
    const newPrompt = promptOverride
      ? promptOverride + redoContext
      : latestPrompt + redoContext;

    // Determine model: CLI override > old task model
    const newModel = modelOverride ?? oldTask.model;

    // --- Create new task first (so we have its ID for the close reason) ---
    // Preserve parent relationship if the old task had one
    const newTask = await storage.createTask(oldTask.goal, oldTask.parent_task_id ?? undefined, undefined, undefined);

    // Set prompt
    await storage.updateTaskPrompt(newTask.id, newPrompt);

    // Set model
    if (newModel) {
      await storage.updateTaskModel(newTask.id, newModel);
    }

    // Generate redo code from old task's code (convention: append -redo-N)
    if (oldTask.code) {
      const redoCode = generateRedoCode(oldTask.code);
      if (redoCode) {
        try {
          await storage.updateTaskCode(newTask.id, redoCode);
        } catch {
          // Code conflict — not critical, skip silently
          logger.debug(`Could not set code '${redoCode}' on new task`);
        }
      }
    }

    // Set redo_of metadata to link back to old task
    await storage.updateTaskMetadata(newTask.id, 'redo_of', oldTask.id);

    // --- Now close old task (single call, with correct reason) ---
    console.log(`Closing task ${theme.taskId(displayId(oldTask))}...`);

    await storage.closeTask(oldTask.id, `Redone as ${displayId(newTask)}`, getActor());

    // Clean up container and worktree
    if (sess) {
      await cleanupTaskContainer(storage, sess, taskRef(oldTask), root);

      try {
        const config = loadConfig(root);
        const driver = createDriver(config);
        await driver.cleanup(sess.git_branch);
      } catch (err) {
        logger.debug(`Remote cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }

      cleanupWorktreeAndBranch(worktreePath, sess.git_branch, root);
    }

    newTaskShortId = shortId(newTask.id);

    console.log(`Created task ${theme.taskId(displayId(newTask))} — redo of ${displayId(oldTask)}`);
    console.log(`  ${theme.label('Goal:')} ${newTask.goal}`);
    if (newModel) {
      console.log(`  ${theme.label('Model:')} ${newModel}`);
    }

  } finally {
    await storage.close();
  }

  // --- Optionally start new task ---
  if (!noStart) {
    const startArgs = [newTaskShortId, '--yes'];
    if (modelOverride) {
      startArgs.push('--model', modelOverride);
    }
    await commandStart(startArgs);
  } else {
    console.log(`\nTask is in backlog. Start it with: ${theme.command('lazy start ' + newTaskShortId)}`);
  }
}

export function redoUsage(): void {
  console.log(`Usage: lazy redo <task_id> [--prompt <text>] [--model <model>] [--no-start] [--yes]

Close a stale task and restart the same work fresh on current main.

This is useful when a task's branch has fallen too far behind main and merging
would be more expensive than redoing the work from scratch. The old task's
history is preserved (closed, not deleted) and the new task links back to it.

Arguments:
  <task_id>          ID of the task to redo

Options:
  --prompt <text>    Override the prompt for the new task (default: inherit old prompt)
  --model <model>    Override model for the new task (sonnet, opus, haiku)
  --no-start         Create the new task but don't start it (backlog)
  --yes              Skip confirmation prompt when starting

What gets carried over:
  - Goal (always)
  - Prompt (latest version, unless --prompt overrides)
  - Model (unless --model overrides)
  - Task code (if set, best-effort)
  - Context from previous attempt (agent summary + diff stat)

What starts fresh:
  - Git branch (created from current main HEAD)
  - Session (new agent session)
  - Turn history (only injected as context, not replayed)

Examples:
  lazy redo abc123                        # Redo task, start immediately
  lazy redo abc123 --no-start             # Redo but keep in backlog
  lazy redo abc123 --prompt "Updated requirements"  # Redo with new prompt
  lazy redo fix-auth --model opus         # Redo with different model`);
}
