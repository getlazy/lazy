import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, resolveTaskOrExit, validateCode, taskRef } from '../helpers';
import { resolveDetachedHead } from '../../git/operations';
import { targetBranchOf } from '../../task-target';
import { isTTY, promptYesNo, promptLine, readStdinIfPiped } from '../editor';
import { commandSyncTask } from './sync';
import { loadConfig, loadRawConfig } from '../../config/loader';
import { resolveAgentForNewTask } from '../../agent/task-agent';
import { protectionHintForAccept } from '../../protection/discovery';
import { logger } from '../../utils/logger';
import { createDriver } from '../../remote';
import { getActiveChildren } from '../orphan';
import { queryAcceptTaskPreflight, queryAcceptTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';
import { createPhaseDisplay } from '../phase-display';
import { getActor } from '../../constants';
import { docsFooter, docsUrl } from '../../docs/links';

export async function commandAccept(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'yes', takesValue: false },
    { name: 'reason', takesValue: true },
    { name: 'wait', takesValue: false },
    { name: 'approve-file', takesValue: true, accumulate: true },
  ], 'accept');

  const taskId = parsed.positional[0];
  if (!taskId) {
    acceptUsage();
    process.exit(1);
  }

  const yes = parsed.flags.get('yes') === true;
  const wait = parsed.flags.get('wait') === true;
  const reasonFromFlag = parsed.flags.get('reason') as string | undefined;
  const approvedFiles = (parsed.flags.get('approve-file') as string[] | undefined) ?? [];

  const root = requireLazyRoot();

  // Get accept reason from --reason, piped stdin, or interactive prompt
  let reason: string;
  if (reasonFromFlag !== undefined) {
    reason = reasonFromFlag;
  } else {
    const stdinContent = await readStdinIfPiped();
    if (stdinContent !== null) {
      reason = stdinContent;
    } else if (yes) {
      reason = 'LGTM';
    } else if (isTTY()) {
      reason = await promptLine('Accept reason', 'LGTM');
    } else {
      reason = 'LGTM';
    }
  }
  if (!reason.trim()) {
    reason = 'LGTM';
  }

  // Warn about active children (read-only query, CLI display concern)
  {
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      const activeChildren = await getActiveChildren(task.id, storage);
      if (activeChildren.length > 0) {
        const one = activeChildren.length === 1;
        console.log(theme.warning(`\nNote: This task has ${activeChildren.length} active ${one ? 'child' : 'children'}; ${one ? "it'll" : "they'll"} be automatically re-parented on accept. Run \`lazy sync\` on ${one ? 'it' : 'each'} afterwards — until then ${one ? 'its' : 'their'} merge base is behind this merge, which is how deletions silently reappear (see ${docsUrl('resurrection-guard') ?? 'public-docs/resurrection-guard.md'}).`));
        for (const child of activeChildren) {
          console.log(`  ${theme.taskId(displayId(child))} [${theme.status(child.status)}] ${child.goal}`);
        }
        console.log('');
      }
    } finally {
      await storage.close();
    }
  }

  // Heads-up about the pre-accept validation turn. The step is OPT-IN
  // ([automation.pre_accept] enabled = true); when it is on, accept runs a
  // final agent turn BEFORE the merge and the CLI blocks on it — so tell the
  // user why this may take a while rather than letting them stare at a silent
  // prompt. When it is off (the default) accept says nothing extra and merges
  // straight away.
  {
    const config = await loadConfig(root);
    const preAccept = config.automation.pre_accept;
    if (preAccept.enabled) {
      const gateNote = preAccept.commands.length > 0
        ? ` running ${preAccept.commands.length} configured check(s) (re-run as the merge gate), plus maintained files and a post-mortem`
        : ' updating maintained files and recording a post-mortem';
      console.log(theme.separator(`Running pre-accept validation before merge —${gateNote}. This may take a while; the merge aborts if a check fails.`));
    }
  }

  // --- Delegate to daemon RPC ---
  // The daemon narrates the accept phase by phase over the heartbeat envelope;
  // the display below turns that into live terminal output. Without it accept
  // is silent for its entire (multi-minute) run — see src/cli/phase-display.ts.
  const display = createPhaseDisplay();
  try {
    let result;
    try {
      result = await queryAcceptTask({
        taskId,
        reason: reason.trim(),
        approvedFiles: approvedFiles.length > 0 ? approvedFiles : undefined,
      }, display.onProgress);
    } finally {
      display.close();
    }

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    if (result.status === 'merged') {
      if (result.prUrl) {
        console.log(theme.success(`\nTask ${result.displayId} accepted — merged via remote.`));
        console.log(`  ${theme.label('URL:')} ${result.prUrl}`);
      } else {
        console.log(theme.success(`\nTask ${result.displayId} accepted and merged.`));
      }

      await printProtectionHint(taskId);

      // Check for continuation task offer (revert tasks)
      await handleContinuationTaskOffer(taskId, result.displayId, yes);
    } else if (result.status === 'pending') {
      if (wait) {
        // Poll for CI checks and retry
        await handleWaitForMerge(taskId, result.displayId, reason, approvedFiles, yes);
      } else {
        console.log(`Task ${result.displayId} approved. Merge pending: ${result.reason}`);
        console.log('The reconciler will complete the merge when ready.');
        if (result.prUrl) {
          console.log(`  ${theme.label('URL:')} ${result.prUrl}`);
        }
        console.log(`Check status: ${theme.command('lazy show ' + result.displayId)}`);
        console.log(`Use ${theme.command('lazy accept ' + result.displayId + ' --wait')} to wait for checks.`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Handle conflict errors — offer to sync
    if (msg.includes('needs to merge upstream') || msg.includes('resolve conflicts')) {
      console.log(theme.warning(msg));
      console.log('');

      if (isTTY() && !yes) {
        const shouldSync = await promptYesNo('Sync with upstream?', true);
        if (shouldSync) {
          await commandSyncTask([taskId]);
          console.log(`\nRetry when ready: ${theme.command('lazy accept ' + taskId)}`);
          process.exit(0);
        } else {
          console.log(`\nRun: ${theme.command('lazy sync ' + taskId)}`);
          console.log(`Then retry: ${theme.command('lazy accept ' + taskId)}`);
          process.exit(1);
        }
      } else {
        console.log('Automatically syncing with upstream...');
        await commandSyncTask([taskId]);
        console.log(`\nRetry when ready: ${theme.command('lazy accept ' + taskId)}`);
        process.exit(0);
      }
    } else {
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  }
}

/**
 * Introduce branch protection after an accept that merged into the repo's
 * default branch — the one moment the feature is obviously relevant and
 * provably not in the way (the merge already happened).
 *
 * CLI-only on purpose: the equivalent MCP accept is run by a builder, which
 * cannot turn protection on anyway (`lazy protect` has no MCP form, for the
 * same reason it cannot run `lazy approve`).
 *
 * A tip must never be able to fail an accept that already succeeded, so a
 * failure here is logged with its context and swallowed — the user has their
 * merge, and losing an optional hint costs them nothing.
 */
async function printProtectionHint(taskId: string): Promise<void> {
  try {
    const root = requireLazyRoot();
    const [config, rawConfig] = await Promise.all([loadConfig(root), loadRawConfig(root)]);

    // Cheapest possible exit for the two states that need no storage access
    // at all: protection already on, or an explicit opinion recorded.
    const section = rawConfig?.protection as Record<string, unknown> | undefined;
    if (config.protection.enabled || (section && 'enabled' in section)) return;

    const storage = await requireStorage();
    let targetBranch: string | undefined;
    try {
      // Deliberately NOT resolveTaskOrExit: that exits the process, and a task
      // that has just been accepted must never die on the way to a tip.
      const match = await storage.resolveTask(taskId);
      if (!match.task) return;
      targetBranch = targetBranchOf(match.task);
    } finally {
      await storage.close();
    }

    const hint = await protectionHintForAccept({ config, rawConfig, projectRoot: root, targetBranch });
    if (hint) console.log(theme.separator(hint));
  } catch (err) {
    logger.debug(
      `Skipped the branch-protection hint after accepting ${taskId}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Handle --wait: poll CI checks and retry accept when they pass.
 * This is a CLI-only concern — the daemon doesn't do long-polling for CI.
 */
async function handleWaitForMerge(
  taskId: string,
  taskDisplayId: string,
  reason: string,
  approvedFiles: string[],
  yes: boolean,
): Promise<void> {
  console.log('Waiting for CI checks to complete...\n');

  const root = requireLazyRoot();
  const config = await loadConfig(root);
  const driver = createDriver(config);

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);
    const checksResult = await driver.waitForChecks(task);

    if (checksResult.passed) {
      console.log(theme.success('All checks passed! Retrying merge...\n'));
      await storage.close();

      // Retry accept via RPC — narrated like the first attempt.
      const retryDisplay = createPhaseDisplay();
      try {
        let retryResult;
        try {
          retryResult = await queryAcceptTask({
            taskId,
            reason: reason.trim(),
            approvedFiles: approvedFiles.length > 0 ? approvedFiles : undefined,
          }, retryDisplay.onProgress);
        } finally {
          retryDisplay.close();
        }

        for (const w of retryResult.warnings) {
          console.log(w);
        }

        if (retryResult.status === 'merged') {
          if (retryResult.prUrl) {
            console.log(theme.success(`\nTask ${retryResult.displayId} merged.`));
            console.log(`  ${theme.label('URL:')} ${retryResult.prUrl}`);
          } else {
            console.log(theme.success(`\nTask ${retryResult.displayId} merged.`));
          }
          await printProtectionHint(taskId);
        } else {
          console.log(`Task ${retryResult.displayId} approved. Merge still pending: ${retryResult.reason}`);
          console.log('The reconciler will complete the merge when ready.');
        }
      } catch (retryErr) {
        console.error(`Error: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
        console.error('Merge failed after checks passed. Resolve the issue, then run accept again.');
        process.exit(1);
      }
    } else {
      if (checksResult.timedOut) {
        console.log(theme.warning('Timed out waiting for CI checks to complete.'));
      } else {
        console.error(theme.error('CI checks failed:'));
        for (const check of checksResult.failed) {
          const urlSuffix = check.url ? ` (${check.url})` : '';
          console.error(`  - ${check.name}${urlSuffix}`);
        }
      }

      console.log(`\nTask ${taskDisplayId} approved. Merge pending — reconciler will complete it.`);
      process.exit(checksResult.timedOut ? 0 : 1);
    }
  } finally {
    try { await storage.close(); } catch { /* already closed */ }
  }
}

/**
 * Handle continuation task creation for revert tasks.
 * This is a CLI-only interactive concern.
 */
async function handleContinuationTaskOffer(
  taskId: string,
  taskDisplayId: string,
  yes: boolean,
): Promise<void> {
  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);
    const revertsTaskId = task.metadata?.reverts_task_id;
    if (!revertsTaskId) return;

    const root = requireLazyRoot();
    const config = await loadConfig(root);
    const { getCurrentSha } = await import('../../git/operations');

    const originalTask = await storage.getTask(revertsTaskId);
    const originalTaskCode = task.metadata?.original_task_code ?? (originalTask ? displayId(originalTask) : shortId(revertsTaskId));
    const revertReason = task.metadata?.revert_reason ?? '';
    const revertsMergeSha = task.metadata?.reverts_merge_sha ?? '';
    const revertSha = await getCurrentSha(root);
    const originalGoal = originalTask?.goal ?? 'Unknown goal';

    // Determine merge target for the continuation prompt
    const mergeTargetBranch = targetBranchOf(task) ?? 'main';

    console.log(`\nThe original task was: ${theme.taskId(originalTaskCode)}`);
    console.log(`  ${theme.label('Goal:')} ${originalGoal}`);

    let shouldCreateContinuation: boolean;
    if (yes) {
      shouldCreateContinuation = true;
    } else if (isTTY()) {
      shouldCreateContinuation = await promptYesNo('\nCreate a continuation task to redo the work?', true);
    } else {
      shouldCreateContinuation = true;
    }

    if (shouldCreateContinuation) {
      let continuationCode = `${originalTaskCode}-v2`;
      let version = 2;
      while (true) {
        const codeError = validateCode(continuationCode);
        if (codeError) {
          continuationCode = '';
          break;
        }
        const existing = await storage.resolveTask(continuationCode);
        if (!existing.task) break;
        version++;
        continuationCode = `${originalTaskCode}-v${version}`;
      }

      const continuationPrompt = [
        `You are continuing task ${originalTaskCode} (${shortId(revertsTaskId)}).`,
        ``,
        `It was accepted into ${mergeTargetBranch} as commit ${revertsMergeSha.substring(0, 7)} and later reverted as commit ${revertSha.substring(0, 7)}.`,
        ``,
        `The reason for reverting: ${revertReason}`,
        ``,
        `Run \`git revert ${revertSha} --no-edit\` to restore the original work, then fix the issue described above.`,
        ``,
        `Use \`lazy show ${originalTaskCode} --full\` to see the full conversation history from the original task.`,
      ].join('\n');

      // A continuation redoes the reverted task's work, so it runs on that
      // task's agent (falling back to the project default if it is unknown).
      const contTask = await storage.createTask(
        originalGoal,
        undefined,
        undefined,
        continuationCode || undefined,
        undefined,
        resolveAgentForNewTask({
          inheritFrom: originalTask,
          configDefault: (await loadConfig(requireLazyRoot())).agent.agent_id,
        }),
      );
      await storage.updateTaskPrompt(contTask.id, continuationPrompt);

      await storage.updateTaskMetadata(contTask.id, 'continues_task_id', revertsTaskId);
      await storage.updateTaskMetadata(contTask.id, 'revert_task_id', task.id);
      await storage.updateTaskMetadata(contTask.id, 'revert_sha', revertSha);

      const contDisplayId = displayId(contTask);
      console.log(`\nCreated continuation task: ${theme.taskId(contDisplayId)}`);
      console.log(`  Start when ready: ${theme.command(`lazy start ${contDisplayId}`)}`);
    }
  } finally {
    await storage.close();
  }
}

