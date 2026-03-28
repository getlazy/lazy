import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, resolveTaskOrExit, rejectIfPairing, taskRef, getWorktreePathForRef, getBranchNameFromId } from '../helpers';
import { createRunner, type DockerRunnerOptions } from '../../runner';
import { getCommitsBehindCount, getCurrentBranch, getRemoteDefaultBranch } from '../../git/operations';
import { runGit } from '../../utils/git';
import { isTTY, promptChoice, promptYesNo, readStdinIfPiped } from '../editor';
import { showTaskContext, runFeedbackFlow, getEditorFeedback, launchFeedbackTurn, syncTaskFromRemote, getNewNotesSince } from './shared';
import { commandAccept } from './accept';
import { commandReject } from './reject';
import { commandRedo } from './redo';
import { readPendingProposals, updateProposalStatus, type Proposal } from './propose';
import { commandCreate } from './create';
import { checkOrphanedChild, retargetOrphanedChild } from '../orphan';
import { isTerminalStatus } from '../../types';
import type { ModelName } from '../../types';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { getActor } from '../../constants';

/**
 * Determine whether unblock should run in interactive mode.
 * Interactive = TTY + no imperative flags (--message, -f, --sync-with-upstream, --yes, no piped stdin).
 */
function isInteractiveMode(args: string[]): boolean {
  if (!process.stdin.isTTY) return false;
  if (args.includes('--sync-with-upstream')) return false;
  if (args.includes('--merge-and-fix')) return false;  // hidden alias
  if (args.includes('--message')) return false;
  if (args.includes('--approve-file')) return false;
  if (args.includes('--yes')) return false;
  if (args.indexOf('-f') !== -1) return false;
  return true;
}

