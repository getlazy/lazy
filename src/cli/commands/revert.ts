import { requireLazyRoot, requireStorage, shortId, displayId, taskRef, parseFlags, resolveTaskOrExit, formatDate, getBranchNameFromId } from '../helpers';
import { openEditor, removeRecoveryFile, isTTY } from '../editor';
import { theme } from '../theme';
import { getActor } from '../../constants';
import { runGit } from '../../utils/git';
import { parentTaskIdOf } from '../../task-target';

/**
 * Find the merge commit SHA for an accepted task on the target branch.
 *
 * Searches for commits matching "Accept task <ref>". The ref is whatever
 * `taskRef()` returns — the task's code when it has one, the short id
 * otherwise — because that is exactly what the accept merge wrote
 * (mergeOptions.taskShortId = taskRef(task) in acceptTask). Grepping for the
 * short id unconditionally never matched a task that had a code.
 */
async function findMergeCommit(ref: string, targetBranch: string, root: string): Promise<string | null> {
  const result = await runGit(
    ['log', targetBranch, '--grep', `Accept task ${ref}`, '--format=%H', '-1'],
    { cwd: root },
  );
  if (result.exitCode !== 0) return null;
  const sha = result.stdout;
  return sha || null;
}

export async function commandRevert(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'reason', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'revert');

  const taskId = parsed.positional[0];
  if (!taskId) {
    revertUsage();
    process.exit(1);
  }

  const reasonFlag = parsed.flags.get('reason') as string | undefined;
  const yes = parsed.flags.get('yes') === true;

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve the original task
    const task = await resolveTaskOrExit(storage, taskId);

    // Validate: task must be complete
    if (task.status !== 'complete') {
      console.error(`Task ${displayId(task)} is ${task.status}, not complete. Only completed (accepted) tasks can be reverted.`);
      process.exit(1);
    }

    // Validate: task must have an accepted session
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session.`);
      process.exit(1);
    }
    if (sess.outcome !== 'accepted') {
      console.error(`Task ${displayId(task)} was not accepted (outcome: ${sess.outcome ?? 'none'}).`);
      process.exit(1);
    }

    // Determine the target branch where the merge landed
    const parentId = parentTaskIdOf(task);
    const mergeTargetBranch = parentId
      ? await getBranchNameFromId(parentId, storage)
      : 'main';

    // Find the merge commit
    const acceptRef = taskRef(task);
    const mergeSha = await findMergeCommit(acceptRef, mergeTargetBranch, root);
    if (!mergeSha) {
      console.error(`Could not find merge commit for task ${displayId(task)} on ${mergeTargetBranch}.`);
      console.error(`Expected a commit matching "Accept task ${acceptRef}" on branch ${mergeTargetBranch}.`);
      console.error('The commit may have been rebased, squashed, or the branch may have diverged.');
      process.exit(1);
    }

    const mergeShortSha = mergeSha.substring(0, 7);

    // Display task info
    console.log(`Task ${theme.taskId(displayId(task))} was accepted${task.completed_at ? ` on ${formatDate(task.completed_at)}` : ''} and merged into ${mergeTargetBranch}.`);
    console.log(`Merge commit: ${theme.commitSha(mergeShortSha)}`);

    // Get revert reason: --reason flag, $EDITOR, or required
    let reason: string;
    let reasonRecoveryPath: string | null = null;

    if (reasonFlag !== undefined) {
      reason = reasonFlag;
    } else if (isTTY() && !yes) {
      // Interactive: open editor for reason
      console.log('');
      const editResult = await openEditor('', `revert-reason-${shortId(task.id)}`);
      if (editResult === null) {
        console.log('Editor cancelled.');
        return;
      }
      const { content, recoveryPath } = editResult;
      if (!content.trim()) {
        console.error('Revert reason cannot be empty.');
        if (recoveryPath) removeRecoveryFile(recoveryPath);
        process.exit(1);
      }
      reason = content.trim();
      reasonRecoveryPath = recoveryPath;
    } else {
      console.error('Revert reason is required. Use --reason "..." or run interactively.');
      process.exit(1);
    }

    // CRITICAL: Save human input first — persist reason as a comment on the original task
    // BEFORE creating the revert task or any operation that might fail.
    await storage.createComment(task.id, `Revert reason: ${reason}`, getActor());

    // Clean up recovery file now that reason is durably persisted
    if (reasonRecoveryPath) removeRecoveryFile(reasonRecoveryPath);

    // Determine revert task code
    const originalCode = task.code ?? shortId(task.id);
    const revertCode = `revert-${originalCode}`;

    // Build revert task goal and prompt
    const revertGoal = `Revert commit ${mergeShortSha} from task ${originalCode}`;
    const revertPrompt = [
      `You are reverting the changes from task "${originalCode}" (${shortId(task.id)}).`,
      ``,
      `The original task's goal was: ${task.goal}`,
      ``,
      `The merge commit to revert is: ${mergeSha}`,
      `It was merged into: ${mergeTargetBranch}`,
      ``,
      `Reason for reverting: ${reason}`,
      ``,
      `## Instructions`,
      ``,
      `Run this command to revert the merge commit:`,
      ``,
      `  git revert ${mergeSha} --no-edit`,
      ``,
      `If there are conflicts (because other changes landed on ${mergeTargetBranch} after the original accept), resolve them by favoring the revert — that is, remove the original changes. The goal is to undo the original task's work completely.`,
      ``,
      `Do NOT make any other changes beyond the revert and conflict resolution.`,
      ``,
      `After the revert is clean, commit and you're done.`,
    ].join('\n');

    // Create the revert task
    const revertTask = await storage.createTask(revertGoal, undefined, undefined, revertCode);

    // Set prompt
    await storage.updateTaskPrompt(revertTask.id, revertPrompt);

    // Store metadata linking back to the original task
    await storage.updateTaskMetadata(revertTask.id, 'reverts_task_id', task.id);
    await storage.updateTaskMetadata(revertTask.id, 'reverts_merge_sha', mergeSha);
    await storage.updateTaskMetadata(revertTask.id, 'revert_reason', reason);
    await storage.updateTaskMetadata(revertTask.id, 'original_task_code', originalCode);

    console.log(`\nCreated revert task: ${theme.taskId(revertCode)}`);
    console.log(`  ${theme.label('Goal:')} ${revertGoal}`);

    // Start the revert task
    console.log(`\nStart the revert task with:`);
    console.log(`  ${theme.command(`lazy start ${revertCode} --yes`)}`);
    console.log(`\nAccept it once the revert is clean:`);
    console.log(`  ${theme.command('lazy blocked')}`);
  } finally {
    await storage.close();
  }
}

export function revertUsage(): void {
  console.log(`Usage: lazy revert <task_id> [--reason <reason>] [--yes]

Revert an accepted task by creating a revert task.

The revert task will instruct the agent to run \`git revert\` on the
original task's merge commit and resolve any conflicts.

Arguments:
  <task_id>           ID of the accepted task to revert

Options:
  --reason <reason>   Why the task is being reverted (opens $EDITOR if omitted)
  --yes               Skip interactive prompts

The original task must be:
  - In 'complete' status
  - Have an accepted session
  - Have a findable merge commit on the target branch

After the revert task is created, start it with \`lazy start\`.
Accept the revert once clean, and you'll be offered to create
a continuation task to redo the work.

Examples:
  lazy revert fix-auth                          # Interactive (opens editor for reason)
  lazy revert fix-auth --reason "Needs more testing"
  lazy revert abc12345 --reason "Broke prod" --yes`);
}
