import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { requireActorIdentity } from '../identity-preflight';
import { shortId, displayId, validateCode } from '../../task/identity';
import { targetBranchOf } from '../../task-target';
import { isTTY, promptYesNo, promptLine, promptSecret, PromptCancelledError, readStdinIfPiped } from '../editor';
import { commandSyncTask } from './sync';
import { loadConfig, loadRawConfig } from '../../config/loader';
import { resolveAgentForNewTaskFromConfig } from '../../agent/task-agent';
import { protectionHintForAccept } from '../../protection/discovery';
import { logger } from '../../utils/logger';
import { createDriver } from '../../remote';
import { getActiveChildren } from '../../task/orphan';
import { queryAcceptTaskPreflight, queryAcceptTask } from '../../daemon/rpc-fallback';
import {
  collectRaisedResolutionsForAccept,
  RAISED_RESOLUTION_FLAGS,
} from '../raised-resolutions';
import type { RaisedItemResolution } from '../../types';

import { theme } from '../../render/theme';
import { createPhaseDisplay } from '../phase-display';
import { docsFooter, docsUrl } from '../../docs/links';
import { revertedProtectedFilesNotice } from '../../protection/reverted-files';

export async function commandAccept(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'yes', takesValue: false },
    { name: 'reason', takesValue: true },
    { name: 'wait', takesValue: false },
    { name: 'approve-file', takesValue: true, accumulate: true },
    ...RAISED_RESOLUTION_FLAGS,
    { name: 'allow-broken', takesValue: false },
    { name: 'allow-review-issues', takesValue: false },
    { name: 'allow-queued-comments', takesValue: false },
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
  // Named, explicit, and only ever supplied by a human at this surface: the
  // accept check refuses a task that does not build, and this is the way to
  // say "I know, merge it anyway". There is no config key that disables the
  // refusal — an override people can set once and forget is not an override.
  const allowBroken = parsed.flags.get('allow-broken') === true;
  // The other named override, and the only route past a review that left
  // issues outstanding or failed to parse. Findings are fix feedback, not
  // rows a human can dismiss one by one, so without this a reviewer facing a
  // broken review would have to spend another agent turn to accept work they
  // have already read. CLI-only, like every override that is a human's
  // judgement standing in for a check.
  const allowReviewIssues = parsed.flags.get('allow-review-issues') === true;
  // Accept refuses while comments a human queued have not reached the agent;
  // this is "I know, merge without them".
  const allowQueuedComments = parsed.flags.get('allow-queued-comments') === true;

  // Before the accept reason and, on a protected merge, the approval passphrase is typed: the daemon refuses a write it cannot
  // attribute, and a refusal must never cost the human what they wrote.
  await requireActorIdentity();

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

  // Heads-up about the mechanical acceptance gate. The gate is OPT-IN
  // ([automation.pre_accept] enabled = true with commands configured); when it
  // is on, accept runs the configured checks in their own container BEFORE the
  // merge and the CLI blocks on it — so tell the user why this may take a while
  // rather than letting them stare at a silent prompt. When the gate is off or
  // has no commands (an empty list launches nothing at all), accept says
  // nothing extra and merges straight away.
  {
    const config = await loadConfig(root);
    const preAccept = config.automation.pre_accept;
    if (preAccept.enabled && preAccept.commands.length > 0) {
      const gateNote = ` running ${preAccept.commands.length} configured check(s) as the merge gate`;
      console.log(theme.separator(`Running pre-accept validation before merge —${gateNote}. This may take a while; the merge aborts if a check fails.`));
    }
  }

  // --- Raised items: collect resolutions BEFORE passphrase / accept ---
  // Same spirit as protected-file walk-through and the passphrase gate:
  // every failable / frictional check runs before the human types the
  // passphrase. Flags supply a complete set; a TTY with no flags walks each
  // open item; non-interactive without flags refuses with a pasteable command.
  //
  // INVARIANT: --yes does NOT skip raised-item resolution. Unlike ordinary
  // confirmations, this friction cannot be automated away with --yes — the
  // caller must supply --respond-raised / --promote-raised-subtask /
  // --promote-raised-peer / --dismiss-raised
  // or walk the items on a TTY.
  let raisedResolutions: RaisedItemResolution[] | undefined;
  {
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      const openItems = await storage.getTaskRaisedItems(task.id);
      raisedResolutions = await collectRaisedResolutionsForAccept({
        flags: parsed.flags,
        openItems,
        displayId: displayId(task),
      });
    } finally {
      await storage.close();
    }
  }

  // --- Branch protection: collect the passphrase BEFORE delegating ---
  // The gate facts come from the daemon's pre-flight (enrollment probed
  // daemon-side — a CLI-side check from a task worktree resolves the wrong
  // root), so every failable check runs before the human types anything
  // (CLAUDE.md). The prompt is TTY-only BY DESIGN: there is no flag, env var,
  // or stdin route for the passphrase — a non-interactive value would sit in
  // shell history and agent transcripts, which is the one property the
  // mechanism must keep (the token originates outside the builder's context).
  //
  // INVARIANT: --yes skips prompts, not the gate. The passphrase branch below
  // never consults `yes`, and the daemon has no parameter that means "skip the
  // gate" — a --yes accept of a protected merge prompts like any other, or
  // refuses without a TTY.
  let token: string | undefined;
  /** Warnings this surface already printed before the merge, verbatim. */
  const printedWarnings = new Set<string>();
  /** The reverted-files notice this surface already printed, if any. */
  let printedRevertedNotice: string | undefined;
  try {
    const preflight = await queryAcceptTaskPreflight({
      taskId,
      approvedFiles: approvedFiles.length > 0 ? approvedFiles : undefined,
      raisedResolutions,
      // The gate must see the override BEFORE the run: the review gate is a
      // preflight refusal, so a flag that stands it down has to reach the
      // preflight or the accept is refused before the run begins.
      allowReviewIssues: allowReviewIssues || undefined,
      allowQueuedComments: allowQueuedComments || undefined,
    });
    const gate = preflight.gate;

    // Preflight is not read-only: approving `--approve-file` violations happens
    // HERE, and its warning ("Approved N protected file change(s)") is only ever
    // on this result — the run's own preflight sees them already approved and
    // says nothing. Printing it later would also be too late: what the reviewer
    // needs to know about protected files belongs before the merge, not after.
    for (const w of preflight.warnings) {
      console.log(theme.warning(w));
      printedWarnings.add(w);
    }

    if (gate.pendingReview) {
      const r = gate.pendingReview;
      const staleLabel =
        r.staleBy === null
          ? ' — recorded against an earlier state of the branch'
          : r.staleBy > 0
            ? ` — recorded before ${r.staleBy} later commit(s)`
            : '';
      console.log(theme.separator(`\nReview by ${r.actor} (recorded ${r.recordedAt}${staleLabel}):`));
      console.log(r.text);
      console.log('');
    }

    // Say it BEFORE the merge, while the decision is still open. A reverted
    // protected file is absent from the diff, which reads exactly like "the
    // task never touched it" — the reviewer has to be told, not left to infer.
    if (preflight.revertedProtectedFiles.length > 0) {
      printedRevertedNotice = revertedProtectedFilesNotice(preflight.revertedProtectedFiles);
      console.log(theme.warning(`\n${printedRevertedNotice}`));
      console.log('');
    }

    if (gate.gated && !gate.satisfiedByForge) {
      console.log(theme.warning(`This merge is protected: ${gate.reason}`));

      if (gate.enrollment === 'not-enrolled') {
        console.error(`Error: ${gate.enrollmentMessage}`);
        process.exit(1);
      }
      if (!isTTY()) {
        console.error(
          `Error: accepting a protected merge needs the approval passphrase, which is only ` +
          `ever typed at an interactive prompt — there is deliberately no flag, env var, or ` +
          `stdin route for it. Run \`lazy accept ${preflight.displayId}\` from a terminal, ` +
          `or approve the task's PR/MR on the forge.`,
        );
        process.exit(1);
      }

      const promptLabel = gate.sourceLabel
        ? `Approval passphrase (from ${gate.sourceLabel})`
        : 'Approval passphrase';
      // Masked on purpose — the passphrase must never reach the screen or
      // scrollback. promptSecret refuses outright when it cannot mask.
      try {
        // Sent RAW — the store is the one place that normalizes a passphrase,
        // so nothing here may trim it. The emptiness check below trims only to
        // decide whether the human just pressed Enter.
        token = await promptSecret(promptLabel);
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          console.error('Accept cancelled.');
          process.exit(1);
        }
        // Never assert a cause we did not verify: only the not-a-TTY failure
        // gets the "run it from a terminal" advice. Anything else (a raw-mode
        // failure, a closed stdin mid-read) is reported as what it was.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not an interactive terminal')) {
          console.error(
            'Error: cannot read the approval passphrase without echoing it: stdin is not an ' +
            'interactive terminal. Run `lazy accept` from a terminal, or approve the task\'s ' +
            'PR/MR on the forge.',
          );
        } else {
          console.error(`Error: could not read the approval passphrase: ${message}`);
        }
        process.exit(1);
      }
      if (!token.trim()) {
        console.error('Error: an approval passphrase is required to accept a protected merge.');
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
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
        token,
        approvedFiles: approvedFiles.length > 0 ? approvedFiles : undefined,
        raisedResolutions,
        allowBroken: allowBroken || undefined,
        allowReviewIssues: allowReviewIssues || undefined,
        allowQueuedComments: allowQueuedComments || undefined,
      }, display);
    } finally {
      display.close();
    }

    // Print warnings. The daemon repeats the reverted-files notice here for
    // surfaces whose ONLY channel is result.warnings (MCP, the review page);
    // this surface already printed it before the merge, so printing it again
    // would be the same message twice in one command's output.
    for (const w of result.warnings) {
      if (printedRevertedNotice && w === printedRevertedNotice) continue;
      if (printedWarnings.has(w)) continue;
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

      // The task IS accepted (the merge is the commit point), but a step after
      // it failed — e.g. the parent push. That is a failure, not a warning:
      // say so and exit non-zero. The daemon keeps retrying it.
      if (result.followThroughPending) {
        console.error(theme.error(
          `\nFinishing the accept FAILED at ${result.followThroughPending.error}. ` +
          `Still pending: ${result.followThroughPending.steps.join(', ')} — the daemon retries automatically.`,
        ));
        process.exit(1);
      }
    } else if (result.status === 'pending') {
      if (wait) {
        // Poll for CI checks and retry
        await handleWaitForMerge(taskId, result.displayId, reason, approvedFiles, raisedResolutions, yes);
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
 * cannot turn protection on anyway (`lazy protect` has no MCP form — arranging
 * gates is a human act).
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
  raisedResolutions: RaisedItemResolution[] | undefined,
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
            // Items were already resolved on the first accept; re-passing is a
            // no-op when nothing is open (see validateRaisedResolutions).
            raisedResolutions,
          }, retryDisplay);
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
      const [config, projectSettings] = await Promise.all([
        loadConfig(requireLazyRoot()),
        storage.getProjectSettings(),
      ]);
      const contTask = await storage.createTask(
        originalGoal,
        undefined,
        undefined,
        continuationCode || undefined,
        undefined,
        resolveAgentForNewTaskFromConfig(
          { inheritFrom: originalTask },
          config.agent,
          projectSettings,
        ).agentId,
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
                        [--respond-raised <id>=<text>...] [--promote-raised-subtask <id>...]
                        [--promote-raised-peer <id>...] [--dismiss-raised <id>=<reason>...]
                        [--acknowledge-raised <id>...]

Accept a task's work and merge it into the appropriate branch.

For root tasks (no parent): merges into the branch it was created from (or main)
For child tasks (created via branch): merges into parent's branch

Arguments:
  <task_id>    ID of the task to accept

Options:
  --reason "..."        Provide accept reason inline (default: "LGTM")
  --yes                 Skip interactive prompts (non-interactive mode). Does NOT
                        skip raised-item resolution or the protection passphrase.
  --wait                If merge fails due to pending CI checks, poll until checks
                        complete, then retry the merge. Timeout: 10 minutes.
  --approve-file <file> Approve a file (repeatable). Required when accepting a conflict
                        task — all violated files must be listed. Also required when the
                        merge would re-add a file the target branch deleted; accept
                        refuses and names the files until each one is approved.
                        All-or-nothing: a file left out makes accept REFUSE. Accept
                        never reverts anything.
  --respond-raised <id>=<text>
                        Respond to the agent on an open raised item (repeatable).
                        Schedules a comment quoting the item; delivered on this
                        accept (or the next unblock). Required (with promote/dismiss)
                        for every open item — all-or-nothing, like --approve-file.
  --promote-raised-subtask <id>
                        Create a child task under this one for the item on accept
                        (repeatable; optional =<note>). Re-parented onto the accept
                        target with the task's other children.
  --promote-raised-peer <id>
                        Create a sibling task for the item on accept (repeatable;
                        optional =<note>). Lazy creates either promoted task
                        itself, and the agent is told so it stops re-raising.
  --dismiss-raised <id>=<reason>
                        Dismiss an open raised item with a reason (repeatable).
  --acknowledge-raised <id>
                        Acknowledge an open raised item — "seen, maybe later"
                        (repeatable; optional =<note>). Same act as dismiss with
                        a different valence, and it clears the accept gate the
                        same way, so it counts toward the all-or-nothing set.
  --allow-broken        Merge even though the accept check failed. The failure is
                        still reported as a warning — this suppresses the refusal,
                        never the fact.
  --allow-review-issues Merge even though the latest review left issues
                        outstanding or failed outright. Review findings are fix
                        feedback, not items you can dismiss one at a time, so
                        this is how a human who has read the work says "I have
                        decided" instead of paying for another agent turn. There
                        is no MCP equivalent — an agent may not overrule a
                        review for you.
  --allow-queued-comments
                        Merge even though comments a person queued for the
                        agent (lazy comment, web review comments) have not
                        been delivered. Without it accept refuses, because merging
                        ends the task with that feedback never read.

Reason input priority: --reason flag > piped stdin > interactive prompt > "LGTM"

Behavior:
  - Merges directly by default. If [automation.pre_accept] enabled = true is
    set, accept first runs the configured commands as the MECHANICAL acceptance
    gate in an ephemeral container on the task's worktree BEFORE merging — no
    agent turn runs. If any command fails, the task returns to blocked and the
    accept is aborted (never a silent merge). This can take a while; the CLI
    waits for it.
  - Runs the accept check before merging, when [automation] accept_check is set:
    the project's own command (e.g. "bun run typecheck") is run in the TASK's
    worktree, and a non-zero exit REFUSES the accept — a task that does not
    build would break the branch it is merged into. Unset means no gate, and
    accept says the step was skipped rather than guessing a command. Override a
    refusal knowingly with --allow-broken.
  - Names any protected files that were REVERTED during the task. A reverted
    file is absent from the diff, which reads identically to "the task never
    touched it" — so accept says it outright before the merge.
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

Protected merges ([protection] in lazy.toml):
  - Accepting a protected merge prompts for the approval passphrase and merges
    in the same invocation — the approval is bound to the exact commits merged.
  - The prompt is TTY-only. There is deliberately no flag, env var, or stdin
    route for the passphrase, and --yes skips other prompts but NEVER this one.
  - A human approval on the task's PR/MR satisfies the same gate — then no
    passphrase is asked.
  - The passphrase is enrolled once per MACHINE, hashed and outside every
    repository: 'lazy system passphrase set'. With nothing enrolled here, a
    protected merge refuses with that instruction rather than prompting.
  - A review recorded by the builder's refused accept is shown before the
    prompt and attached to the merge (task comment and PR/MR review).

Raised items (agent questions/decisions that gate accept):
  - Accept refuses while any raised item is open. Every open item must be
    responded to, promoted (subtask or peer), or dismissed — all-or-nothing.
  - Interactive TTY with no flags: walks each open item (content + options)
    and prompts respond / promote-subtask / promote-peer / dismiss. --yes does
    NOT skip this walk.
  - Non-interactive without flags: refuses with a pasteable command naming
    --respond-raised for each open id.
  - Comments stay pending until accept/unblock writes them; change the
    resolution on the review page before then to undo.
  - See also: lazy show (lists raised items), lazy followup (triage follow-ups —
    those do NOT gate accept).

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
  lazy accept abc12345 --approve-file a.ts --approve-file b.ts --yes  # Accept conflict task, approving violated files
  lazy accept abc12345 --respond-raised a1b2c3d4="use option 2" --dismiss-raised e5f6a7b8="not in scope" --yes
  lazy accept abc12345 --promote-raised-subtask a1b2c3d4 --promote-raised-peer e5f6a7b8 --yes${docsFooter('raised-items')}`);
}
