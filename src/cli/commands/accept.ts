import { join } from 'path';
import { existsSync } from 'fs';
import type { Task } from '../../types';
import { isActiveStatus, isBlockedStatus } from '../../types';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, validateCode, rejectIfPairing, taskRef, getWorktreePath, getBranchNameFromId } from '../helpers';
import { hasUncommittedChanges, getCurrentSha, resolveDetachedHead } from '../../git/operations';
import { validateBranchInSyncWithRemote } from '../../utils/git';
import { removeLock } from '../../utils/lock';
import { cleanupWorktreeAndBranch, cleanupTaskContainer } from './shared';
import { protocolDir, removeProtocolDir } from '../../protocol';
import { isTTY, promptYesNo, promptLine, readStdinIfPiped } from '../editor';
import { commandUnblock } from './unblock';
import { loadConfig } from '../../config/loader';
import { createDriver } from '../../remote';
import { getActiveChildren, reparentChildren } from '../orphan';
import type { Storage } from '../../storage/interface';

import { getDataDir } from '../init';
import { theme } from '../theme';
import { getActor } from '../../constants';

/**
 * Re-parent non-terminal children of the accepted task and log the result.
 */
async function reparentAndLog(task: Task, storage: Storage): Promise<void> {
  const reparented = await reparentChildren(task, storage);
  if (reparented.length > 0) {
    const newParentDesc = task.parent_task_id
      ? task.parent_task_id.substring(0, 8)
      : 'top-level';
    const plural = reparented.length === 1 ? 'child' : 'children';
    console.log(`Re-parented ${reparented.length} unfinished ${plural} of ${displayId(task)} to ${newParentDesc}.`);
    for (const child of reparented) {
      console.log(`  ${displayId(child)} [${child.status}] ${child.goal}`);
    }
  }
}

/**
 * Fire off sync-with-upstream (merge upstream + resolve conflicts) without blocking.
 * The agent will merge in the background. The human should review the result
 * before retrying accept (the agent may have taken the wrong side of a conflict).
 */