export async function commandUnblock(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'f', takesValue: true },
    { name: 'message', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'sync-with-upstream', takesValue: false },
    { name: 'merge-and-fix', takesValue: false },  // hidden alias for --sync-with-upstream
    { name: 'follow', takesValue: false },
    { name: 'docker-agent-no-network', takesValue: false },
    { name: 'approve-file', takesValue: true, accumulate: true },
    { name: 'no-approve-files', takesValue: false },
    { name: 'yes', takesValue: false },
  ], 'unblock');

  const taskId = parsed.positional[0];
  if (!taskId) {
    unblockUsage();
    process.exit(1);
  }

  // Parse flags
  const syncWithUpstream = parsed.flags.get('sync-with-upstream') === true || parsed.flags.get('merge-and-fix') === true;
  const follow = parsed.flags.get('follow') === true;
  const dockerAgentNoNetwork = parsed.flags.get('docker-agent-no-network') === true;
  const messageValue = parsed.flags.get('message') as string | undefined;
  const approvedFiles = (parsed.flags.get('approve-file') as string[] | undefined) ?? [];
  const noApproveFiles = parsed.flags.get('no-approve-files') === true;
  const skipConfirmation = parsed.flags.get('yes') === true;

  // --sync-with-upstream is combinable with feedback flags (--message, -f, piped stdin).
  // When combined, the feedback is delivered normally and additional merge-conflict
  // context is injected so the agent knows to review conflicts before proceeding.

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  let modelOverride: ModelName | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  const root = requireLazyRoot();
  let storage = await requireStorage();

  try {
    // Resolve task
    let task = await resolveTaskOrExit(storage, taskId);

    // Get session
    let sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
      process.exit(1);
    }
    const canResume = !!sess.agent_session_id;
    if (!canResume) {
      console.log('Session has no Claude session ID. Will start a fresh Claude session.');
    }
    if (sess.ended_at) {
      console.error('Session has ended. Create a variant with: lazy branch ' + displayId(task));
      process.exit(1);
    }

    // Task must not be actively working — nothing to unblock
    if (task.status === 'working') {
      console.error(`Task ${displayId(task)} is still working. Wait for it to finish.`);
      console.error(`Check progress with: lazy blocked`);
      process.exit(1);
    }

    // Refuse if task is in pairing state — task is locked
    if (task.status === 'pairing') {
      console.error(`Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
      process.exit(1);
    }

    // If task is merging, move it back to blocked as an escape hatch.
    // This lets the user give feedback, fix issues, and retry accept later.
    if (task.status === 'merging') {
      console.log(`Task ${displayId(task)} is in merging state. Moving back to blocked...`);
      await storage.updateTaskStatus(task.id, 'blocked', getActor());
      await storage.createComment(task.id, 'Task unblocked from merging state (manual escape hatch).', getActor());
      // Re-read task with updated status
      task = (await storage.getTask(task.id))!;
    }

    // Check for pairing lock — refuse if someone is pairing on this task
    rejectIfPairing(root, taskRef(task), displayId(task));

    // --- Guard: conflict task flags validation ---
    // File approval flags (--approve-file, --no-approve-files) are only meaningful
    // when there are actual file permission violations. Check for misuse.
    const existingTurns = await storage.getSessionTurns(sess.id);
    const latestAgentTurn = existingTurns.filter(t => t.role === 'agent').pop();
    const violations = latestAgentTurn?.violations?.filter(v => v.status === 'pending') ?? [];
    const hasViolations = task.status === 'conflict' && violations.length > 0;

    // Error: contradictory flags
    if (approvedFiles.length > 0 && noApproveFiles) {
      console.error(`Error: Cannot use both --approve-file and --no-approve-files together.`);
      console.error(`Choose one: either approve specific files or explicitly revert all.`);
      process.exit(1);
    }

    // Error: flags used when there are no violations
    if (!hasViolations && (approvedFiles.length > 0 || noApproveFiles)) {
      console.error(`Error: Task ${displayId(task)} has no file permission violations.`);
      console.error(`The --approve-file and --no-approve-files flags are only meaningful for conflict tasks.`);
      process.exit(1);
    }

    // Guard: conflict tasks in non-interactive mode require explicit intent
    if (hasViolations && !isInteractiveMode(args)) {
      // Non-interactive mode (--yes, --message, -f, piped stdin, or no TTY)
      // Must explicitly approve files OR explicitly revert all
      if (approvedFiles.length === 0 && !noApproveFiles) {
        console.error(`Error: Task ${displayId(task)} has ${violations.length} file permission violation(s).`);
        console.error(`\nViolated files:`);
        for (const v of violations) {
          console.error(`  - ${v.file}`);
        }
        console.error(`\nTo unblock, you must explicitly choose to approve or revert:`);
        console.error(`  • Approve all: ${theme.command(`lazy unblock ${displayId(task)} --approve-file ${violations.map(v => v.file).join(' --approve-file ')} --message "..." --yes`)}`);
        console.error(`  • Approve specific: ${theme.command(`lazy unblock ${displayId(task)} --approve-file <file1> --approve-file <file2> --message "..." --yes`)}`);
        console.error(`  • Revert all (destructive): ${theme.command(`lazy unblock ${displayId(task)} --no-approve-files --message "..." --yes`)}`);
        console.error(`\nNote: Both approve and revert are potentially destructive. Neither is the default.`);
        process.exit(1);
      }
    }

    // Pre-flight checks before doing expensive work
    // CRITICAL: These must happen before the human types feedback,
    // so we never lose their input to a pre-flight failure.
    const dockerOptions: Partial<DockerRunnerOptions> = {};
    if (dockerAgentNoNetwork) dockerOptions.dockerAgentNoNetwork = true;
    const runner = createRunner(root, dockerOptions);
    try {
      runner.checkAvailability();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Check for orphaned child (parent accepted, branch gone) and retarget
    if (task.parent_task_id) {
      const orphanStatus = await checkOrphanedChild(task, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        console.log(theme.warning(`\nParent task was accepted and its branch deleted.`));
        console.log(`This task needs to be retargeted to ${theme.taskId(orphanStatus.retargetBranch)} before continuing.\n`);

        let shouldRetarget: boolean;
        if (isTTY()) {
          shouldRetarget = await promptYesNo(`Retarget to ${orphanStatus.retargetBranch}?`, true);
        } else {
          // Non-TTY: retarget automatically (the alternative is a broken task)
          shouldRetarget = true;
          console.log(`Automatically retargeting to ${orphanStatus.retargetBranch} (non-interactive mode).`);
        }

        if (!shouldRetarget) {
          console.error('Cannot continue without retargeting. The parent branch no longer exists.');
          process.exit(1);
        }

        await retargetOrphanedChild(task, storage, orphanStatus.retargetBranch);
        console.log(theme.success(`Retargeted to ${orphanStatus.retargetBranch}. The next sync will merge upstream changes.\n`));

        // Update local task reference — parent_task_id is now null
        task = (await storage.getTask(task.id))!;
      }
    }

    // --- Interactive mode: show context and present choice ---
    if (isInteractiveMode(args)) {
      const taskShortId = shortId(task.id);
      const tRef = taskRef(task);
      const worktreePath = getWorktreePathForRef(root, tRef);

      // Interactive loop: allow returning to menu from editor-based feedback
      while (true) {
        // Sync PR comments and state from GitHub before showing context
        await syncTaskFromRemote(task, storage, root);

        // Re-read task in case sync updated its status (e.g., PR merged/closed externally)
        const freshTask = await storage.getTask(task.id);
        if (freshTask && isTerminalStatus(freshTask.status)) {
          console.log(`\nTask ${displayId(task)} is now ${freshTask.status}. Nothing to unblock.`);
          return;
        }

        const turnCount = await storage.getTurnCountByTaskId(task.id);

        const unseenCount = await showTaskContext(
          taskShortId,
          task.goal,
          task.status,
          turnCount,
          sess.git_branch,
          worktreePath,
          root,
          task.parent_task_id,
          storage,
          task.id,
          sess.id,
          displayId(task),
        );

        // --- Interactive mode: handle conflict tasks ---
        // When task is in conflict status (file permission violations), prompt user
        // to choose whether to approve or revert. Neither is "safe" — both require active choice.
        if (task.status === 'conflict' && approvedFiles.length === 0 && !noApproveFiles) {
          const existingTurns = await storage.getSessionTurns(sess.id);
          const latestAgentTurn = existingTurns.filter(t => t.role === 'agent').pop();
          const violations = latestAgentTurn?.violations?.filter(v => v.status === 'pending') ?? [];

          if (violations.length > 0) {
            console.log(`\n${theme.warning('⚠ File Permission Violations')}`);
            console.log(`The agent modified ${violations.length} protected file(s):\n`);

            // Show each violated file with diff stat (lines added/removed)
            for (const v of violations) {
              // Get diff stat for this specific file
              const diffResult = runGit(
                ['diff', '--numstat', v.base_sha, 'HEAD', '--', v.file],
                { cwd: worktreePath }
              );

              let statStr = '';
              if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
                const parts = diffResult.stdout.trim().split(/\s+/);
                if (parts.length >= 2) {
                  const added = parts[0];
                  const removed = parts[1];
                  statStr = ` (+${added} -${removed})`;
                }
              }

              console.log(`  - ${v.file}${statStr}`);
            }
            console.log('');

            // Present three choices with NO default
            const choice = await promptChoice(
              'What would you like to do with these violations?',
              [
                `Approve all ${violations.length} file(s) - keep agent's changes`,
                `Reject all ${violations.length} file(s) - revert to original`,
                'Stop - abort unblock (can retry with --approve-file flags)',
              ]
            );

            if (choice === 0) {
              // Approve all violations
              approvedFiles.length = 0;
              approvedFiles.push(...violations.map(v => v.file));
              console.log(`\nApproved ${violations.length} file(s). Proceeding...\n`);
            } else if (choice === 1) {
              // Reject all violations - explicitly set empty approved list (revert all)
              // The noApproveFiles flag signals to launchFeedbackTurn to revert
              // We'll pass an empty approvedFiles array which means "revert all"
              approvedFiles.length = 0;
              console.log(`\nRejecting ${violations.length} file(s). All will be reverted. Proceeding...\n`);
            } else {
              // Stop - abort
              console.log(`\nUnblock aborted. To approve specific files, use:`);
              console.log(`  ${theme.command(`lazy unblock ${displayId(task)} --approve-file <file1> --approve-file <file2>`)}`);
              console.log(`\nOr to explicitly revert all:`);
              console.log(`  ${theme.command(`lazy unblock ${displayId(task)} --no-approve-files --message "Try different approach"`)}`);
              console.log('');
              process.exit(0);
            }
          }
        }

        // Check for pending proposals
        const pendingProposals = readPendingProposals(storage, task.id);

        // Detect staleness: check how far behind main the task branch is
        const STALE_THRESHOLD = 5; // commits behind main to consider stale
        let commitsBehind = 0;
        let isStale = false;
        try {
          const mainBranch = task.parent_task_id
            ? await getBranchNameFromId(task.parent_task_id, storage)
            : getRemoteDefaultBranch(root);
          commitsBehind = getCommitsBehindCount(sess.git_branch, mainBranch, root);
          isStale = commitsBehind >= STALE_THRESHOLD;
        } catch {
          // Non-fatal: skip staleness detection if git operations fail
        }

        if (isStale) {
          console.log(`\n⚠ Branch is ${commitsBehind} commits behind — consider redoing from scratch.`);
        }

        const menuOptions = unseenCount > 0
          ? [
              'Give feedback - includes unseen comments (recommended)',
              `Accept anyway (agent hasn't seen ${unseenCount} comment${unseenCount === 1 ? '' : 's'})`,
              'Reject (discard work)',
              'Just merge upstream (--sync-with-upstream)',
              ...(isStale ? [`Redo from scratch (lazy redo) — ${commitsBehind} commits behind`] : []),
              ...(pendingProposals.length > 0 ? [`Review proposals (${pendingProposals.length} pending)`] : []),
            ]
          : [
              'Give feedback (open editor)',
              'Accept (merge work)',
              'Reject (discard work)',
              'Just merge upstream (--sync-with-upstream)',
              ...(isStale ? [`Redo from scratch (lazy redo) — ${commitsBehind} commits behind`] : []),
              ...(pendingProposals.length > 0 ? [`Review proposals (${pendingProposals.length} pending)`] : []),
            ];

        const choice = await promptChoice('What would you like to do?', menuOptions);

        // Dynamic choice mapping based on which optional items are present:
        // 0=feedback, 1=accept, 2=reject, 3=merge, then optionally redo, then optionally proposals
        let nextIdx = 4;
        const redoIdx = isStale ? nextIdx++ : -1;
        const proposalsIdx = pendingProposals.length > 0 ? nextIdx++ : -1;

        if (choice === proposalsIdx) {
          // Review proposals — then return to menu
          await reviewProposals(root, task.id, pendingProposals, storage);
          continue;
        }

        // Close storage before delegating to accept/reject/redo (they open their own)
        await storage.close();

        if (choice === redoIdx) {
          // Redo — delegate to redo command
          await commandRedo([taskShortId, '--yes']);
          return;
        }

        switch (choice) {
          case 1:
            // Accept — delegate to accept command
            await commandAccept([taskShortId]);
            return;
          case 2:
            // Reject — delegate to reject command
            await commandReject([taskShortId]);
            return;
          case 3:
            // Just merge upstream — re-invoke ourselves with --sync-with-upstream
            await commandUnblock([taskShortId, '--sync-with-upstream']);
            return;
          default:
            // Give feedback (choice 0) — fall through to editor-based feedback below
            break;
        }

        // Re-open storage for the feedback flow
        const storage2 = await requireStorage();
        let shouldContinue = false;
        try {
          // Re-resolve task (storage was closed/reopened)
          const task2 = await storage2.getTask(taskId);
          if (!task2) { console.error(`Task not found: ${taskId}`); process.exit(1); }
          const sess2 = await storage2.getSessionByTaskId(task2.id);
          if (!sess2) { console.error(`Task ${taskShortId} has no session.`); process.exit(1); }

          const result = await runFeedbackFlow(task2, sess2, root, storage2, worktreePath, taskShortId, follow, modelOverride);
          shouldContinue = result === 'continue';
        } finally {
          await storage2.close();
        }

        if (shouldContinue) {
          // Return to menu — reopen storage for next iteration
          const storage3 = await requireStorage();
          storage = storage3;
          const task3 = await storage.getTask(taskId);
          if (!task3) { console.error(`Task not found: ${taskId}`); process.exit(1); }
          task = task3;
          const sess3 = await storage.getSessionByTaskId(task.id);
          if (!sess3) { console.error(`Task ${taskShortId} has no session.`); process.exit(1); }
          sess = sess3;
          // Loop continues
        } else {
          // Done
          return;
        }
      }
    }

    // --- Imperative mode ---

    // Sync PR comments and state before collecting/sending feedback
    await syncTaskFromRemote(task, storage, root);

    // Re-read task in case sync updated its status (e.g., PR merged/closed externally)
    const freshTask = await storage.getTask(task.id);
    if (freshTask && isTerminalStatus(freshTask.status)) {
      console.log(`Task ${displayId(task)} is now ${freshTask.status}. Nothing to unblock.`);
      return;
    }

    // Get feedback from -f file, --message, piped stdin, or $EDITOR.
    // --sync-with-upstream is combinable with all of these.
    let message: string | null = null;
    // Track recovery file path so we can clean it up after DB persistence
    let feedbackRecoveryPath: string | null = null;
    // Track whether notes were shown in editor (to avoid double-injecting)
    let notesInEditor = false;
    const fileValue = parsed.flags.get('f') as string | undefined;

    if (fileValue !== undefined) {
      const filePath = fileValue;
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      message = readFileSync(filePath, 'utf-8');
    } else if (messageValue !== undefined) {
      message = messageValue;
    } else {
      // Try piped stdin before falling back to $EDITOR
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        message = stdinContent;
      } else if (!syncWithUpstream) {
        // Only fall back to $EDITOR when --sync-with-upstream is NOT set.
        // When --sync-with-upstream is alone (no explicit feedback), use
        // the canned message below instead of opening an editor.
        if (process.stdin.isTTY) {
          // Direct TTY editor flow
          const taskShortId = shortId(task.id);
          const tRef = taskRef(task);
          const worktreePath = getWorktreePathForRef(root, tRef);
          const result = await getEditorFeedback(task.id, task.goal, sess.id, taskShortId, storage, false, worktreePath, task.parent_task_id, root, displayId(task));
          if (result.type !== 'feedback') {
            // Should never happen in imperative mode
            console.error('Unexpected result from editor.');
            process.exit(1);
          }
          message = result.message;
          feedbackRecoveryPath = result.recoveryPath;
          notesInEditor = result.notesInEditor;
        } else {
          console.error('No feedback provided. Use --message flag or pipe via stdin.');
          process.exit(1);
        }
      }
    }

    // When --sync-with-upstream is set with feedback, prepend merge-conflict
    // context so the agent knows to review conflicts before the actual feedback.
    // When --sync-with-upstream is alone (no feedback), use canned message.
    if (syncWithUpstream && message && message.trim()) {
      message = 'Upstream has been merged and there may be merge conflicts. Review them carefully before proceeding with the feedback below.\n\n' + message;
    } else if (syncWithUpstream && (!message || !message.trim())) {
      message = 'No additional work needed beyond merging upstream and resolving conflicts.';
    }

    // At this point message should always be set
    if (!message) {
      console.error('No feedback provided. Use --message flag or pipe via stdin.');
      process.exit(1);
    }

    if (!message.trim()) {
      console.error('Empty feedback.');
      process.exit(1);
    }

    const taskShortId = shortId(task.id);
    const tRef = taskRef(task);
    const worktreePath = getWorktreePathForRef(root, tRef);
    await launchFeedbackTurn(task, sess, message, syncWithUpstream, root, storage, worktreePath, taskShortId, follow, modelOverride, feedbackRecoveryPath, notesInEditor, approvedFiles);
  } finally {
    await storage.close();
  }
}

