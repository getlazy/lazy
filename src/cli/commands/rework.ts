import { requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, validateCode, resolveTaskOrExit, MAX_TASK_CODE_LENGTH } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped, requireTTY } from '../editor';
import { buildTurnHistoryContext } from './shared';
import { theme } from '../theme';
import type { ModelName, Task } from '../../types';
import type { Storage } from '../../storage/interface';
import { logger } from '../../utils/logger';

const TERMINAL_STATUSES = ['complete', 'abandoned', 'closed'];

import reworkContextTemplate from '../../prompts/rework-context.md' with { type: 'text' };

/**
 * Generate a rework code from the old task's code.
 * Convention: rework-<code>, or rework-<code>-N if rework-<code> already exists.
 */
function generateReworkCode(oldCode: string): string {
  // If old code already has a rework- prefix, increment the suffix
  const reworkMatch = oldCode.match(/^rework-(.+)-(\d+)$/);
  if (reworkMatch) {
    const base = reworkMatch[1];
    const n = parseInt(reworkMatch[2], 10) + 1;
    const code = `rework-${base}-${n}`;
    if (validateCode(code) !== null) return '';
    return code;
  }

  // If old code already starts with rework-, add -2
  if (oldCode.startsWith('rework-')) {
    const code = `${oldCode}-2`;
    if (validateCode(code) !== null) return '';
    return code;
  }

  // Default: rework-<code>
  const code = `rework-${oldCode}`;
  // Truncate if needed to fit max code length limit
  if (code.length > MAX_TASK_CODE_LENGTH) {
    const truncated = code.substring(0, MAX_TASK_CODE_LENGTH).replace(/-$/, '');
    if (validateCode(truncated) !== null) return '';
    return truncated;
  }
  if (validateCode(code) !== null) return '';
  return code;
}

/**
 * Resolve the parent for the rework task.
 * Priority: --parent flag > original task's parent > none.
 * Validates that the resolved parent is not in a terminal state.
 */
async function resolveParent(
  storage: Storage,
  originalTask: Task,
  parentFlag: string | undefined,
): Promise<string | undefined> {
  if (parentFlag !== undefined) {
    // Explicit --parent: resolve and validate
    const parentTask = await resolveTaskOrExit(storage, parentFlag);
    if (TERMINAL_STATUSES.includes(parentTask.status)) {
      console.error(`Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`);
      process.exit(1);
    }
    return parentTask.id;
  }

  // Inherit from original task's parent
  if (originalTask.parent_task_id) {
    const parentTask = await storage.getTask(originalTask.parent_task_id);
    if (parentTask && TERMINAL_STATUSES.includes(parentTask.status)) {
      console.error(`Original parent ${displayId(parentTask)} is ${parentTask.status}. Use --parent to specify where this rework should land.`);
      process.exit(1);
    }
    return originalTask.parent_task_id;
  }

  return undefined;
}

