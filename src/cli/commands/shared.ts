/**
 * Interactive review helpers for CLI commands.
 *
 * What is left here is the part a HUMAN sitting at a terminal drives: following
 * a running container, printing a task's context before a review, opening
 * $EDITOR for feedback, and the accept/reject/close flow that reads the answer.
 *
 * The domain work these used to sit next to has moved out of `src/cli/`, where
 * the daemon can reach it without importing a command module:
 * prompt assembly and the notes cutoff in `src/task/turn-context.ts`, worktree
 * and container teardown in `src/task/cleanup.ts`, forge reconciliation in
 * `src/task/sync-remote.ts`.
 */

import { getBranchNameFromId, displayId } from '../../task/identity';
import { existsSync } from 'fs';
import { getBranchCommitMessages, getCurrentSha, getNewCommits, getRemoteDefaultBranch, getDiffStat } from '../../git/operations';
import { createRunner } from '../../runner';
import { hasResponse, readCommand, protocolDir as getProtocolDir } from '../../protocol';
import type { StartCommand, UnblockCommand } from '../../protocol';

import { loadConfig } from '../../config/loader';
import { openEditor, readStdin, removeRecoveryFile, requireTTY } from '../editor';
import { buildEditorContentWithDiff, buildFreeformEditorContentWithNotes, extractFeedbackFromDiff, stripCommentLines, getTurnDiff } from '../../utils/diff';
import { logger } from '../../utils/logger';
import type { Storage } from '../../storage';
import { requireStorage } from '../helpers';
import type { Session, Turn } from '../../types';
import { gitDiffPaths, resolveTaskDiffBase, resolveTaskDirectDiff } from '../../task-diff-base';
import { createDriver } from '../../remote';
import { getNewNotesSince, resolveNotesCutoff } from '../../task/turn-context';

import { commandAccept } from './accept';
import { theme, dim } from '../../render/theme';
import { parentTaskIdOf } from '../../task-target';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { ActivityMonitor, parseSupervisorLogLine } from '../activity-monitor';
import { queryUnblockTask } from '../../daemon/rpc-fallback';
import { runGit } from '../../utils/git';
import { latestWorkAgentTurn } from '../../utils/turns';
import { turnText } from '../../utils/turn-content';
import { usagePauseOverrideEligibility } from '../human-terminal';

const PROGRESS_POLL_MS = 1000;

/** Elapsed MM:SS timestamp for progress output. */
let progressStartTime = Date.now();

function ts(): string {
  const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  return `[${m}:${s}]`;
}

/**
 * Get the number of dirty (modified/untracked) files in a worktree.
 * Returns 0 if the git command fails (e.g. worktree is gone).
 */
async function getDirtyFileCount(worktreePath: string): Promise<number> {
  const result = await runGit(['status', '--porcelain', '--', ':!.lazy-task-sandbox'], {
    cwd: worktreePath,
    stderr: 'ignore',
    timeout: 5000,
  });
  if (result.exitCode !== 0) return 0;
  if (!result.stdout) return 0;
  return result.stdout.split('\n').length;
}

/**
 * Extract the task short ID from a container name.
 * Container names follow the pattern "lazy-{taskShortId}".
 */
function taskIdFromContainer(containerName: string): string {
  return containerName.replace(/^lazy-/, '');
}

/**
 * Monitor a worktree for progress (new commits and file changes) and print
 * status lines to the terminal. Runs until the returned stop function is called.
 *
 * Returns a stop function that terminates the monitoring loop.
 */