/**
 * Interactive review of pending proposals.
 * For each proposal, the human can accept (create a real task) or dismiss.
 */
async function reviewProposals(
  root: string,
  taskId: string,
  proposals: Proposal[],
  storage: Awaited<ReturnType<typeof requireStorage>>,
): Promise<void> {
  console.log(`\n--- Reviewing ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} ---\n`);

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    console.log(`Proposal ${i + 1}/${proposals.length}:`);
    console.log(`  Goal: ${p.goal}`);
    if (p.code) {
      console.log(`  Code: ${p.code}`);
    }
    if (p.prompt) {
      const promptPreview = p.prompt.length > 120
        ? p.prompt.substring(0, 117) + '...'
        : p.prompt;
      console.log(`  Prompt: ${promptPreview}`);
    }
    console.log('');

    const choice = await promptChoice('What would you like to do with this proposal?', [
      'Accept (create task)',
      'Dismiss',
      'Skip (decide later)',
    ]);

    if (choice === 0) {
      // Accept: create a real task from the proposal
      const createArgs = ['--goal', p.goal];
      if (p.code) {
        createArgs.push('--code', p.code);
      }
      if (p.prompt) {
        createArgs.push('--prompt', p.prompt);
      }
      await commandCreate(createArgs);
      updateProposalStatus(storage, taskId, p.id, 'accepted');
      console.log('');
    } else if (choice === 1) {
      // Dismiss
      updateProposalStatus(storage, taskId, p.id, 'dismissed');
      console.log('Proposal dismissed.\n');
    } else {
      // Skip — leave as pending
      console.log('Skipped.\n');
    }
  }

  console.log('--- Proposal review complete ---\n');
}