async function runSyncWithUpstream(taskId: string): Promise<void> {
  // Run unblock with --sync-with-upstream (no --follow — returns immediately).
  // Pass --message to avoid readStdinIfPiped() hanging when accept is run as
  // a subprocess with piped stdin. The message is descriptive so turn history
  // shows what triggered the sync (not human-initiated feedback).
  const unblockArgs = [taskId, '--sync-with-upstream', '--message', 'Automatic sync-with-upstream triggered by accept conflict'];
  await commandUnblock(unblockArgs);
}

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
  const config = loadConfig(root);
  let storage = await requireStorage();
  const driver = createDriver(config, { storage, lazyRoot: root });
  let storageClosed = false;

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Get worktree path
    const worktreePath = getWorktreePath(root, task);

    // CRITICAL: Check for uncommitted changes in worktree FIRST
    // This is the hardest gate — losing uncommitted work is the worst outcome.
    // Must happen before ANY destructive or remote operations.
    if (existsSync(worktreePath) && hasUncommittedChanges(worktreePath)) {
      console.error('Error: Task has uncommitted changes!');
      console.error('Commit or stash your changes before accepting.');
      console.error('Options:');
      console.error(`  1. Unblock and ask agent to commit: lazy unblock ${displayId(task)} --message "Please commit your changes"`);
      console.error(`  2. Manually commit in shell: lazy shell ${displayId(task)}`);
      process.exit(1);
    }

    // Get session
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
      process.exit(1);
    }

    if (sess.outcome === 'accepted') {
      console.log(`Task ${displayId(task)} was already accepted.`);
      return;
    }
    if (sess.ended_at) {
      console.error(`Session already ended (${sess.outcome ?? 'ended'}).`);
      process.exit(1);
    }

    // Refuse if task is in pairing state — task is locked
    if (task.status === 'pairing') {
      console.error(`Task ${displayId(task)} is locked (pairing in progress). End the pairing session first.`);
      process.exit(1);
    }

    // Only blocked tasks can be accepted (must review before accepting)
    if (!isBlockedStatus(task.status) && task.status !== 'merging') {
      if (task.status === 'interrupted') {
        console.error(`Task ${displayId(task)} is interrupted. Resume it first: lazy resume ${displayId(task)}`);
      } else if (task.status === 'working') {
        console.error(`Task ${displayId(task)} is still working. Wait for it to finish.`);
      } else {
        console.error(`Task ${displayId(task)} is in state '${task.status}' and cannot be accepted.`);
      }
      process.exit(1);
    }

    // INVARIANT: Tasks with unresolved file permission violations cannot be accepted
    // unless ALL pending violations are covered by --approve-file flags.
    // This prevents protected file changes from being merged without explicit human review.
    const turns = await storage.getSessionTurns(sess.id);
    const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
    if (lastAgentTurn?.violations?.some(v => v.status === 'pending')) {
      const pendingFiles = lastAgentTurn.violations
        .filter(v => v.status === 'pending')
        .map(v => v.file);

      if (approvedFiles.length === 0) {
        // No --approve-file flags → refuse
        console.error(`Task ${displayId(task)} has unresolved file permission violations:`);
        for (const f of pendingFiles) {
          console.error(`  - ${f}`);
        }
        console.error(`\nResolve violations by accepting with --approve-file to approve all files,`);
        console.error(`or unblock without --approve-file to reject all (revert to original).`);
        console.error(`Example: ${theme.command('lazy accept ' + displayId(task) + ' --approve-file file1 --approve-file file2 --yes')}`);
        process.exit(1);
      }

      // Check that --approve-file covers ALL pending violations
      const approvedSet = new Set(approvedFiles);
      const missingFiles = pendingFiles.filter(f => !approvedSet.has(f));

      if (missingFiles.length > 0) {
        console.error(`Missing approval for ${missingFiles.length} violated file(s):`);
        for (const f of missingFiles) {
          console.error(`  - ${f}`);
        }
        console.error(`\nAll violated files must be approved to accept. Add the missing --approve-file flags.`);
        process.exit(1);
      }

      // All pending violations covered — mark them as approved
      const updatedViolations: import('../../types').FileViolation[] = lastAgentTurn.violations.map(v => ({
        ...v,
        status: v.status === 'pending' ? 'approved' as const : v.status,
      }));
      await storage.updateTurnViolations(task.id, lastAgentTurn.id, updatedViolations);
      console.log(`Approved ${pendingFiles.length} protected file change(s): ${pendingFiles.join(', ')}`);
    }

    // Check for pairing lock — refuse if someone is pairing on this task
    rejectIfPairing(root, taskRef(task), displayId(task));

    // Handle tasks already in 'merging' status — check if merge completed
    if (task.status === 'merging') {
      console.log(`Task ${displayId(task)} is already in merging state.`);

      // Check if the merge completed in the meantime
      const prState = await driver.getPRState(task);

      if (prState === 'MERGED') {
        console.log('Merge completed! Finishing up...');

        // Determine merge target for fast-forward
        // resolveDetachedHead guards against "HEAD" stored in metadata by old code
        const mergeTargetBranch = resolveDetachedHead(task.metadata?.remote_target_branch ?? 'main', root, config.remote.git_remote);

        const ffResult = await driver.fastForwardLocal(mergeTargetBranch, root);
        if (!ffResult.success) {
          console.error(`Error: ${ffResult.warning || 'Failed to fast-forward local branch'}`);
          console.error(`The remote merge succeeded, but the local ${mergeTargetBranch} branch could not be updated.`);
          console.error(`Fix the local branch state (likely: run 'git pull' in the main repo), then retry accept.`);
          process.exit(1);
        }
        if (ffResult.warning) {
          console.error(`Warning: ${ffResult.warning}`);
        }

        // End session and mark complete
        await storage.endSession(sess.id, 'accepted');
        await storage.updateTaskStatus(task.id, 'complete', getActor());

        // Re-parent unfinished children to the grandparent
        await reparentAndLog(task, storage);

        // Clean up resources
        await cleanupTaskContainer(storage, sess, taskRef(task), root);
        removeLock(worktreePath);
        cleanupWorktreeAndBranch(worktreePath, sess.git_branch, root);
        removeProtocolDir(protocolDir(task.id));

        const remoteUrl = await driver.getTaskUrl(task);
        if (remoteUrl) {
          console.log(theme.success(`\nTask ${displayId(task)} merged.`));
          console.log(`  ${theme.label('URL:')} ${remoteUrl}`);
        } else {
          console.log(theme.success(`\nTask ${displayId(task)} merged.`));
        }
        return;
      }

      if (prState === 'CLOSED') {
        console.log('The merge request was closed externally.');
        console.log(`Use ${theme.command('lazy close ' + displayId(task))} to close the task,`);
        console.log(`or reopen the MR/PR and re-run ${theme.command('lazy accept ' + displayId(task))}.`);
        process.exit(1);
      }

      // Still open — check if pipeline/checks have failed
      const checksStatus = await driver.getChecksStatus(task);

      if (checksStatus.status === 'failed') {
        // Pipeline failed — move task back to blocked so it can be fixed and re-accepted
        const failedDetails = checksStatus.failed
          .map(f => f.url ? `${f.name} (${f.url})` : f.name)
          .join(', ');
        console.log(theme.warning(`Pipeline/checks failed: ${failedDetails}`));

        await storage.updateTaskStatus(task.id, 'blocked', getActor());
        await storage.createComment(task.id, `Pipeline/checks failed: ${failedDetails}. Task moved back to blocked.`, getActor());

        console.log(`Task ${displayId(task)} moved back to ${theme.status('blocked')}.`);
        console.log(`Fix the issue, then re-accept: ${theme.command('lazy accept ' + displayId(task))}`);
        console.log(`Or give feedback: ${theme.command('lazy unblock ' + displayId(task))}`);
        return;
      }

      if (checksStatus.status === 'pending' && wait) {
        // --wait on an already-merging task: poll until checks complete, then retry merge
        console.log('Checks still running. Waiting for CI checks to complete...\n');

        const checksResult = await driver.waitForChecks(task);

        if (checksResult.passed) {
          console.log(theme.success('All checks passed! Retrying merge...\n'));

          const mergeTargetBranch = resolveDetachedHead(task.metadata?.remote_target_branch ?? 'main', root, config.remote.git_remote);
          const retryResult = await driver.merge({
            sourceBranch: sess.git_branch,
            targetBranch: mergeTargetBranch,
            task,
            taskShortId: taskRef(task),
            root,
          });

          if (retryResult.metadata) {
            for (const [key, value] of Object.entries(retryResult.metadata)) {
              await storage.updateTaskMetadata(task.id, key, value);
            }
            if (!task.metadata) task.metadata = {};
            Object.assign(task.metadata, retryResult.metadata);
          }

          if (retryResult.status === 'merged') {
            const ffResult = await driver.fastForwardLocal(mergeTargetBranch, root);
            if (!ffResult.success) {
              console.error(`Error: ${ffResult.warning || 'Failed to fast-forward local branch'}`);
              console.error(`The remote merge succeeded, but the local ${mergeTargetBranch} branch could not be updated.`);
              console.error(`Fix the local branch state (likely: run 'git pull' in the main repo), then retry accept.`);
              process.exit(1);
            }
            if (ffResult.warning) {
              console.error(`Warning: ${ffResult.warning}`);
            }

            await storage.endSession(sess.id, 'accepted');
            await storage.updateTaskStatus(task.id, 'complete', getActor());

            // Re-parent unfinished children to the grandparent
            await reparentAndLog(task, storage);

            await cleanupTaskContainer(storage, sess, taskRef(task), root);
            removeLock(worktreePath);
            cleanupWorktreeAndBranch(worktreePath, sess.git_branch, root);
            removeProtocolDir(protocolDir(task.id));

            const remoteUrl = await driver.getTaskUrl(task);
            if (remoteUrl) {
              console.log(theme.success(`\nTask ${displayId(task)} merged.`));
              console.log(`  ${theme.label('URL:')} ${remoteUrl}`);
            } else {
              console.log(theme.success(`\nTask ${displayId(task)} merged.`));
            }
            return;
          }

          if (retryResult.status === 'pending') {
            console.log(`Merge still pending: ${retryResult.reason}`);
            console.log('The reconciler will complete the merge when ready.');
            return;
          }

          // Failed
          console.error(theme.error(retryResult.error));
          console.error('Merge failed after checks passed. Resolve the issue, then run accept again.');
          process.exit(1);
        } else {
          // Checks failed
          console.error(theme.error('CI checks failed:'));
          for (const check of checksResult.failed) {
            const urlSuffix = check.url ? ` (${check.url})` : '';
            console.error(`  - ${check.name}${urlSuffix}`);
          }

          await storage.updateTaskStatus(task.id, 'blocked', getActor());
          await storage.createComment(task.id, 'CI checks failed. Task moved back to blocked.', getActor());

          console.log(`\nTask ${displayId(task)} moved back to ${theme.status('blocked')}.`);
          console.log(`Fix the issue, then re-accept: ${theme.command('lazy accept ' + displayId(task))}`);
          process.exit(1);
        }
      }

      // Still pending or passed (pending = checks still running, passed = odd state)
      const remoteUrl = await driver.getTaskUrl(task);
      console.log('Merge is still pending.');
      if (remoteUrl) {
        console.log(`  ${theme.label('URL:')} ${remoteUrl}`);
      }
      console.log(`\nUse ${theme.command('lazy accept ' + displayId(task) + ' --wait')} to wait for checks.`);
      return;
    }

    // Get accept reason from --reason, piped stdin, or interactive prompt
    let reason: string;
    if (reasonFromFlag !== undefined) {
      reason = reasonFromFlag;
    } else {
      // Try piped stdin before falling back to interactive prompt
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        reason = stdinContent;
      } else if (yes) {
        // --yes skips the prompt and uses "LGTM" as default
        reason = 'LGTM';
      } else if (isTTY()) {
        // Interactive: prompt for a reason with "LGTM" as default
        reason = await promptLine('Accept reason', 'LGTM');
      } else {
        // Non-interactive with no reason provided — use default
        reason = 'LGTM';
      }
    }
    if (!reason.trim()) {
      reason = 'LGTM';
    }

    // If the driver requires a remote ref (e.g., GitHub PR) and none exists yet,
    // automatically push the branch and create a PR instead of failing.
    const acceptError = driver.validateAccept(task);
    if (acceptError) {
      console.log(`No remote reference found — pushing branch and creating PR...`);
      try {
        await driver.pushBranch(sess.git_branch);
        const prResult = await driver.markReadyForReview(task);
        if (prResult.metadata) {
          for (const [key, value] of Object.entries(prResult.metadata)) {
            await storage.updateTaskMetadata(task.id, key, value);
          }
          // Update in-memory metadata so the driver can use it for the merge
          if (!task.metadata) task.metadata = {};
          Object.assign(task.metadata, prResult.metadata);
          const url = await driver.getTaskUrl(task);
          if (url) {
            console.log(`  Created PR: ${url}`);
          }
        }
        // Re-validate after auto-sync
        const retryError = driver.validateAccept(task);
        if (retryError) {
          console.error(`Failed to create remote reference. Try running: ${theme.command('lazy sync')}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to push branch and create PR: ${err instanceof Error ? err.message : err}`);
        console.error(`Try running: ${theme.command('lazy sync')}`);
        process.exit(1);
      }
    }

    // Note: We intentionally allow uncommitted changes in the root repo.
    // The merge will fail naturally if there are actual conflicts with dirty files.

    // Refuse accept when there are zero agent commits — nothing to merge
    const commits = await storage.getSessionCommits(sess.id);
    if (commits.length === 0) {
      console.error(`Task ${displayId(task)} has no commits. Nothing to merge.`);
      console.error(`Use ${theme.command('lazy close ' + displayId(task))} to close the task instead.`);
      process.exit(1);
    }

    // Determine merge target based on task tree structure
    let mergeTargetBranch: string;
    const isChildTask = !!task.parent_task_id;
    let parentTask: Task | null = null;

    if (task.parent_task_id) {
      // Child task: merge into parent's branch
      parentTask = await storage.getTask(task.parent_task_id);
      if (!parentTask) {
        console.error(`Parent task ${task.parent_task_id} not found`);
        process.exit(1);
      }

      // Refuse to merge into a parent that has an active worktree.
      // - working: agent is mid-turn, a squash merge commit would corrupt its state
      // - pairing: human is interactively working, a surprise commit would appear
      // - interrupted: agent will resume and find unexpected changes
      // - merging: PR/MR is in flight, local state is uncertain
      // The only safe time to merge is when the parent is blocked.
      if (isActiveStatus(parentTask.status)) {
        console.error(`Error: Parent task ${displayId(parentTask)} is currently ${parentTask.status}.`);
        console.error('Merging into an active worktree would surprise the agent or human working there.');
        if (parentTask.status === 'interrupted') {
          console.error(`Either wait for the parent to resume, or resume it manually: ${theme.command('lazy resume ' + displayId(parentTask))}`);
        } else {
          console.error('Wait for the parent task to become blocked, then retry accept.');
        }
        process.exit(1);
      }

      mergeTargetBranch = await getBranchNameFromId(task.parent_task_id, storage);
    } else {
      // Root task: merge into the branch it was created from
      // resolveDetachedHead guards against "HEAD" stored in metadata by old code
      mergeTargetBranch = resolveDetachedHead(task.metadata?.remote_target_branch ?? 'main', root, config.remote.git_remote);
    }

    // Log merge intent
    if (isChildTask) {
      console.log(`Merging child task ${theme.taskId(displayId(task))} into parent ${theme.taskId(displayId(parentTask!))}...`);
    } else {
      console.log(`Merging root task ${theme.taskId(displayId(task))} into ${mergeTargetBranch}...`);
    }

    // Warn about active children that will need rebasing after this accept.
    // This does NOT block the accept — children get handled when they're next interacted with.
    const activeChildren = await getActiveChildren(task.id, storage);
    if (activeChildren.length > 0) {
      const plural = activeChildren.length === 1 ? 'child' : 'children';
      console.log(theme.warning(`\nNote: This task has ${activeChildren.length} active ${plural} that will need rebasing after accept.`));
      for (const child of activeChildren) {
        console.log(`  ${theme.taskId(displayId(child))} [${theme.status(child.status)}] ${child.goal}`);
      }
      console.log('');
    }

    // Pre-flight: for root tasks with a remote driver, validate that local
    // target branch is in sync with all remotes before attempting the merge.
    // Once a remote merge happens we can't undo it — failing early prevents
    // a half-accepted state where the remote merge succeeded but local
    // fast-forward fails due to divergence.
    if (!isChildTask && driver.needsSync) {
      const syncCheck = validateBranchInSyncWithRemote(mergeTargetBranch, config.remote.git_remote, root);
      if (!syncCheck.inSync) {
        console.error(`Error: ${syncCheck.error}`);
        console.error('Fix this before accepting to avoid a half-merged state.');
        process.exit(1);
      }
    }

    // INVARIANT: Push parent branch's local commits to remote before remote merge.
    // If the parent has local-only commits, the remote merge will create a state
    // where the remote parent has the merge commit but not the local-only commits,
    // causing the local branch to diverge from remote.
    if (driver.needsSync) {
      try {
        await driver.pushBranch(mergeTargetBranch);
      } catch (err) {
        console.error(`Error: Failed to push ${mergeTargetBranch} to remote: ${err instanceof Error ? err.message : err}`);
        console.error('The parent branch has local commits that must be pushed before merging.');
        console.error(`Fix: run \`git push\` for ${mergeTargetBranch}, then retry accept.`);
        process.exit(1);
      }
    }

    // Use the driver to perform the merge (conflict check + merge attempt)
    let result = await driver.merge({
      sourceBranch: sess.git_branch,
      targetBranch: mergeTargetBranch,
      task,
      taskShortId: taskRef(task),
      root,
    });

    // INVARIANT: Always persist metadata from the driver immediately — even on failure.
    // When merge() creates a replacement MR/PR (because the original was stale/closed),
    // the new MR/PR reference must be saved before anything else can fail and lose it.
    // Without this, the task keeps pointing to the stale MR forever, causing cascading
    // failures: external-close checks see the stale MR → close the task, subsequent
    // accepts try the stale MR → get conflicts again.
    if (result.metadata) {
      for (const [key, value] of Object.entries(result.metadata)) {
        await storage.updateTaskMetadata(task.id, key, value);
      }
      // Update in-memory metadata so subsequent operations see the new values
      if (!task.metadata) task.metadata = {};
      Object.assign(task.metadata, result.metadata);
    }

    if (result.status === 'failed') {
      if (result.isConflict) {
        console.log(theme.warning(result.error));
        console.log('The agent needs to merge upstream and resolve conflicts first.\n');

        // In interactive mode (TTY + no --yes flag), offer to sync with upstream
        if (isTTY() && !yes) {
          const promptMsg = isChildTask
            ? 'Conflicts with parent detected. Sync with upstream?'
            : `Conflicts with ${mergeTargetBranch} detected. Sync with upstream?`;
          const shouldSync = await promptYesNo(promptMsg, true);

          if (shouldSync) {
            // Close storage before running unblock (it will open its own connection)
            await storage.close();
            storageClosed = true;

            await runSyncWithUpstream(taskId);

            // Don't auto-retry — the human should review the merge result first
            // (the agent may have taken the wrong side of a conflict)
            console.log(`\nRetry when ready: ${theme.command('lazy accept ' + displayId(task))}`);
            process.exit(0);
          } else {
            // User declined - show manual instructions
            console.log(`\nRun: ${theme.command('lazy unblock ' + displayId(task) + ' --sync-with-upstream')}`);
            console.log(`Then retry: ${theme.command('lazy accept ' + displayId(task))}`);
            process.exit(1);
          }
        } else {
          // Non-interactive mode: automatically invoke sync-with-upstream.
          // The agent will merge upstream and resolve conflicts in the background.
          console.log('Automatically syncing with upstream...');

          // Close storage before running unblock (it will open its own connection)
          await storage.close();
          storageClosed = true;

          await runSyncWithUpstream(taskId);

          // Don't auto-retry — the human should review the merge result first
          // (the agent may have taken the wrong side of a conflict)
          console.log(`\nRetry when ready: ${theme.command('lazy accept ' + displayId(task))}`);
          process.exit(0);
        }
      } else {
        // Non-conflict failure — show error, task stays blocked
        console.error(theme.error(`Merge failed: ${result.error}`));
        console.error('Resolve the issue, then run accept again.');
        process.exit(1);
      }
    }

    if (result.status === 'pending') {
      if (wait) {
        // --wait flag: poll CI checks and retry
        console.log(`Merge pending: ${result.reason}`);
        console.log('Waiting for CI checks to complete...\n');

        const checksResult = await driver.waitForChecks(task);

        if (checksResult.passed) {
          console.log(theme.success('All checks passed! Retrying merge...\n'));

          // Retry the merge
          const retryResult = await driver.merge({
            sourceBranch: sess.git_branch,
            targetBranch: mergeTargetBranch,
            task,
            taskShortId: taskRef(task),
            root,
          });

          // Persist any new metadata from retry (same invariant as above)
          if (retryResult.metadata) {
            for (const [key, value] of Object.entries(retryResult.metadata)) {
              await storage.updateTaskMetadata(task.id, key, value);
            }
            if (!task.metadata) task.metadata = {};
            Object.assign(task.metadata, retryResult.metadata);
          }

          if (retryResult.status === 'failed') {
            console.error(theme.error(retryResult.error));
            console.error('Merge failed after checks passed. Resolve the issue, then run accept again.');
            process.exit(1);
          }

          if (retryResult.status === 'pending') {
            // Still pending after checks passed — set to merging
            await storage.updateTaskStatus(task.id, 'merging', getActor());
            console.log(`Task ${displayId(task)} approved. Merge still pending: ${retryResult.reason}`);
            console.log('The reconciler will complete the merge when ready.');
            return;
          }

          result = retryResult;
        } else {
          // Checks failed or timed out — set to merging so reconciler can pick it up
          if (checksResult.timedOut) {
            console.log(theme.warning('Timed out waiting for CI checks to complete.'));
          } else {
            console.error(theme.error('CI checks failed:'));
            for (const check of checksResult.failed) {
              const urlSuffix = check.url ? ` (${check.url})` : '';
              console.error(`  - ${check.name}${urlSuffix}`);
            }
            process.exit(1);
          }

          // Timeout: set to merging so reconciler picks it up
          await storage.updateTaskStatus(task.id, 'merging', getActor());
          console.log(`Task ${displayId(task)} approved. Merge pending — reconciler will complete it.`);
          return;
        }
      } else {
        // No --wait flag: set task to 'merging' and exit cleanly
        await storage.updateTaskStatus(task.id, 'merging', getActor());

        // Store accept reason as a comment on the task
        await storage.createComment(task.id, `[Accepted] ${reason.trim()}`, getActor());

        // Post accept reason as an approving PR review (if remote driver)
        const reviewWarning = await driver.postAcceptReview(task, reason.trim());
        if (reviewWarning) {
          console.error(`Warning: ${reviewWarning}`);
        }

        console.log(`Task ${displayId(task)} approved. Merge pending: ${result.reason}`);
        console.log('The reconciler will complete the merge when ready.');
        console.log(`Check status: ${theme.command('lazy show ' + displayId(task))}`);
        return;
      }
    }

    // After a successful remote merge, fast-forward the local parent branch
    // to match the remote. This prevents the next task from starting on a
    // stale SHA and showing a confusing merge commit on turn 1.
    const ffResult = await driver.fastForwardLocal(mergeTargetBranch, root);
    if (!ffResult.success) {
      // CRITICAL: Fast-forward failed — the remote merge succeeded but we couldn't
      // update the local branch. Do NOT mark the task as complete. This would leave
      // the task stuck in 'complete' state while the local branch is out of sync.
      // The user needs to fix the local branch state first, then retry accept.
      console.error(`Error: ${ffResult.warning || 'Failed to fast-forward local branch'}`);
      console.error(`The remote merge succeeded, but the local ${mergeTargetBranch} branch could not be updated.`);
      console.error(`Fix the local branch state (likely: run 'git pull' in the main repo), then retry accept.`);
      process.exit(1);
    }
    if (ffResult.warning) {
      console.error(`Warning: ${ffResult.warning}`);
    }

    // Accept succeeded — print result-specific messages
    if (isChildTask) {
      console.log(theme.success(`\nMerged into parent task ${displayId(parentTask!)}.`));
      console.log(`Unblock parent task: ${theme.command('lazy unblock ' + displayId(parentTask!))}`);
    }

    // End session with accepted outcome
    await storage.endSession(sess.id, 'accepted');

    // Store accept reason as a comment on the task
    await storage.createComment(task.id, `[Accepted] ${reason.trim()}`, getActor());

    // Post accept reason as an approving GitHub PR review (if remote driver)
    const reviewWarning = await driver.postAcceptReview(task, reason.trim());
    if (reviewWarning) {
      console.error(`Warning: ${reviewWarning}`);
    }

    // Transition through merging → complete. Even for local merges, we go
    // through the merging state so the transition table stays consistent:
    // blocked → merging → complete (never blocked → complete directly).
    await storage.updateTaskStatus(task.id, 'merging', getActor());
    await storage.updateTaskStatus(task.id, 'complete', getActor());

    // Re-parent unfinished children to the grandparent
    await reparentAndLog(task, storage);

    // Stop and remove the task's Docker container
    await cleanupTaskContainer(storage, sess, taskRef(task), root);

    // Remove lock before cleaning up worktree
    removeLock(worktreePath);

    // Clean up worktree and branch
    cleanupWorktreeAndBranch(worktreePath, sess.git_branch, root);

    // Clean up protocol directory
    removeProtocolDir(protocolDir(task.id));

    // Summary (use driver to get the remote URL)
    const remoteUrl = await driver.getTaskUrl(task);
    const finalCommits = await storage.getSessionCommits(sess.id);
    if (remoteUrl) {
      console.log(theme.success(`\nTask ${displayId(task)} accepted — merged via remote.`));
      console.log(`  ${theme.label('URL:')} ${remoteUrl}`);
    } else {
      console.log(theme.success(`\nTask ${displayId(task)} accepted and merged into ${mergeTargetBranch}.`));
      console.log(`  ${theme.label('Commits merged:')} ${theme.count(String(finalCommits.length))}`);
    }

    // --- Continuation task offer for revert tasks ---
    const revertsTaskId = task.metadata?.reverts_task_id;
    if (revertsTaskId) {
      // Look up the original task to get its goal and display ID
      const originalTask = await storage.getTask(revertsTaskId);
      const originalTaskCode = task.metadata?.original_task_code ?? (originalTask ? displayId(originalTask) : shortId(revertsTaskId));
      const revertReason = task.metadata?.revert_reason ?? '';
      const revertsMergeSha = task.metadata?.reverts_merge_sha ?? '';

      // Get the revert commit SHA (current HEAD after merge)
      const revertSha = getCurrentSha(root);

      const originalGoal = originalTask?.goal ?? 'Unknown goal';

      console.log(`\nThe original task was: ${theme.taskId(originalTaskCode)}`);
      console.log(`  ${theme.label('Goal:')} ${originalGoal}`);

      // Determine whether to create continuation task
      let shouldCreateContinuation: boolean;
      if (yes) {
        shouldCreateContinuation = true;
      } else if (isTTY()) {
        shouldCreateContinuation = await promptYesNo('\nCreate a continuation task to redo the work?', true);
      } else {
        shouldCreateContinuation = true;
      }

      if (shouldCreateContinuation) {
        // Generate continuation code: <original-code>-v2, -v3, etc.
        let continuationCode = `${originalTaskCode}-v2`;
        let version = 2;
        // Check if code already exists and increment
        while (true) {
          const codeError = validateCode(continuationCode);
          if (codeError) {
            // Code is too long or invalid — skip setting a code
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

        const contTask = await storage.createTask(
          originalGoal,
          undefined,
          undefined,
          continuationCode || undefined,
        );
        await storage.updateTaskPrompt(contTask.id, continuationPrompt);

        // Store metadata linking to original and revert tasks
        await storage.updateTaskMetadata(contTask.id, 'continues_task_id', revertsTaskId);
        await storage.updateTaskMetadata(contTask.id, 'revert_task_id', task.id);
        await storage.updateTaskMetadata(contTask.id, 'revert_sha', revertSha);

        const contDisplayId = displayId(contTask);
        console.log(`\nCreated continuation task: ${theme.taskId(contDisplayId)}`);
        console.log(`  Start when ready: ${theme.command(`lazy start ${contDisplayId}`)}`);
      }
    }

  } finally {
    if (!storageClosed) {
      await storage.close();
    }
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
  --approve-file <file> Approve a violated file (repeatable). Required when accepting
                        a conflict task — all violated files must be listed.

Reason input priority: --reason flag > piped stdin > interactive prompt > "LGTM"

Behavior:
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
    - If yes: fires off sync-with-upstream (non-blocking), then exits
    - Review the merge result, then retry accept manually
    - If no: shows manual instructions

  Non-interactive mode (no TTY or --yes flag):
    - Automatically invokes sync-with-upstream (non-blocking), then exits
    - Review the merge result, then retry accept manually

Examples:
  lazy accept abc12345                          # Accept with interactive prompt for reason
  lazy accept abc12345 --reason "LGTM"          # Accept with inline reason
  echo "Looks good" | lazy accept abc12345      # Piped stdin as reason
  lazy accept abc12345 --yes                    # Accept without prompts (uses "LGTM")
  lazy accept abc12345 --reason "Ship it" --yes # Accept with reason, no prompts
  lazy accept abc12345 --wait                   # Wait for CI checks before merging
  lazy accept abc12345 --approve-file a.ts --approve-file b.ts --yes  # Accept conflict task, approving violated files`);
}
