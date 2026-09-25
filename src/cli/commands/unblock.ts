import { join } from 'path';
import { shortId, displayId, taskRef, getWorktreePathForRef, getBranchNameFromId } from '../../task/identity';
import { existsSync, readFileSync } from 'fs';
import { requireLazyRoot, requireStorage, parseFlags, validateModel, validateAgentProfileOrExit, resolveTaskOrExit, rejectIfPairing } from '../helpers';
import { createRunner } from '../../runner';
import { getCommitsBehindCount, getCurrentBranch, getRemoteDefaultBranch } from '../../git/operations';
import { runGit } from '../../utils/git';
import { isTTY, promptChoice, promptYesNo, readStdinIfPiped } from '../editor';
import { showTaskContext, runFeedbackFlow, getEditorFeedback } from './shared';
import { refreshTaskFromRemote } from './shared';
import { getNewNotesSince } from '../../task/turn-context';
import { commandAccept } from './accept';
import { commandReject } from './reject';
import { commandRedo } from './redo';
import { checkOrphanedChild } from '../../task/orphan';
import { isTerminalStatus } from '../../types';

import { queryUnblockTask } from '../../daemon/rpc-fallback';
import { requireActorIdentity } from '../identity-preflight';
import { requireUsagePauseClear } from '../usage-pause-preflight';
import { removeRecoveryFile } from '../editor';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';
import {
  argsHaveRaisedFlags,
  collectRaisedResolutionsForUnblock,
  RAISED_RESOLUTION_FLAGS,
} from '../raised-resolutions';

import { theme } from '../../render/theme';
import { createPhaseDisplay } from '../phase-display';
import { parentTaskIdOf } from '../../task-target';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { agentDisplayName } from '../../agent/registry';
import { usagePauseOverrideEligibility } from '../human-terminal';

/**
 * Determine whether unblock should run in interactive mode.
 * Interactive = TTY + no imperative flags (--message, -f, --yes, no piped stdin).
 */
function isInteractiveMode(args: string[]): boolean {
  if (!process.stdin.isTTY) return false;
  if (args.includes('--message') || args.includes('-m')) return false;
  if (argsHaveRaisedFlags(args)) return false;
  if (args.includes('--yes')) return false;
  if (args.indexOf('-f') !== -1) return false;
  return true;
}