export function unblockUsage(): void {
  console.log(`Usage: lazy unblock <task_id> [-f <file> | --message <text>] [--model <model>] [--sync-with-upstream] [--approve-file <file>... | --no-approve-files] [--yes] [--follow]

Unblock a task by providing feedback, or interactively review and act on it.

When called with no flags (interactive mode), shows task context and lets you:
  1. Give feedback (opens editor)
  2. Accept the work (merge)
  3. Reject the work (discard)
  4. Just merge upstream changes

If the task is in 'merging' state (stuck waiting for CI/merge), unblock moves it
back to 'blocked' so you can give feedback, fix issues, and retry accept later.

When called with flags (imperative mode), sends feedback directly.

Use 'lazy blocked' to check when the agent finishes and needs your input.
To review all blocked tasks sequentially, use: lazy loop

Arguments:
  <task_id>           ID of the blocked task to unblock

Options:
  -f <file>           Read feedback from a file
  --message <text>    Provide inline feedback
  --model <model>     Override model for this turn (apprentice, journeyman, master, sonnet, opus, haiku)
  --sync-with-upstream  Merge upstream changes and resolve conflicts (combinable with feedback)
  --approve-file <file>   Approve a violated file (repeatable, for conflict tasks)
  --no-approve-files  Explicitly revert all violated files (for conflict tasks)
  --yes               Skip interactive prompts (non-interactive mode)
  --follow            Wait for the agent to finish, streaming output in real time

Feedback input priority: --message flag > -f file > piped stdin > $EDITOR (interactive)

Interactive mode (no flags, TTY):
  Shows task summary, recent commits, diff summary, then presents choices:
  give feedback, accept, reject, or merge upstream.

  For conflict tasks: shows violated files with diff stats, then presents three
  choices (no default): approve all, reject all, or stop. You must actively choose.

Imperative mode (any flag or piped stdin):
  Sends feedback directly without interactive preamble.

  For conflict tasks: MUST use --approve-file or --no-approve-files explicitly.
  Neither approve nor revert is the default — both require explicit intent.

Sync with Upstream:
  Use --sync-with-upstream when 'lazy accept' detects conflicts. This tells the
  supervisor to merge the parent branch, resolve conflicts, and commit before
  proceeding with any work. Can be combined with feedback flags — the agent
  will resolve conflicts first, then work on the feedback.

  Note: upstream is automatically merged on every unblock when the parent branch
  has new commits. --sync-with-upstream adds a merge-conflict warning to the
  agent's context and is useful when you know there will be conflicts.

File Permission Violations (conflict status):
  When the agent modifies protected files, the task enters 'conflict' status.
  Unblocking requires explicit approval or rejection — neither is the default:

  Interactive mode:
    - Lists violated files with diff stats (+lines -lines)
    - Presents three choices with NO default:
      1) Approve all - keep agent's changes
      2) Reject all - revert to original
      3) Stop - abort and retry with --approve-file flags

  Non-interactive mode:
    - --approve-file <file> ... : approve specific files (repeatable)
    - --no-approve-files : explicitly revert all (destructive)
    - Omitting both flags with a conflict task is an error

  Misuse errors:
    - Using --approve-file and --no-approve-files together: error
    - Using these flags when task has no violations: error
    - --yes does NOT bypass the conflict guard

Examples:
  lazy unblock abc123                                   # Interactive review
  lazy unblock abc123 --message "Add error handling"    # Direct feedback
  lazy unblock abc123 -f feedback.md
  lazy unblock abc123 --model opus --message "Complex refactoring needed"
  lazy unblock abc123 --sync-with-upstream              # Fix merge conflicts
  lazy unblock abc123 --sync-with-upstream --message "Also fix the bug"  # Merge + feedback
  lazy unblock abc123 --message "Fix it" --follow       # Wait for completion
  lazy unblock abc123 --message "Fix it" --yes          # Non-interactive
  echo "Fix the bug" | lazy unblock abc123              # Piped stdin as feedback

  # Conflict task examples (file permission violations):
  lazy unblock abc123 --approve-file a.ts --approve-file b.ts --message "OK" --yes  # Approve specific files
  lazy unblock abc123 --approve-file src/config.ts --approve-file src/db.ts --yes   # Approve multiple files
  lazy unblock abc123 --no-approve-files --message "Try different approach" --yes   # Explicitly revert all`);
}