export async function commandRework(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
  ], 'rework');

  const taskId = parsed.positional[0];
  if (!taskId) {
    reworkUsage();
    process.exit(1);
  }

  const goalOverride = parsed.flags.get('goal') as string | undefined;
  const promptFlag = parsed.flags.get('prompt') as string | undefined;
  const codeOverride = parsed.flags.get('code') as string | undefined;
  const parentFlag = parsed.flags.get('parent') as string | undefined;

  let modelOverride: ModelName | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Validate --code if provided
  if (codeOverride !== undefined) {
    const codeError = validateCode(codeOverride);
    if (codeError) {
      console.error(`Invalid code '${codeOverride}': ${codeError}`);
      process.exit(1);
    }
  }

  const storage = await requireStorage();

  try {
    // Resolve original task
    const originalTask = await resolveTaskOrExit(storage, taskId);

    // Validate: task must be in 'complete' (accepted) status
    if (originalTask.status !== 'complete') {
      console.error(`Task ${displayId(originalTask)} is ${originalTask.status}, not complete (accepted).`);
      if (originalTask.status === 'abandoned' || originalTask.status === 'closed') {
        console.error(`Use \`lazy reopen ${displayId(originalTask)}\` to reopen rejected/closed tasks.`);
      } else if (originalTask.status === 'blocked') {
        console.error(`Use \`lazy unblock ${displayId(originalTask)}\` to continue blocked tasks.`);
      } else {
        console.error(`Use \`lazy create\` to create a new task instead.`);
      }
      process.exit(1);
    }

    // Resolve parent: --parent flag > original task's parent > none
    const parentTaskId = await resolveParent(storage, originalTask, parentFlag);

    // Get rework prompt from: --prompt flag > piped stdin > $EDITOR
    let reworkPrompt: string;
    let promptRecoveryPath: string | null = null;
    const originalShortId = displayId(originalTask);

    if (promptFlag !== undefined) {
      reworkPrompt = promptFlag;
    } else {
      // Try piped stdin
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        reworkPrompt = stdinContent;
      } else {
        // Interactive: open $EDITOR
        try {
          requireTTY('This command requires an interactive terminal. Use --prompt to provide a prompt non-interactively, or pipe via stdin.');
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        }

        const editorTemplate = [
          `# Rework of: ${originalShortId} (${shortId(originalTask.id)})`,
          `# Original goal: ${originalTask.goal}`,
          '#',
          '# This task continues work that was previously accepted.',
          '# The original changes are already merged into the codebase.',
          '#',
          '# Describe what needs to change:',
          '',
          '',
        ].join('\n');

        const editResult = await openEditor(editorTemplate, `rework-${shortId(originalTask.id)}`);
        if (editResult === null) {
          console.error('Error: editor exited with non-zero status');
          process.exit(1);
        }

        const { content, recoveryPath } = editResult;
        promptRecoveryPath = recoveryPath;

        // Strip comment lines and trim
        const lines = content
          .split('\n')
          .filter(line => !line.trim().startsWith('#'))
          .map(line => line.trimEnd());

        reworkPrompt = lines.join('\n').trim();

        if (!reworkPrompt) {
          if (promptRecoveryPath) removeRecoveryFile(promptRecoveryPath);
          console.error('Error: no rework prompt provided');
          process.exit(1);
        }
      }
    }

    // Gather context from original task
    const originalSess = await storage.getSessionByTaskId(originalTask.id);
    let turnHistory = '';
    if (originalSess) {
      const turns = await storage.getSessionTurns(originalSess.id);
      if (turns.length > 0) {
        turnHistory = buildTurnHistoryContext(turns);
      }
    }

    // Build the full prompt using the template
    const fullPrompt = reworkContextTemplate
      .replace('{{originalCode}}', originalTask.code ?? shortId(originalTask.id))
      .replace('{{originalShortId}}', shortId(originalTask.id))
      .replace('{{originalGoal}}', originalTask.goal)
      .replace('{{turnHistory}}', turnHistory ? turnHistory + '\n' : '')
      .replace('{{reworkPrompt}}', reworkPrompt);

    // Determine goal and code
    const newGoal = goalOverride ?? `Rework: ${originalTask.goal}`;
    const newModel = modelOverride ?? originalTask.model;

    // Create new task (with parent if resolved)
    const newTask = await storage.createTask(newGoal, parentTaskId);

    // Set prompt — CRITICAL: persist before anything else (never lose human feedback)
    await storage.updateTaskPrompt(newTask.id, fullPrompt);
    if (promptRecoveryPath) removeRecoveryFile(promptRecoveryPath);

    // Set metadata linking to original task
    await storage.updateTaskMetadata(newTask.id, 'rework_of', originalTask.id);

    // Set model
    if (newModel) {
      await storage.updateTaskModel(newTask.id, newModel);
    }

    // Set task type to 'rework'
    await storage.updateTaskType(newTask.id, 'rework');

    // Set code
    const newCode = codeOverride ?? (originalTask.code ? generateReworkCode(originalTask.code) : undefined);
    if (newCode) {
      try {
        await storage.updateTaskCode(newTask.id, newCode);
      } catch {
        // Code conflict — not critical, skip silently
        logger.debug(`Could not set code '${newCode}' on new task`);
      }
    }

    // Output
    console.log(`Created rework task ${theme.taskId(displayId(newTask))}`);
    console.log(`  ${theme.label('Goal:')}      ${newGoal}`);
    console.log(`  ${theme.label('Reworks:')}   ${displayId(originalTask)} (${shortId(originalTask.id)})`);
    if (parentTaskId) {
      console.log(`  ${theme.label('Parent:')}    ${await displayIdFor(storage, parentTaskId)}`);
    }
    if (newModel) {
      console.log(`  ${theme.label('Model:')}     ${newModel}`);
    }
    if (newTask.code || newCode) {
      console.log(`  ${theme.label('Code:')}      ${newTask.code ?? newCode}`);
    }
    console.log(`\nStart working on it with: ${theme.command(`lazy start ${displayId(newTask)}`)}`);
  } finally {
    await storage.close();
  }
}

export function reworkUsage(): void {
  console.log(`Usage: lazy rework <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a follow-up task to rework previously accepted work.

Use this when a task was accepted (squash-merged) but later needs changes —
a bug, a missed requirement, or feedback from production. Unlike reopen,
rework creates a new task that works on the current codebase where the
original changes are already present.

Arguments:
  <task_id>          ID or code of the accepted task to rework

Options:
  --goal <goal>      Override goal (default: "Rework: <original goal>")
  --prompt <text>    Rework instructions (what needs to change)
  --model <model>    Override model (default: inherit from original)
  --code <code>      Override task code (default: "rework-<original code>")
  --parent <task_id> Parent task for the rework (default: inherit from original)
                     Parent must exist and not be in a terminal state

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

The new task:
  - Links to the original via metadata (rework_of)
  - Includes the original task's conversation history as context
  - Inherits the original task's parent (unless --parent overrides)
  - Is typed as 'rework'
  - Does NOT auto-start — run \`lazy start\` when ready

Examples:
  lazy rework fix-auth
  lazy rework fix-auth --goal "Fix token expiry edge case"
  lazy rework fix-auth --prompt "The refresh token logic doesn't handle expired sessions"
  lazy rework abc12345 --code rework-fix-auth --model opus
  lazy rework fix-auth --parent release-v2
  echo "Fix the race condition in auth" | lazy rework fix-auth`);
}