export async function commandUnblock(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    // `-f` is the documented spelling (see unblockUsage) and the one
    // isInteractiveMode checks for, but parseFlags only registers `--<name>`
    // unless an alias is declared — so `-f` was rejected as an unknown flag.
    { name: 'f', aliases: ['f'], takesValue: true },
    { name: 'message', aliases: ['m'], takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'effort', takesValue: true },
    { name: 'agent', takesValue: true },
    { name: 'follow', takesValue: false },
    // Retired (move-file-approval-to-accept): still REGISTERED so a stale
    // script gets the error below naming `lazy accept` instead of a bare
    // "Unknown flag". Never read as a decision — unblock has none to make.
    { name: 'approve-file', takesValue: true, accumulate: true },
    { name: 'no-approve-files', takesValue: false },
    { name: 'yes', takesValue: false },
    ...RAISED_RESOLUTION_FLAGS,
  ], 'unblock');

  const taskId = parsed.positional[0];
  if (!taskId) {
    unblockUsage();
    process.exit(1);
  }

  // Parse flags
  const follow = parsed.flags.get('follow') === true;

  const messageValue = parsed.flags.get('message') as string | undefined;
  const retiredApproveFile = (parsed.flags.get('approve-file') as string[] | undefined) ?? [];
  const retiredNoApproveFiles = parsed.flags.get('no-approve-files') === true;
  if (retiredApproveFile.length > 0 || retiredNoApproveFiles) {
    console.error(`Error: ${retiredNoApproveFiles ? '--no-approve-files' : '--approve-file'} is no longer a flag of 'lazy unblock'.`);
    console.error('Protected-file approval happens at merge time now: unblock never reverts a file.');
    console.error(`Unblock with feedback alone, then approve when you accept: lazy accept ${taskId} --approve-file <file>`);
    process.exit(1);
  }
  const skipConfirmation = parsed.flags.get('yes') === true;
  // Optional raised-item resolutions (partial OK on unblock — unlike accept).
  const raisedResolutions = collectRaisedResolutionsForUnblock(parsed.flags);

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  let modelOverride: string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Parse --effort flag
  let effortOverride: EffortLevel | undefined;
  const effortValue = parsed.flags.get('effort') as string | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effortOverride = effortValue as EffortLevel;
  }

  // Parse --agent flag
  let agentOverride: string | undefined;
  const agentValue = parsed.flags.get('agent') as string | undefined;
  if (agentValue !== undefined) {
    await validateAgentProfileOrExit(process.cwd(), agentValue);
    agentOverride = agentValue;
  }

  const root = requireLazyRoot();
  let storage = await requireStorage();

  try {
    // Resolve task
    let task = await resolveTaskOrExit(storage, taskId);

    // Get session — lightweight check before interactive/editor work
    let sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
      process.exit(1);
    }
    const canResume = !!sess.agent_session_id;
    if (!canResume) {
      // Name the agent that will actually run — `--agent` switches it for this
      // turn — never "Claude", which is wrong on a cursor task.
      console.log(
        `Session has no agent session ID. Will start a fresh ${agentDisplayName(agentOverride ?? task.agent_id)} session.`,
      );
    }
    if (sess.ended_at) {
      console.error('Session has ended. Create a variant with: lazy branch ' + displayId(task));
      process.exit(1);
    }

    // Lightweight status checks before any interactive work.
    // These prevent the user from entering an editor only to have the RPC reject them.
    //
    // The identity check is first among them for exactly that reason: the
    // daemon refuses a turn it cannot attribute, and finding that out after the
    // editor closes would cost the human their feedback.
    await requireActorIdentity();
    if (task.status === 'working') {
      console.error(`Task ${displayId(task)} is still working. Wait for it to finish.`);
      console.error(`Check progress with: lazy blocked`);
      process.exit(1);
    }
    if (task.status === 'pairing') {
      console.error(`Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
      process.exit(1);
    }
    // Same reason as the identity check: a paused credential refuses the turn,
    // and that must be said before the editor opens, not after.
    // Judged on the agent this unblock will run, which `--agent` may change.
    await requireUsagePauseClear(task.id, 'unblock', agentOverride);

    // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept):
    // there is no protected-file guard here at all. Unblock is a feedback
    // channel and never reverts a file, so a `conflict` task unblocks exactly
    // like a `blocked` one; the reviewer decides at `lazy accept`, which
    // refuses until every pending violation is named.

    // Check for orphaned child — prompt in CLI, pass retargetOrphan to RPC
    let retargetOrphan = false;
    if (parentTaskIdOf(task)) {
      const orphanStatus = await checkOrphanedChild(task, storage, root);
      if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
        console.log(theme.warning(`\nParent task was accepted and its branch deleted.`));
        console.log(`This task needs to be retargeted to ${theme.taskId(orphanStatus.retargetBranch)} before continuing.\n`);

        let shouldRetarget: boolean;
        if (isTTY()) {
          shouldRetarget = await promptYesNo(`Retarget to ${orphanStatus.retargetBranch}?`, true);
        } else {
          shouldRetarget = true;
          console.log(`Automatically retargeting to ${orphanStatus.retargetBranch} (non-interactive mode).`);
        }

        if (!shouldRetarget) {
          console.error('Cannot continue without retargeting. The parent branch no longer exists.');
          process.exit(1);
        }

        retargetOrphan = true;
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
        await refreshTaskFromRemote(task.id);

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
          parentTaskIdOf(task),
          storage,
          task.id,
          sess.id,
          displayId(task),
        );

        // Detect staleness
        const STALE_THRESHOLD = 5;
        let commitsBehind = 0;
        let isStale = false;
        try {
          const parentId = parentTaskIdOf(task);
          const mainBranch = parentId
            ? await getBranchNameFromId(parentId, storage)
            : await getRemoteDefaultBranch(root);
          commitsBehind = await getCommitsBehindCount(sess.git_branch, mainBranch, root);
          isStale = commitsBehind >= STALE_THRESHOLD;
        } catch {
          // Non-fatal
        }

        if (isStale) {
          console.log(`\n⚠ Branch is ${commitsBehind} commits behind — consider redoing from scratch.`);
        }

        const menuOptions = unseenCount > 0
          ? [
              'Give feedback - includes unseen comments (recommended)',
              `Accept anyway (agent hasn't seen ${unseenCount} comment${unseenCount === 1 ? '' : 's'})`,
              'Reject (discard work)',
              ...(isStale ? [`Redo from scratch (lazy redo) — ${commitsBehind} commits behind`] : []),
            ]
          : [
              'Give feedback (open editor)',
              'Accept (merge work)',
              'Reject (discard work)',
              ...(isStale ? [`Redo from scratch (lazy redo) — ${commitsBehind} commits behind`] : []),
            ];

        const choice = await promptChoice('What would you like to do?', menuOptions);

        let nextIdx = 3;
        const redoIdx = isStale ? nextIdx++ : -1;

        // Close storage before delegating to accept/abandon/redo (they open their own)
        await storage.close();

        if (choice === redoIdx) {
          await commandRedo([taskShortId, '--yes']);
          return;
        }

        switch (choice) {
          case 1:
            await commandAccept([taskShortId]);
            return;
          case 2:
            await commandReject([taskShortId]);
            return;
          default:
            break;
        }

        // Re-open storage for the feedback flow
        const storage2 = await requireStorage();
        let shouldContinue = false;
        try {
          const task2 = await storage2.getTask(taskId);
          if (!task2) { console.error(`Task not found: ${taskId}`); process.exit(1); }
          const sess2 = await storage2.getSessionByTaskId(task2.id);
          if (!sess2) { console.error(`Task ${taskShortId} has no session.`); process.exit(1); }

          const result = await runFeedbackFlow(task2, sess2, root, storage2, worktreePath, taskShortId, follow, modelOverride, effortOverride, agentOverride);
          shouldContinue = result === 'continue';
        } finally {
          await storage2.close();
        }

        if (shouldContinue) {
          const storage3 = await requireStorage();
          storage = storage3;
          const task3 = await storage.getTask(taskId);
          if (!task3) { console.error(`Task not found: ${taskId}`); process.exit(1); }
          task = task3;
          const sess3 = await storage.getSessionByTaskId(task.id);
          if (!sess3) { console.error(`Task ${taskShortId} has no session.`); process.exit(1); }
          sess = sess3;
        } else {
          return;
        }
      }
    }

    // --- Imperative mode ---

    // Sync PR comments and state before collecting/sending feedback
    await refreshTaskFromRemote(task.id);

    // Re-read task in case sync updated its status
    const freshTask = await storage.getTask(task.id);
    if (freshTask && isTerminalStatus(freshTask.status)) {
      console.log(`Task ${displayId(task)} is now ${freshTask.status}. Nothing to unblock.`);
      return;
    }

    // Get feedback from -f file, --message, piped stdin, or $EDITOR.
    let message: string | null = null;
    let feedbackRecoveryPath: string | null = null;
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
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        message = stdinContent;
      } else {
        if (process.stdin.isTTY) {
          const taskShortId = shortId(task.id);
          const tRef = taskRef(task);
          const worktreePath = getWorktreePathForRef(root, tRef);
          const result = await getEditorFeedback(task.id, task.goal, sess.id, taskShortId, storage, false, worktreePath, parentTaskIdOf(task), root, displayId(task));
          if (result.type !== 'feedback') {
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

    if (!message) {
      console.error('No feedback provided. Use --message flag or pipe via stdin.');
      process.exit(1);
    }
    if (!message.trim()) {
      console.error('Empty feedback.');
      process.exit(1);
    }

    // INTAKE BOUNDARY: feedback becomes argv[2] of `claude -p` at the delivery
    // seam, where a raw NUL is fatal. Escape non-printable control characters
    // now — before persistence — so the feedback is delivered rather than
    // crash-looping the turn and being silently dropped by the stale auto-resume.
    // Sanitize-and-deliver, never reject: see src/utils/sanitize-text.ts.
    message = sanitizeUserText(message);

    // Close storage before RPC call — daemon has its own storage
    await storage.close();

    // --- Delegate to daemon RPC ---
    const display = createPhaseDisplay();
    try {
      const rpcResult = await queryUnblockTask({
        taskId: task.id,
        message,
        modelOverride,
        raisedResolutions,
        retargetOrphan,
        notesInEditor,
        effortOverride,
        agentOverride,
        ...(await usagePauseOverrideEligibility()),
      }, display);

      // Clean up recovery file — feedback is now durably persisted in daemon
      if (feedbackRecoveryPath) {
        removeRecoveryFile(feedbackRecoveryPath);
      }

      // Print warnings from daemon
      for (const w of rpcResult.warnings) {
        console.log(w);
      }

      // Print summary
      const taskShortId = shortId(task.id);
      console.log(theme.success(`\nTask ${taskShortId} unblocked (turn ${rpcResult.turnNumber})`));
      console.log(`  ${theme.label(`${rpcResult.runnerLabel}:`)} ${rpcResult.runnerDisplayName}`);

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: ${theme.command('lazy blocked')}`);
        console.log(`Or check status with: ${theme.command('lazy status ' + displayId(task))}`);
      }

      if (follow) {
        // Re-open storage for follow mode
        const storage2 = await requireStorage();
        try {
          const { followContainer } = await import('./shared');
          const runner = await (await import('../../runner')).createRunner(root);
          const protoDir = (await import('../../protocol')).protocolDir(task.id);
          const exitCode = await followContainer(rpcResult.containerName, storage2, root, rpcResult.worktreePath, protoDir, runner);
          await storage2.close();
          process.exit(exitCode);
        } finally {
          await storage2.close();
        }
      }
    } catch (err) {
      // If RPC fails, preserve recovery file so feedback isn't lost
      if (feedbackRecoveryPath) {
        console.error(`Feedback saved to recovery file: ${feedbackRecoveryPath}`);
      }
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      display.close();
    }

    return; // Storage already closed above
  } finally {
    // Storage may have been closed already in the imperative path
    try {
      await storage.close();
    } catch {
      // Already closed — fine
    }
  }
}

export function unblockUsage(): void {
  console.log(`Usage: lazy unblock <task_id> [-f <file> | -m|--message <text>] [--model <model>] [--effort <level>] [--agent <profile>] [--respond-raised <id>=<text>...] [--promote-raised-subtask <id>...] [--promote-raised-peer <id>...] [--dismiss-raised <id>=<reason>...] [--acknowledge-raised <id>...] [--yes] [--follow]

Unblock a task by providing feedback, or interactively review and act on it.

When called with no flags (interactive mode), shows task context and lets you:
  1. Give feedback (opens editor)
  2. Accept the work (merge)
  3. Reject the work (discard)

If the task is in 'merging' state (stuck waiting for CI/merge), unblock moves it
back to 'blocked' so you can give feedback, fix issues, and retry accept later.
A task whose accept died mid-way is being resumed by the daemon instead; unblock
refuses it until those resumes are exhausted (run 'lazy accept' to resume now).

When called with flags (imperative mode), sends feedback directly.

Use 'lazy blocked' to check when the agent finishes and needs your input.
To review all blocked tasks sequentially, use: lazy loop

To merge upstream changes into a task branch, use: lazy sync <task_id>

Arguments:
  <task_id>           ID of the blocked task to unblock

Options:
  -f <file>           Read feedback from a file
  -m, --message <text>  Provide inline feedback
  --model <model>     Override model for this turn (e.g. opus, sonnet, claude-opus-5)
  --effort <level>    Override Claude Code reasoning effort for this turn (low, medium, high, xhigh, max)
                      Persists on the task for future turns.
  --agent <profile>   Switch this task to a different agent profile — an [agents.<name>]
                      block in lazy.toml; harness names (claude-code, codex, cursor, pi)
                      are the built-in profiles.
                      Persists on the task for future turns. When switching agents,
                      the session is reset (cannot resume across agents).
  --respond-raised <id>=<text>
                      Optionally respond to an open raised item (repeatable).
                      Unlike accept, partial resolution is OK — unnamed items stay
                      open for the next accept.
  --promote-raised-subtask <id>
                      Optionally create a child task under this one for the item
                      (repeatable; optional =<note>).
  --promote-raised-peer <id>
                      Optionally create a sibling task for the item (repeatable;
                      optional =<note>). Lazy creates either promoted task itself,
                      and the agent is told so it stops re-raising.
  --dismiss-raised <id>=<reason>
                      Optionally dismiss an open raised item (repeatable).
  --acknowledge-raised <id>
                      Acknowledge an open raised item — "seen, maybe later"
                      (repeatable; optional =<note>). Same act as dismiss, with
                      a different valence; works on any item.
  --yes               Skip interactive prompts (non-interactive mode)
  --follow            Wait for the agent to finish, streaming output in real time

Feedback input priority: --message flag > -f file > piped stdin > $EDITOR (interactive)

Interactive mode (no flags, TTY):
  Shows task summary, recent commits, diff summary, then presents choices:
  give feedback, accept, or reject.

Imperative mode (any flag or piped stdin):
  Sends feedback directly without interactive preamble.

Upstream Merge:
  Unblock no longer merges upstream automatically. To merge upstream changes
  into a task branch, use 'lazy sync <task_id>' as a separate step before
  or after unblocking.

File Permission Violations (conflict status):
  When the agent modifies protected files, the task enters 'conflict' status.
  That status means one thing: a decision is owed at MERGE time. Unblock does
  not ask for it and never reverts a file — a conflict task is unblocked exactly
  like a blocked one, as many times as the work needs.

  While the agent still has the context, each turn ends with a pushback asking it
  to revert the file itself or record a keep reason. You decide at accept:

    lazy accept <task_id> --approve-file <file> ...

  Accept is all-or-nothing: every pending violated file must be named or the
  accept is refused, and nothing is ever reverted for you. Approvals are sticky,
  so a file you approved stays approved; the web review page ('lazy dashboard')
  has per-file controls and un-approving returns a file to pending.

Raised items (optional on unblock):
  The same --respond-raised / --promote-raised-subtask / --promote-raised-peer /
  --dismiss-raised flags as accept. They are OPTIONAL here: resolve what the
  feedback answers; leave the rest open for the next accept. Feedback prose is
  never parsed for answers. Comments are written on this unblock.

Examples:
  lazy unblock abc123                                   # Interactive review
  lazy unblock abc123 --message "Add error handling"    # Direct feedback
  lazy unblock abc123 -f feedback.md
  lazy unblock abc123 --model opus --message "Complex refactoring needed"
  lazy unblock abc123 --agent cursor --message "Continue with Cursor"  # Switch agent
  lazy unblock abc123 --message "Fix it" --follow       # Wait for completion
  lazy unblock abc123 --message "Fix it" --yes          # Non-interactive
  echo "Fix the bug" | lazy unblock abc123              # Piped stdin as feedback
  lazy unblock abc123 --respond-raised a1b2c3d4="go with option 2" --message "Agreed" --yes

  # Merge upstream first, then give feedback:
  lazy sync abc123
  lazy unblock abc123 --message "Fix the bug"
  lazy unblock abc123 --message "Keep going"                          # Conflict tasks unblock like any other`);
}