function monitorWorktreeProgress(
  containerName: string,
  worktreePath: string,
  turnStartedAt?: string,
): () => void {
  progressStartTime = turnStartedAt ? new Date(turnStartedAt).getTime() : Date.now();
  const taskId = taskIdFromContainer(containerName);
  let lastSeenSha: string | null = null;
  let lastDirtyCount = 0;
  let stopped = false;

  // Try to get the initial HEAD SHA; if worktree isn't ready, we'll pick it up later
  getCurrentSha(worktreePath).then(sha => {
    lastSeenSha = sha;
  }).catch(() => {
    // Worktree may not exist yet, will try again on next tick
  });

  const timer = setInterval(async () => {
    if (stopped) return;

    try {
      // Check for new commits
      if (lastSeenSha) {
        // First-parent: a merge the turn made is one line on this readout, not
        // every commit the merged-in branch carried.
        const newCommits = await getNewCommits(lastSeenSha, worktreePath, { firstParent: true });
        // Print in chronological order (getNewCommits returns newest first)
        for (let i = newCommits.length - 1; i >= 0; i--) {
          const commit = newCommits[i];
          console.log(`${ts()} [${theme.taskId(taskId)}] New commit: ${theme.commitSha(commit.sha.substring(0, 7))} ${commit.message}`);
        }
        if (newCommits.length > 0) {
          lastSeenSha = newCommits[0].sha; // getNewCommits returns newest first
        }
      } else {
        // Try to initialize lastSeenSha if we couldn't before
        try {
          lastSeenSha = await getCurrentSha(worktreePath);
        } catch {
          // Still not ready
        }
      }

      // Check for working file count changes
      const dirtyCount = await getDirtyFileCount(worktreePath);
      if (dirtyCount !== lastDirtyCount) {
        if (dirtyCount > 0) {
          console.log(`${ts()} [${theme.taskId(taskId)}] Working: ${dirtyCount} file${dirtyCount === 1 ? '' : 's'} changed`);
        }
        lastDirtyCount = dirtyCount;
      }
    } catch {
      // Silently skip — worktree may be gone or in a transient state
    }
  }, PROGRESS_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Follow a running supervisor container: stream its output to the terminal
 * and poll for the response.json that indicates this turn is complete.
 *
 * Used by --follow flag on start, unblock, and resume commands.
 *
 * With the supervisor model, the container doesn't exit per-turn — it stays
 * alive between turns. So we can't simply wait for container exit. Instead:
 *   1. Start monitoring worktree for progress (commits, file changes)
 *   2. Start streaming container logs in background
 *   3. Poll for response.json (supervisor writes it when turn completes)
 *   4. Once response found, stop streaming/monitoring and run reconciliation
 *   5. If container exits before response, also reconcile
 *
 * Returns the process exit code (0 if turn completed successfully, 1 otherwise).
 */
export async function followContainer(
  containerName: string,
  storage: Storage,
  lazyRoot: string,
  worktreePath: string,
  protocolDir?: string,
  existingRunner?: import('../../runner').Runner,
): Promise<number> {
  logger.debug(`Following container ${containerName}...`);

  // Read turn_started_at from the command so elapsed timestamps match the supervisor
  let turnStartedAt: string | undefined;
  if (protocolDir) {
    const cmd = readCommand(protocolDir);
    if (cmd && cmd.type !== 'stop') {
      turnStartedAt = (cmd as StartCommand | UnblockCommand).turn_started_at;
    }
  }

  // Start monitoring worktree for progress (commits, file changes)
  const stopMonitoring = monitorWorktreeProgress(containerName, worktreePath, turnStartedAt);

  // The runner is authoritative for where the agent writes its session logs,
  // so resolve it before starting the activity monitor.
  const runner = existingRunner ?? await createRunner(lazyRoot);

  // Start activity monitor for Claude Code JSONL session logs
  const taskId = taskIdFromContainer(containerName);
  const activityMonitor = new ActivityMonitor(runner, worktreePath, taskId, turnStartedAt);
  activityMonitor.start();

  // Stream run logs in background, parsing supervisor output into
  // formatted activity lines instead of raw output.
  let followHandle: ReturnType<typeof runner.followOutput> = null;
  try {
    followHandle = runner.followOutput(containerName, turnStartedAt);

    if (followHandle && followHandle.stdout) {
      // Process log lines in background
      // For Docker: `docker logs --follow --since`, for host-process: `tail -f`
      const stdout = followHandle.stdout;
      (async () => {
        const reader = stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              const formatted = parseSupervisorLogLine(line);
              if (formatted) {
                console.log(`${dim(ts())} [${theme.taskId(taskId)}] ${formatted}`);
              }
            }
          }
        } catch {
          // Stream ended or error — normal during shutdown
        }
      })();
    }
  } catch {
    // Runner may not support log following — proceed with polling
  }

  // Poll for completion: either response.json appears or container exits.
  // On each poll cycle, also drain and print any new JSONL activity lines.
  const POLL_INTERVAL_MS = 1000;
  let turnCompleted = false;

  while (true) {
    // Print any new activity from JSONL session logs
    activityMonitor.printDrain();

    // Check if supervisor wrote a response
    if (protocolDir && hasResponse(protocolDir)) {
      logger.debug('Supervisor response detected');
      turnCompleted = true;
      break;
    }

    // Check if run is still active
    if (!(await runner.isRunning(containerName))) {
      logger.debug(`Run ${containerName} exited`);
      break;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  // Drain any remaining activity lines
  activityMonitor.printDrain();

  // Stop monitoring
  stopMonitoring();
  activityMonitor.stop();

  // Kill the log streamer
  if (followHandle) {
    try {
      followHandle.process.kill();
    } catch {
      // Best effort
    }
  }

  logger.debug(`Turn follow complete (response: ${turnCompleted})`);

  return turnCompleted ? 0 : 1;
}

/**
 * Show a task context summary for interactive review.
 * Returns the number of unseen comments (added after agent's last turn).
 */
export async function showTaskContext(
  taskShortId: string,
  goal: string,
  status: string,
  turnCount: number,
  gitBranch: string,
  worktreePath: string,
  root: string,
  parentTaskId: string | null,
  storage: Awaited<ReturnType<typeof requireStorage>>,
  taskId: string,
  sessionId: string,
  taskDisplayId?: string,
): Promise<number> {
  console.log(`\nTask: ${taskDisplayId ?? taskShortId}`);
  console.log(`Goal: ${goal}`);

  // Detect unseen comments — same cutoff the next unblock will use, so what the
  // human is told is unseen is exactly what the agent will be handed.
  const allNotes = await storage.getTaskComments(taskId);
  const turns = await storage.getSessionTurns(sessionId);
  const cutoff = resolveNotesCutoff(await storage.getSession(sessionId), turns);
  const unseenNotes = cutoff === null ? allNotes : getNewNotesSince(allNotes, cutoff);

  const statusLine = `Status: ${status}  |  Turns: ${turnCount}`;
  if (unseenNotes.length > 0) {
    console.log(`${statusLine}  |  ${unseenNotes.length} unseen comment${unseenNotes.length === 1 ? '' : 's'}`);
    console.log(`\nComments since agent's last turn:`);
    for (const note of unseenNotes) {
      const firstLine = note.content.split('\n')[0];
      const truncated = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;
      console.log(`  - ${truncated}`);
    }
  } else {
    console.log(statusLine);
  }

  // Show recent commits, against the ref the task branch was cut from —
  // resolved through the one shared resolver (src/task-diff-base.ts) so this
  // summary cannot disagree with `lazy diff` or review.
  const taskData = await storage.getTask(taskId);
  const commitBase = taskData
    ? await resolveTaskDiffBase({
      task: taskData,
      session: (await storage.getSessionByTaskId(taskId)) ?? ({} as Session),
      storage,
      projectRoot: root,
      worktreePath: existsSync(worktreePath) ? worktreePath : root,
      config: await loadConfig(root),
    })
    : null;
  const targetBranch = commitBase?.ref
    ?? (parentTaskId ? await getBranchNameFromId(parentTaskId, storage) : await getRemoteDefaultBranch(root));

  try {
    const commits = await getBranchCommitMessages(gitBranch, targetBranch, root);
    if (commits.length > 0) {
      const recent = commits.slice(0, 5);
      console.log(`\nRecent commits (${commits.length} total):`);
      for (const msg of recent) {
        console.log(`  ${msg}`);
      }
      if (commits.length > 5) {
        console.log(`  ... and ${commits.length - 5} more`);
      }
    }
  } catch {
    // Branch may not exist yet
  }

  // Show condensed diff summary
  if (existsSync(worktreePath)) {
    try {
      const direct = taskData
        ? await resolveTaskDirectDiff({
          task: taskData,
          session: (await storage.getSessionByTaskId(taskId)) ?? ({} as Session),
          storage,
          projectRoot: root,
          worktreePath,
          config: await loadConfig(root),
        })
        : null;
      const restrict = direct ? gitDiffPaths(direct) : { paths: undefined, empty: false };
      const stat = restrict.empty
        ? ''
        : await getDiffStat(
          targetBranch,
          'HEAD',
          worktreePath,
          commitBase?.twoDot ?? false,
          restrict.paths,
        );
      if (stat) {
        console.log(`\nDiff summary:`);
        console.log(stat);
      }
    } catch {
      // Diff may fail if branches diverged
    }
  }

  console.log('');
  return unseenNotes.length;
}

/**
 * Get feedback from the user via editor interaction.
 * Returns one of:
 * - { type: 'feedback', message, recoveryPath } - User provided feedback
 * - { type: 'accept' } - User wants to accept (interactive mode only)
 * - { type: 'return_to_menu' } - User declined, return to menu (interactive mode only)
 *
 * INTAKE BOUNDARY: every returned feedback message is passed through
 * sanitizeUserText(). Editors can (and do) write raw control bytes; a NUL that
 * survives to the delivery seam becomes argv[2] of `claude -p` and kills the
 * spawn, crash-looping the turn and silently losing the human's feedback.
 */
export async function getEditorFeedback(
  taskId: string,
  taskGoal: string,
  sessionId: string,
  taskShortId: string,
  storage: Awaited<ReturnType<typeof requireStorage>>,
  isInteractive = false,
  worktreePath?: string,
  parentTaskId?: string | null,
  root?: string,
  taskDisplayId?: string,
): Promise<
  | { type: 'feedback'; message: string; recoveryPath: string | null; notesInEditor: boolean }
  | { type: 'accept' }
  | { type: 'return_to_menu' }
> {
  const editorTaskId = taskDisplayId ?? taskShortId;
  console.log(`\nTask: ${editorTaskId}`);
  console.log(`Goal: ${taskGoal}\n`);

  // Get task to fetch remote URL
  let remoteUrl: string | null = null;
  try {
    const task = await storage.getTask(taskId);
    if (task && root) {
      const config = await loadConfig(root);
      const driver = createDriver(config);
      remoteUrl = await driver.getTaskUrl(task);
    }
  } catch {
    // Non-fatal: continue without remote URL
  }

  const turns = await storage.getSessionTurns(sessionId);
  // The review editor shows the work turn's summary + diff. A trailing nudge
  // turn carries no SHAs and only the follow-up reply, so select the work turn.
  const lastAgentTurn = latestWorkAgentTurn(turns);

  if (lastAgentTurn) {
    // Compute turn diff to include in editor content
    let turnDiffResult = null;
    if (worktreePath && existsSync(worktreePath)) {
      // Get the session to access upstream_merge_sha for backward compat turns
      const session = await storage.getSession(sessionId);

      // Fallback ref for turns without per-turn SHAs: the ref the task branch
      // was cut from, via the one shared resolver (src/task-diff-base.ts).
      let fallbackFromRef: string | undefined;
      if (root) {
        const taskData = await storage.getTask(taskId);
        if (taskData) {
          const base = await resolveTaskDiffBase({
            task: taskData,
            session: session ?? ({} as Session),
            storage,
            projectRoot: root,
            worktreePath,
            config: await loadConfig(root),
          });
          fallbackFromRef = base.ref;
        } else {
          fallbackFromRef = parentTaskId
            ? await getBranchNameFromId(parentTaskId, storage)
            : await getRemoteDefaultBranch(root);
        }
      }

      const upstreamMergeSha = session?.upstream_merge_sha ?? undefined;

      turnDiffResult = await getTurnDiff(lastAgentTurn, worktreePath, fallbackFromRef, upstreamMergeSha);
    }

    // Fetch notes not yet delivered to the agent — the same cutoff the unblock
    // that follows this editor will use, so the human edits exactly the notes
    // that turn carries.
    const allNotes = await storage.getTaskComments(taskId);
    const editorCutoff = resolveNotesCutoff(await storage.getSession(sessionId), turns);
    const newNotes = editorCutoff === null ? allNotes : getNewNotesSince(allNotes, editorCutoff);

    // Build two versions: editorContent (with real comments) and
    // comparisonContent (with # placeholder where comments go).
    // The diff between comparison and edited produces comments as additions.
    const { editorContent, comparisonContent } = await buildEditorContentWithDiff(
      turnText(lastAgentTurn), turnDiffResult, editorTaskId, taskGoal, newNotes, remoteUrl ?? undefined,
    );
    console.log('Opening editor with agent\'s last response and code changes...');
    console.log('Edit the content to provide feedback, then save and close.\n');

    const editResult = await openEditor(editorContent, `unblock-${taskShortId}`);
    if (editResult === null) {
      console.error('Editor cancelled.');
      process.exit(1);
    }

    const { content: edited, recoveryPath } = editResult;
    // Use comparisonContent (not editorContent) as baseline so that
    // unchanged comments appear as additions in the diff.
    const result = extractFeedbackFromDiff(comparisonContent, edited);

    if (!result.hasChanges) {
      if (recoveryPath) removeRecoveryFile(recoveryPath);

      try {
        requireTTY('No changes detected in editor and no TTY available for fallback prompt.');
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const { promptYesNo } = await import('../editor');

      if (isInteractive) {
        // Interactive mode: no changes means approval
        const accept = await promptYesNo(
          'No changes detected. Accept this task?',
          true,
        );
        if (accept) {
          return { type: 'accept' };
        } else {
          // Return to menu
          return { type: 'return_to_menu' };
        }
      } else {
        // Imperative mode: offer manual entry
        const fallback = await promptYesNo(
          'No changes detected. Enter feedback manually instead?',
          true,
        );
        if (fallback) {
          console.log('Enter feedback (Ctrl+D to finish):');
          const message = await readStdin();
          return { type: 'feedback', message: sanitizeUserText(message), recoveryPath: null, notesInEditor: newNotes.length > 0 };
        } else {
          console.log('Cancelled.');
          process.exit(0);
        }
      }
    }

    return { type: 'feedback', message: sanitizeUserText(result.feedbackText), recoveryPath, notesInEditor: newNotes.length > 0 };
  } else {
    // Even without agent turns, include unseen comments so the human can
    // review and forward them to the agent as part of the first feedback.
    const allNotes = await storage.getTaskComments(taskId);
    const { editorContent, comparisonContent } = buildFreeformEditorContentWithNotes(editorTaskId, taskGoal, allNotes, remoteUrl ?? undefined);
    console.log('No previous agent response. Opening editor for freeform feedback...\n');

    const editResult = await openEditor(editorContent, `unblock-${taskShortId}`);
    if (editResult === null) {
      console.error('Editor cancelled.');
      process.exit(1);
    }

    const { content: edited, recoveryPath } = editResult;
    // For freeform, we also use the comparison baseline approach.
    // stripCommentLines removes # headers, then the diff captures comments.
    const message = stripCommentLines(edited);
    return { type: 'feedback', message: sanitizeUserText(message), recoveryPath, notesInEditor: allNotes.length > 0 };
  }
}

/**
 * Run the editor-based feedback flow from interactive mode.
 * This is the "Give feedback" path from the interactive choice menu.
 * Returns 'continue' to return to the interactive menu, or 'done' when complete.
 */
export async function runFeedbackFlow(
  task: Awaited<ReturnType<Awaited<ReturnType<typeof requireStorage>>['getTask']>>,
  sess: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof requireStorage>>['getSessionByTaskId']>>>,
  root: string,
  storage: Awaited<ReturnType<typeof requireStorage>>,
  worktreePath: string,
  taskShortId: string,
  follow: boolean,
  modelOverride?: string,
  effortOverride?: string,
  agentOverride?: string,
): Promise<'continue' | 'done'> {
  const result = await getEditorFeedback(task!.id, task!.goal, sess.id, taskShortId, storage, true, worktreePath, parentTaskIdOf(task!), root, displayId(task!));

  if (result.type === 'accept') {
    // User wants to accept — close storage and delegate to commandAccept
    await storage.close();
    await commandAccept([taskShortId]);
    return 'done';
  } else if (result.type === 'return_to_menu') {
    // User declined — return to interactive menu
    return 'continue';
  } else {
    // type === 'feedback'
    if (!result.message.trim()) {
      console.error('Empty feedback.');
      process.exit(1);
    }

    // Close storage before RPC — daemon has its own
    await storage.close();

    // --- Delegate to daemon RPC ---
    try {
      const rpcResult = await queryUnblockTask({
        taskId: task!.id,
        message: result.message,
        modelOverride,
        notesInEditor: result.notesInEditor,
        effortOverride,
        agentOverride,
        ...(await usagePauseOverrideEligibility()),
      });

      // Clean up recovery file — feedback is now durably persisted in daemon
      if (result.recoveryPath) {
        removeRecoveryFile(result.recoveryPath);
      }

      // Print warnings from daemon
      for (const w of rpcResult.warnings) {
        console.log(w);
      }

      // Print summary
      console.log(theme.success(`\nTask ${taskShortId} unblocked (turn ${rpcResult.turnNumber})`));
      console.log(`  ${theme.label(`${rpcResult.runnerLabel}:`)} ${rpcResult.runnerDisplayName}`);

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: ${theme.command('lazy blocked')}`);
        console.log(`Or check status with: ${theme.command('lazy status ' + displayId(task!))}`);
      }

      if (follow) {
        const storage2 = await requireStorage();
        try {
          const runner = await createRunner(root);
          const protoDir = getProtocolDir(task!.id);
          const exitCode = await followContainer(rpcResult.containerName, storage2, root, rpcResult.worktreePath, protoDir, runner);
          await storage2.close();
          process.exit(exitCode);
        } finally {
          await storage2.close();
        }
      }
    } catch (err) {
      // If RPC fails, preserve recovery file so feedback isn't lost
      if (result.recoveryPath) {
        console.error(`Feedback saved to recovery file: ${result.recoveryPath}`);
      }
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }


    return 'done';
  }
}

/**
 * Refresh a task's forge comments and PR state before a review flow shows it.
 * Optional by design: a failure (daemon unreachable, forge down, a bound
 * clone's proxy refusing) prints one warning and the flow continues with what
 * the store already has — the daemon's own remote-sync sweep catches up later.
 */
export async function refreshTaskFromRemote(taskId: string): Promise<void> {
  const { querySyncTaskFromRemote } = await import('../../daemon/rpc-fallback');
  try {
    await querySyncTaskFromRemote({ taskId });
  } catch (err) {
    console.log(theme.warning(
      `⚠ Could not refresh PR comments and state from the remote: ${err instanceof Error ? err.message : String(err)}. Continuing with what lazy already has.`,
    ));
  }
}