export function acceptUsage(): void {
  console.log(`Usage: lazy accept <task_id> [--reason "..."] [--yes] [--wait] [--approve-file <file>...]

Accept a task's work and merge it into the appropriate branch.

For root tasks (no parent): merges into the branch it was created from (or main)
For child tasks (created via branch): merges into parent's branch

Arguments:
  <task_id>    ID of the task to accept

Options:
  --reason "..."        Provide accept reason inline (default: "LGTM")
  --yes                 Skip interactive prompts (non-interactive mode)
  --wait                If merge fails due to pending CI checks, poll until checks
                        complete, then retry the merge. Timeout: 10 minutes.
  --approve-file <file> Approve a file (repeatable). Required when accepting a conflict
                        task — all violated files must be listed. Also required when the
                        merge would re-add a file the target branch deleted; accept
                        refuses and names the files until each one is approved.
                        All-or-nothing: a file left out makes accept REFUSE. Accept
                        never reverts anything — unlike 'lazy unblock --approve-file',
                        where a file left out is reverted to its base commit.

Reason input priority: --reason flag > piped stdin > interactive prompt > "LGTM"

Behavior:
  - Merges directly by default. If [automation.pre_accept] enabled = true is
    set, accept first runs the pre-accept validation turn BEFORE merging: a
    final agent turn that runs the configured commands, brings maintained files
    up to date (e.g. CHANGELOG), and records a post-mortem. The supervisor
    re-runs the commands as the merge gate — if any fails, the task returns to
    blocked and the accept is aborted (never a silent merge). This can take a
    while; the CLI waits for it.
  - Checks pre-merge gates (CI, reviews, unresolved comments) before merging.
    If any gates are failing, accept refuses to merge and prints a link to the
    PR/MR so the user can resolve the issues there.
  - Checks for merge conflicts BEFORE attempting the merge
  - If conflicts detected in interactive mode: prompts to sync with upstream
  - If conflicts detected in non-interactive mode: shows manual instructions
  - If no conflicts: merges and cleans up the worktree/branch
  - Allows uncommitted changes in the main repo; merge will fail naturally if conflicts occur
  - Accept reason is stored as a comment on the task
  - When a GitHub PR exists, the reason is posted as an approving PR review
  - With --wait: if the merge fails (e.g., required CI checks pending), polls
    check status every 10s for up to 10 minutes, then retries the merge

Conflict Resolution:
  Interactive mode (TTY available, no --yes flag):
    - Prompts: "Conflicts with main detected. Sync with upstream? [Y/n]"
    - If yes: fires off 'lazy sync <task>' (non-blocking), then exits
    - Review the merge result, then retry accept manually
    - If no: shows manual instructions

  Non-interactive mode (no TTY or --yes flag):
    - Automatically invokes 'lazy sync <task>' (non-blocking), then exits
    - Review the merge result, then retry accept manually

Examples:
  lazy accept abc12345                          # Accept with interactive prompt for reason
  lazy accept abc12345 --reason "LGTM"          # Accept with inline reason
  echo "Looks good" | lazy accept abc12345      # Piped stdin as reason
  lazy accept abc12345 --yes                    # Accept without prompts (uses "LGTM")
  lazy accept abc12345 --reason "Ship it" --yes # Accept with reason, no prompts
  lazy accept abc12345 --wait                   # Wait for CI checks before merging
  lazy accept abc12345 --approve-file a.ts --approve-file b.ts --yes  # Accept conflict task, approving violated files${docsFooter('protected-branches')}`);
}
