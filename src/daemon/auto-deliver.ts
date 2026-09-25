/**
 * Auto-delivery — daemon detects state changes and delivers signals to tasks.
 *
 * The single delivery path: state changes detected by reconcile → signals
 * emitted to SQLite → blocked/submitted tasks drain the queue and auto-unblock
 * through the protocol (UnblockCommand written to protocol dir, supervisor
 * picks it up at the next turn boundary).
 *
 * Event types and their delivery:
 *
 *   upstream.updated → blocked children: syncTask() (merge only, no agent turn)
 *   task.completed   → blocked parent: auto-unblock with child completion context
 *   task.failed      → blocked parent: auto-unblock with failure context
 *   task.accepted    → blocked siblings: syncTask() (merge only)
 */

import { join } from 'path';
import { pathExists } from '../utils/fs';
import { setupSandbox } from '../utils/sandbox';
import type { Storage } from '../storage';
import type { Task, Session, TaskStatus } from '../types';

import { loadConfig } from '../config/loader';
import { resolveTurnLaunchIdentity } from './launch-identity';
import { resolveAndPersistLowHighLoop } from './effort';
import type { EffortLevel } from '../config/types';
import { createRunner } from '../runner';
import { harnessForTask, setRunnerAgentForTask } from './task-harness';
import { stampSessionRunner, removeTaskRun, mustRecreateForContainerAgent } from '../runner/session-launch';
import { pinnedCustomImage } from '../docker/worktree-image';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields } from '../protocol';
import type { UnblockCommand } from '../protocol';
import { acquireLock, removeLock, checkLock } from '../utils/lock';
import { isTurnInFlight } from './in-flight-turn';
import { memberInsideTask } from '../server/member-terminals';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { supervisorStillOwnsTurn } from './supervisor-handback';
import { logger } from '../utils/logger';
import { sanitizeUserText } from '../utils/sanitize-text';
import { taskRef, getWorktreePathForRef } from '../task/identity';
import { taskBranchFor } from '../git/branch-prefix';
import { parentTaskIdOf } from '../task-target';
import { isLinkedTask } from '../task/linked';
import { branchExists } from '../git/operations';
import { shouldAutoReact, recordAutoReact, type AutoReactTrigger } from './auto-react-budget';
import { runGit } from '../utils/git';
import { emitSignal, readSignals, consumeSignals, consumeSignalsById } from './signals';
import { writeDaemonMcpConfig } from './task-launcher';
import { resolveWrapUpCommandFields } from './wrap-up-plan';
import { planTurnCredential, mustRecreateForCredentialPlan, systemTurnBlock } from './turn-credentials';
import { usagePauseHold } from './usage-pause';
import { hasDaemonContext } from './context';
import { restartClusterForAddedChildren } from './cluster-restart';
import { isClusterTask } from '../types';
import { typeConstraintsSection } from '../task/type-constraints';
import { isUserStopped } from '../task/user-stop';

import lazyToolInstructions from '../prompts/tool-instructions.md' with { type: 'text' };
import systemInstructionsResumeText from '../prompts/system-instructions-resume.md' with { type: 'text' };
import resumeContextText from '../prompts/resume-context.md' with { type: 'text' };
import goalContextResumeText from '../prompts/goal-context-resume.md' with { type: 'text' };
import { parkTaskPaused } from '../utils/paused-status';
import { pinnedBaseOf } from '../task/base-pin';
import { systemActor } from '../identity/system-identity';

/**
 * Check whether a task's parent branch has commits that the task branch
 * hasn't merged yet. Returns the parent tip SHA if ahead, null otherwise.
 *
 * This is a stateless check — it compares the merge-base to the parent
 * branch tip using only git state. Safe to call repeatedly without risk
 * of duplicating actions (caller is responsible for dedup/delivery).
 */
async function isParentBranchAhead(
  storage: Storage,
  task: Task,
  lazyRoot: string,
): Promise<{ ahead: boolean; parentTip: string | null }> {
  const parentId = parentTaskIdOf(task);
  if (!parentId) return { ahead: false, parentTip: null };

  const session = await storage.getSessionByTaskId(task.id);
  if (!session?.git_branch) return { ahead: false, parentTip: null };

  const parentTask = await storage.getTask(parentId);
  if (!parentTask) return { ahead: false, parentTip: null };

  const parentRef = taskRef(parentTask);
  const parentBranch = taskBranchFor(parentRef);

  if (!await branchExists(parentBranch, lazyRoot) || !await branchExists(session.git_branch, lazyRoot)) {
    return { ahead: false, parentTip: null };
  }

  try {
    const mergeBase = await runGit(['merge-base', session.git_branch, parentBranch], { cwd: lazyRoot });
    if (mergeBase.exitCode !== 0) return { ahead: false, parentTip: null };

    const parentTip = await runGit(['rev-parse', parentBranch], { cwd: lazyRoot });
    if (parentTip.exitCode !== 0) return { ahead: false, parentTip: null };

    const tip = parentTip.stdout.trim();
    const ahead = mergeBase.stdout.trim() !== tip;
    return { ahead, parentTip: tip };
  } catch {
    return { ahead: false, parentTip: null };
  }
}

function shortId(id: string): string {
  return id.substring(0, 8);
}

function buildAutoDeliverPrompt(goal: string): string {
  const goalContext = goalContextResumeText.replace(/\{\{goal\}\}/g, goal) + '\n\n';
  const resumeContext = resumeContextText + '\n';
  const lazyBinaryInstructions = lazyToolInstructions + '\n';
  const systemInstructions = systemInstructionsResumeText + '\n';
  return goalContext + resumeContext + lazyBinaryInstructions + systemInstructions;
}

// --- Auto-unblock for blocked tasks ---

/**
 * Auto-unblock a blocked task with context about an event.
 *
 * Similar to autoResumeTask() but for blocked tasks receiving daemon events.
 * Creates a human turn with event context, transitions to working, writes
 * an unblock command, and launches/reuses the supervisor.
 *
 * This is purely feedback delivery — no upstream merge. Use syncTask()
 * for upstream merge operations.
 *
 * Defense-in-depth: Checks the auto-react budget BEFORE doing any work.
 * This ensures that even if a caller forgets to check the budget, the
 * auto-unblock will be blocked if the budget is exhausted.
 *
 * Returns true if the auto-unblock succeeded.
 */
export async function autoUnblockTask(
  storage: Storage,
  task: Task,
  session: Session,
  lazyRoot: string,
  message: string,
  trigger: AutoReactTrigger,
): Promise<boolean> {
  const tRef = taskRef(task);
  const taskShortId = shortId(task.id);
  const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
  // NOBODY TYPED THIS DELIVERY, and every row it writes says whose automation
  // it is: the configured system identity, under the role `system` these rows
  // already carried (§3.3 case 3, src/identity/system-identity.ts). An install
  // that has configured nobody gets the bare role back, unchanged. Resolved
  // once, up here, because the failure paths below run outside the try block.
  const deliveredBy = await systemActor(lazyRoot);

  // INVARIANT: never write a command into a protocol dir a synchronous daemon
  // turn (ask / review / wrap-up) is waiting on — see the same guard in
  // src/utils/auto-resume.ts. The status gate below is not enough on its own:
  // it describes what the task looks like NOW, and the whole failure mode is a
  // second actor moving the task underneath a turn already in flight.
  if (await isTurnInFlight(storage, task.id)) {
    logger.debug(`Auto-unblock ${taskShortId}: a synchronous daemon turn is in flight for this task, skipping`);
    return false;
  }

  // A member has a terminal open on the task (a Teams Shell, Pair or Chat): no
  // turn starts underneath them. Checked here, before anything is written, so
  // a pass that finds them still there leaves no trace; the launch below
  // re-checks under the lifecycle lock (refuseLaunchWhileMemberInside), which
  // is the authority.
  const memberInside = memberInsideTask(task.id);
  if (memberInside) {
    logger.debug(`Auto-unblock ${taskShortId}: ${memberInside} has a terminal open on this task, skipping`);
    return false;
  }

  // INVARIANT (engineer rule, 2026-09-20): the daemon does not act on a task
  // before the supervisor has returned control. The caller's status read says
  // the task is parked; it cannot say the settle has finished. Landing inside
  // that window writes `command.json` next to an unconsumed `response.json`, and
  // the next tick then parks the task this launch had just taken to `working`.
  const supervisorOwner = await supervisorStillOwnsTurn(lazyRoot, task, session);
  if (supervisorOwner) {
    logger.debug(`Auto-unblock ${taskShortId}: ${supervisorOwner}, skipping`);
    return false;
  }

  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept): a
  // pending protected-file violation does NOT block auto-delivery. No turn
  // reverts anything any more, so continuing the work cannot destroy a file the
  // reviewer has not decided on; the decision is owed at `lazy accept`, which
  // refuses until every violation is approved. The old skip existed only
  // because the unblock this launches used to revert whatever it was not told
  // to keep — and it is what stranded blocked cluster tasks mid-review.

  // Pre-flight checks
  if (!await pathExists(worktreePath)) {
    logger.debug(`Auto-unblock ${taskShortId}: worktree not found, skipping`);
    return false;
  }

  // Skip if worktree is locked by another process
  if (await checkLock(worktreePath)) {
    logger.debug(`Auto-unblock ${taskShortId}: worktree locked, skipping`);
    return false;
  }

  // No human asked for this turn, so in a per-user-credential project it runs on
  // the project's service credential — and if there isn't one, it does not run.
  // Surfaced rather than debug-logged: a project that quietly stopped
  // auto-delivering would look like a bug in auto-delivery.
  const systemBlock = await systemTurnBlock(lazyRoot);
  if (systemBlock) {
    logger.warn(`Auto-unblock ${taskShortId}: skipped — ${systemBlock}`);
    return false;
  }

  // [usage_pause]: the credential this turn would spend is past its threshold.
  // Held, not dropped — returning before anything is consumed is what lets the
  // caller retry it once the window resets (src/daemon/usage-pause.ts).
  const usageHold = await usagePauseHold(
    lazyRoot, storage, task,
    trigger === 'child_added' ? 'cluster restart' : `auto-delivery (${trigger.replace('_', ' ')})`,
  );
  if (usageHold) {
    logger.info(`Auto-unblock ${taskShortId}: held by usage pause — ${usageHold}`);
    return false;
  }

  const runner = await createRunner(lazyRoot, task.runner_type ?? undefined);
  try {
    await runner.checkAvailability();
  } catch {
    logger.debug(`Auto-unblock ${taskShortId}: runner not available, skipping`);
    return false;
  }

  // Defense-in-depth budget check: Verify the auto-react is allowed
  // before acquiring the lock and doing any work. This ensures that
  // even if a caller forgets to check the budget, we never bypass it.
  const config = await loadConfig(lazyRoot);
  // INVARIANT: set the runner's agent profile before any launchSupervisor call.
  // Same bug class as auto-resume — without this a cursor task's recreated
  // container gets the default claude-code credential env and fatal_auth's on
  // "set CURSOR_API_KEY". See setRunnerAgentForTask in task-harness.ts.
  setRunnerAgentForTask(runner, config, task);
  const dataDir = join(lazyRoot, '.lazy');
  const decision = await shouldAutoReact(storage, task.id, trigger, config, dataDir);

  if (!decision.allowed) {
    logger.info(`Auto-unblock ${taskShortId}: blocked by budget (${trigger}): ${decision.reason}`);
    return false;
  }

  // Acquire worktree lock
  try {
    await acquireLock(worktreePath, 'lazy auto-deliver');
  } catch {
    logger.debug(`Auto-unblock ${taskShortId}: could not acquire worktree lock, skipping`);
    return false;
  }

  // Bridge/stamp the resolved runner onto the session before launch.
  await stampSessionRunner(storage, lazyRoot, session, worktreePath, runner.type);

  const containerName = runner.runNameForTask(tRef);

  try {
    // An auto-delivery carries an event to a task nobody is currently steering,
    // so there is no override to honour — it runs on whatever the previous turn
    // ran on. One rule for every turn type; see resolveTurnLaunchIdentity, which
    // still applies the per-role rule (a local ollama/proxy backend forces its
    // authoritative model) through resolveAgentModel underneath.
    const { model: modelName, effort: effortValue } = await resolveTurnLaunchIdentity({
      storage,
      task,
      config,
    });
    const modelId = modelName;

    // THE RECOVERY PATHS RESOLVE THE REVIEW SETTINGS TOO, exactly as the three
    // launch literals do. `low_high` is the DEFAULT mode now, so a turn that
    // skips this runs single-phase and produces no self-review at all — and if
    // it is the turn that declares final, the task parks with nothing recorded
    // and nothing gating. Invisible while the loop was opt-in; load-bearing
    // now. CLAUDE.md names this exact class: "the recovery paths are exactly
    // the ones that forgot".
    const lowHighLoop = await resolveAndPersistLowHighLoop(
      task, undefined, config, storage, effortValue as EffortLevel,
    );
    const turnEffort = lowHighLoop ? lowHighLoop.draftEffort : effortValue;

    const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

    // Build the full prompt with event context.
    // INTAKE BOUNDARY: the message is assembled from comment/CI text that may
    // predate sanitization (older stored comments, external CI output). Escape
    // control characters here too — this prompt becomes argv[2] of `claude -p`.
    const safeMessage = sanitizeUserText(message);
    const fullPrompt = safeMessage + '\n\n' + buildAutoDeliverPrompt(task.goal);

    // --- Persist state BEFORE launching container ---

    // Bind this turn's credential BEFORE the status flip and the command write.
    // No turn owner was recorded (nobody asked for it), so this resolves to the
    // service credential — the gate above already established there is one.
    // `daemon-env` for a single-user install. Binding after the command is
    // written leaves a supervisor that outlived its daemon free to start the
    // turn on a revoked placeholder; see prepareTurnLaunch.
    const credentialPlan = await planTurnCredential(lazyRoot, {
      taskId: task.id,
      sessionId: session.id,
      storage,
    });
    // UNDER THE TASK'S LIFECYCLE LOCK, like every launch path, and the
    // delivered turn with it: a member's entry into this task
    // (src/daemon/member-entry.ts) takes the same lock, so either this launch
    // sees the member inside and refuses BEFORE writing anything
    // (refuseLaunchWhileMemberInside, inside mustRecreateForCredentialPlan), or the entry sees
    // this task `working` and is refused — never a member working in the
    // worktree while a turn runs on it.
    const mustRecreateForCredential = await withTaskLifecycleLock(task.id, async () => {
      const recreate = await mustRecreateForCredentialPlan(lazyRoot, task.id, credentialPlan);
      // The delivered turn is written only once the member check above has
      // passed, in the same lock: written before it, a refused launch left a
      // feedback-carrying turn nobody dispatched, which redelivery would later
      // hand the agent a second time.
      // Record synthetic human turn for the auto-unblock.
      const nextSeq = await storage.getNextTurnSequence(session.id);
      await storage.createTurn({
        sessionId: session.id,
        sequence: nextSeq,
        role: 'human',
        content: `[system] ${safeMessage}`,
        // Labelled like every other request turn (unblock, ask, review): what
        // this turn was DISPATCHED to run on. Nobody typed this unblock, so the
        // per-turn record is the only place a reviewer can see which model the
        // daemon spent on delivering the event.
        agent: task.agent_id,
        model: modelName,
        effort: effortValue,
        actor: deliveredBy,
        autoTriggered: true,
        // INVARIANT: the actor's ROLE is 'system' (the daemon delivered it) but the
        // CONTENT is human comments / CI output destined for the agent. A crash
        // before consumption must re-deliver it, same as a manual unblock.
        carriesFeedback: true,
      });
      // Transition to working
      await storage.updateTaskStatus(task.id, 'working', deliveredBy);
      return recreate;
    });
    const mustRecreateForAgent = mustRecreateForContainerAgent(session, task.agent_id);
    if (mustRecreateForAgent) {
      logger.info(
        `Auto-unblock ${taskShortId}: recreating container — agent changed ` +
        `(${session.container_agent_id} → ${task.agent_id}); launch env is fixed at create time`,
      );
    }

    // --- Write command and launch supervisor ---

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    const unblockCommand: UnblockCommand = {
      type: 'unblock',
      task_id: task.id,
      goal: task.goal,
      // A cluster's constraints hold on EVERY turn it takes, and this is the
      // path that wakes a blocked cluster when a child is added to it
      // (cluster-restart.ts) as well as the one that resumes it after a crash.
      // Same injection `unblock` makes; see src/task/type-constraints.ts.
      prompt: typeConstraintsSection(task) + fullPrompt,
      agent_id: task.agent_id,
      harness: harnessForTask(config, task),
      model_id: modelId,
      effort: turnEffort,
      ...(lowHighLoop ? { low_high_loop: { review_effort: lowHighLoop.reviewEffort } } : {}),
      agent_session_id: session.agent_session_id ?? undefined,
      sync_before_work: false,
      // The wrap-up plan rides every work command: finality is declared DURING
      // the turn, after this write, so it cannot be sent later (§3.3).
      ...(await resolveWrapUpCommandFields({
        storage,
        task,
        sessionId: session.id,
        session: session,
        projectRoot: lazyRoot,
        worktreePath,
        config,
      })),
      ...commonCommandFields(config),
    };
    writeCommand(protoDir, unblockCommand);

    // Generate daemon MCP config so the supervisor can provide MCP tools
    let daemonConfigPath: string | undefined;
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(lazyRoot, containerName, { kind: 'task', taskId: task.id });
    }

    // Check if supervisor is already running
    if (!mustRecreateForCredential && !mustRecreateForAgent && (await runner.isRunning(containerName))) {
      logger.debug(`Auto-unblock ${taskShortId}: supervisor already running, command written`);
    } else {
      await removeTaskRun(runner, storage, session, containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath, tRef, task.id, pinnedCustomImage(task));
      } catch (err) {
        logger.warn(`Auto-unblock ${taskShortId}: failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
        await parkTaskPaused(storage, task.id, deliveredBy, { projectRoot: lazyRoot });
        return false;
      }
    }

    // Store container name and update interaction timestamp
    await storage.updateSessionContainerName(session.id, containerName, task.agent_id);
    session.container_agent_id = task.agent_id;
    await storage.updateSessionInteraction(session.id, 0);

    logger.info(`Auto-unblocked task ${taskShortId}: ${message}`);
    return true;
  } catch (err) {
    logger.warn(`Auto-unblock ${taskShortId} failed: ${err instanceof Error ? err.message : err}`);
    try {
      await parkTaskPaused(storage, task.id, deliveredBy, { projectRoot: lazyRoot });
    } catch {
      // Best effort
    }
    return false;
  } finally {
    await removeLock(worktreePath);
  }
}

// --- Event delivery to blocked tasks ---

/**
 * Deliver an upstream.updated event to a blocked child task.
 *
 * Checks the auto-react budget, then runs syncTask() to merge upstream.
 * This is a sync operation, not an unblock — no agent turn is created.
 */
export async function deliverUpstreamUpdated(
  storage: Storage,
  task: Task,
  lazyRoot: string,
  reason: string,
  /**
   * The queued `upstream_change` signals this delivery acts on. A sync the
   * usage pause holds consumes them (see below); without ids nothing is
   * consumed, which is what a direct caller wants.
   */
  upstreamSignalIds: string[] = [],
): Promise<boolean> {
  const taskShortId = shortId(task.id);

  if (isLinkedTask(task)) {
    logger.debug(`Auto-deliver ${taskShortId}: linked task, skipping auto-sync`);
    return false;
  }

  if (task.status !== 'blocked' && task.status !== 'submitted') {
    logger.debug(`Auto-deliver ${taskShortId}: not eligible (${task.status}), skipping upstream.updated`);
    return false;
  }

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    logger.debug(`Auto-deliver ${taskShortId}: no session, skipping upstream.updated`);
    return false;
  }

  // `lazy stop` means no daemon-initiated turn may start until somebody picks
  // the task back up. Leave the signal queued so the delivery is retried after
  // that explicit resume instead of losing the upstream change.
  if (isUserStopped(session)) {
    logger.debug(`Auto-deliver ${taskShortId}: user-stopped, deferring upstream.updated`);
    return false;
  }

  // A sync relaunches the task's agent, so it writes into the same protocol dir
  // a synchronous daemon turn may be waiting on. Same invariant as above.
  if (await isTurnInFlight(storage, task.id)) {
    logger.debug(`Auto-deliver ${taskShortId}: a synchronous daemon turn is in flight for this task, skipping`);
    return false;
  }

  // INVARIANT (engineer rule, 2026-09-20): same handback rule as autoUnblockTask
  // — a sync writes into the work mailbox, so it waits until the supervisor has
  // finished with the previous turn, not merely until the status says parked.
  const supervisorOwner = await supervisorStillOwnsTurn(lazyRoot, task, session);
  if (supervisorOwner) {
    logger.debug(`Auto-deliver ${taskShortId}: ${supervisorOwner}, skipping upstream.updated`);
    return false;
  }

  // Check auto-react budget
  const config = await loadConfig(lazyRoot);
  const dataDir = join(lazyRoot, '.lazy');
  const decision = await shouldAutoReact(storage, task.id, 'upstream_sync', config, dataDir);

  if (!decision.allowed) {
    logger.debug(`Auto-deliver ${taskShortId}: upstream_sync blocked by budget: ${decision.reason}`);
    return false;
  }

  // Use syncTask() — upstream.updated is a merge operation, not feedback delivery
  try {
    logger.debug(`Auto-sync ${taskShortId}: calling syncTask (${reason})`);
    const { syncTask } = await import('./task-lifecycle');
    const result = await syncTask(lazyRoot, { taskId: task.id, queueIfMemberInside: true, daemonLaunch: true });
    logger.debug(`Auto-sync ${taskShortId}: syncTask returned status=${result.status}`);

    if (result.status === 'sync_launched') {
      logger.info(`Auto-sync task ${taskShortId}: upstream merge launched (${reason})`);
      await recordAutoReact(storage, task.id, 'upstream_sync', dataDir);
      return true;
    } else if (result.status === 'up_to_date') {
      logger.debug(`Auto-sync ${taskShortId}: already up to date`);
      return false;
    } else if (result.usagePauseHeld) {
      // INVARIANT ([usage_pause]): a conflict sync the pause holds is owned by
      // the queued sync (`pending_sync`), which the retry loop re-offers with
      // backoff and which runs by itself after the reset. The upstream signal
      // is consumed here: left queued, every delivery pass for the whole pause
      // re-fetched and re-merged only to hit the same conflict and be held again.
      consumeSignalsById(task.id, upstreamSignalIds);
      logger.info(`Auto-sync ${taskShortId}: held by the usage pause; the queued sync retries after the reset`);
      return false;
    } else {
      // pending_sync — the fetch failed or the task stopped being syncable; the
      // queued sync is retried (the retry loop, and this signal on a later tick).
      logger.debug(`Auto-sync ${taskShortId}: ${result.message}`);
      return false;
    }
  } catch (err) {
    logger.warn(`Auto-sync ${taskShortId} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Deliver a task.completed event to a blocked parent task.
 *
 * DISABLED: Parent auto-react to child completions is disabled until a proper
 * parent-reviews-child system is built. The parent agent has nothing useful to
 * do with child completion notifications — it just burns turns repeating
 * "everything is complete." See task add-turn-budget for context.
 *
 * When re-enabled, this should check the auto-react budget, then auto-unblock
 * the parent with context about the child's completion.
 */
export async function deliverTaskCompleted(
  _storage: Storage,
  parentTask: Task,
  _childTaskId: string,
  _lazyRoot: string,
): Promise<boolean> {
  const parentShortId = shortId(parentTask.id);
  logger.debug(`Auto-deliver ${parentShortId}: child_completed trigger disabled — parent auto-react to child completions is turned off`);
  return false;
}

/**
 * Deliver a task.failed event to a blocked parent task.
 *
 * DISABLED: Parent auto-react to child failures is disabled until a proper
 * parent-reviews-child system is built. Same rationale as deliverTaskCompleted.
 * See task add-turn-budget for context.
 */
export async function deliverTaskFailed(
  _storage: Storage,
  parentTask: Task,
  _childTaskId: string,
  _lazyRoot: string,
): Promise<boolean> {
  const parentShortId = shortId(parentTask.id);
  logger.debug(`Auto-deliver ${parentShortId}: child_failed trigger disabled — parent auto-react to child failures is turned off`);
  return false;
}

/**
 * Deliver new FORGE comment(s) (PR/MR review comments imported from the remote)
 * to an eligible task.
 *
 * Aggregates all pending remote comment signals into a single auto-unblock
 * message containing the full comment text. Gated on `[daemon]
 * auto_react_comments` and the auto-react budget.
 *
 * INVARIANT (fix-comment-auto-launch): this path is for comments that arrive
 * from the FORGE, where nobody is sitting at a lazy CLI about to unblock the
 * task. A comment made through lazy itself — `lazy comment`, the web UI,
 * `lazy_comment` over MCP — must NEVER launch a turn: it is feedback that
 * rides the next `lazy unblock`, exactly as every comment surface documents
 * (`lazy ask` skips notes, `lazy sync` never builds them). Auto-launching one
 * races the human's own
 * unblock ("task is busy") and burns a turn on a comment they were about to
 * send properly. Local comment signals are consumed without delivery in
 * deliverPendingSignals.
 *
 * Eligible statuses: blocked, submitted.
 */
export async function deliverNewComments(
  storage: Storage,
  task: Task,
  commentSignals: Array<{ summary: string; details?: Record<string, unknown> }>,
  lazyRoot: string,
): Promise<boolean> {
  const taskShortId = shortId(task.id);

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    logger.debug(`Auto-deliver ${taskShortId}: no session, skipping new_comment`);
    return false;
  }

  const config = await loadConfig(lazyRoot);

  // The config key humans reach for to turn forge-comment auto-react off.
  // shouldAutoReact() only knows about budgets, so the switch is checked here.
  if (!config.daemon.auto_react_comments) {
    logger.debug(`Auto-deliver ${taskShortId}: forge comment auto-react disabled (auto_react_comments = false)`);
    return false;
  }

  // Check auto-react budget
  const dataDir = join(lazyRoot, '.lazy');
  const decision = await shouldAutoReact(storage, task.id, 'comment', config, dataDir);

  if (!decision.allowed) {
    logger.debug(`Auto-deliver ${taskShortId}: comment blocked by budget: ${decision.reason}`);
    return false;
  }

  // Build message with full comment content. The signal's summary is a
  // snapshot taken at import; a forge comment edited while still unseen is
  // updated IN PLACE, so read the comment's current content by id and fall
  // back to the snapshot only when the comment is gone.
  const currentContent = new Map((await storage.getTaskComments(task.id)).map(c => [c.id, c.content]));
  const count = commentSignals.length;
  const noun = count === 1 ? 'comment' : 'comments';
  let message = `You have ${count} new ${noun} on this task:\n`;
  for (const signal of commentSignals) {
    const actor = (signal.details?.actor as string) ?? 'human';
    const commentId = signal.details?.comment_id;
    const text = (typeof commentId === 'string' && currentContent.get(commentId)) || signal.summary;
    message += `\n---\n**From ${actor}:**\n${text}\n`;
  }

  const success = await autoUnblockTask(storage, task, session, lazyRoot, message, 'comment');

  if (success) {
    await recordAutoReact(storage, task.id, 'comment', dataDir);
  }

  return success;
}

/**
 * Deliver CI result signal(s) to an eligible task.
 *
 * Aggregates CI failure signals into a single auto-unblock message.
 * Uses the same generic delivery mechanism as comments — no separate path.
 * Checks the auto-react budget under the 'ci_failure' trigger.
 *
 * Eligible statuses: blocked, submitted.
 */
export async function deliverCISignals(
  storage: Storage,
  task: Task,
  ciSignals: Array<{ summary: string; details?: Record<string, unknown> }>,
  lazyRoot: string,
): Promise<boolean> {
  const taskShortId = shortId(task.id);

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    logger.debug(`Auto-deliver ${taskShortId}: no session, skipping ci_result`);
    return false;
  }

  // Preserve the queued CI signal while deliberately stopped. The next
  // explicit resume clears the gate and lets normal signal delivery retry it.
  if (isUserStopped(session)) {
    logger.debug(`Auto-deliver ${taskShortId}: user-stopped, deferring ci_result`);
    return false;
  }

  // Check auto-react budget
  const config = await loadConfig(lazyRoot);
  const dataDir = join(lazyRoot, '.lazy');
  const decision = await shouldAutoReact(storage, task.id, 'ci_failure', config, dataDir);

  if (!decision.allowed) {
    logger.debug(`Auto-deliver ${taskShortId}: ci_failure blocked by budget: ${decision.reason}`);
    return false;
  }

  const ciSummary = ciSignals.map(s => s.summary).join('\n');
  const message = `CI pipeline failed. Fix the failures and try again.\n\n${ciSummary}`;
  const success = await autoUnblockTask(storage, task, session, lazyRoot, message, 'ci_failure');

  if (success) {
    await recordAutoReact(storage, task.id, 'ci_failure', dataDir);
  }

  return success;
}

// --- Reconcile-time event detection and delivery ---

export interface StateChange {
  taskId: string;
  previousStatus: TaskStatus;
  currentStatus: TaskStatus;
  parentTaskId: string | null;
}

/**
 * State tracked across daemon reconcile ticks for detecting changes.
 */
export interface ReconcileEventState {
  /** Task status snapshot from the previous tick. taskId → status */
  previousStatuses: Map<string, TaskStatus>;
  /** Parent branch tips from the previous tick. parentBranch → sha */
  previousParentTips: Map<string, string>;
}

/**
 * Create initial empty reconcile event state.
 */
export function createReconcileEventState(): ReconcileEventState {
  return {
    previousStatuses: new Map(),
    previousParentTips: new Map(),
  };
}

/**
 * Detect and deliver events based on state changes between reconcile ticks.
 *
 * Called from the daemon reconcile loop after reconcileTasks() completes.
 * Compares current state to the previous tick's snapshot and:
 *
 * 1. Detects accepted tasks (non-terminal → complete) and routes events to siblings
 * 2. Detects parent branch changes and routes upstream.updated to children
 * 3. Delivers events to blocked tasks (auto-unblock) with budget checks
 *
 * Updates the state snapshot for the next tick.
 */
export async function detectAndDeliverEvents(
  storage: Storage,
  lazyRoot: string,
  state: ReconcileEventState,
): Promise<void> {
  try {
    const allTasks = await storage.listTasks();
    const nonTerminalTasks = allTasks.filter(t =>
      t.status !== 'complete' && t.status !== 'abandoned'
    );

    // Build current status map
    const currentStatuses = new Map<string, TaskStatus>();
    for (const task of allTasks) {
      currentStatuses.set(task.id, task.status);
    }

    // --- Detect accepted tasks (previously non-complete → now complete) ---
    for (const [taskId, prevStatus] of state.previousStatuses) {
      const currStatus = currentStatuses.get(taskId);
      if (currStatus === 'complete' && prevStatus !== 'complete') {
        // Task was accepted since last tick
        const task = allTasks.find(t => t.id === taskId);
        const parentId = task ? parentTaskIdOf(task) : null;
        if (parentId) {
          logger.debug(`Auto-deliver: detected accept of task ${shortId(taskId)}`);
          await handleTaskAccepted(storage, taskId, parentId, lazyRoot);
        }
      }
    }

    // --- Detect parent branch changes ---
    await detectParentBranchChanges(storage, nonTerminalTasks, lazyRoot, state);

    // --- Update state snapshot for next tick ---
    state.previousStatuses.clear();
    for (const [taskId, status] of currentStatuses) {
      state.previousStatuses.set(taskId, status);
    }
  } catch (err) {
    logger.debug(`Auto-deliver: detectAndDeliverEvents failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Handle a task acceptance: route events to parent and siblings,
 * and emit signals for blocked siblings.
 */
async function handleTaskAccepted(
  storage: Storage,
  acceptedTaskId: string,
  parentTaskId: string,
  _lazyRoot: string,
): Promise<void> {
  // Emit upstream_change signals for all siblings.
  // The signal delivery phase will handle the actual sync/unblock.
  const siblings = await storage.getChildTasks(parentTaskId);
  for (const sibling of siblings) {
    if (sibling.id === acceptedTaskId) continue;

    // Emit signal unconditionally — state checks belong in the delivery phase.
    emitSignal(sibling.id, {
      type: 'upstream_change',
      summary: `Sibling task ${shortId(acceptedTaskId)} accepted — parent branch updated`,
      details: { reason: 'sibling_accepted', accepted_task_id: acceptedTaskId },
    });
    logger.debug(`Auto-deliver: emitted upstream_change signal for sibling ${shortId(sibling.id)} (sibling ${shortId(acceptedTaskId)} accepted)`);
  }
}

/**
 * Detect parent branch changes and emit signals to children.
 *
 * For each task with a parent, checks if the parent branch tip has changed
 * since the last reconcile tick. If so, emits an upstream_change signal
 * (delivered in the signal delivery phase).
 *
 * This is event-driven: signals are only emitted when the parent branch tip
 * actually changes (a discrete event), not when a condition is detected.
 */
async function detectParentBranchChanges(
  storage: Storage,
  tasks: Task[],
  lazyRoot: string,
  state: ReconcileEventState,
): Promise<void> {
  // Build a set of parent task IDs that have children
  const parentIds = new Set<string>();
  for (const task of tasks) {
    const parentId = parentTaskIdOf(task);
    if (parentId) {
      parentIds.add(parentId);
    }
  }

  for (const parentId of parentIds) {
    try {
      const parentTask = await storage.getTask(parentId);
      if (!parentTask) continue;

      const parentBranch = taskBranchFor(taskRef(parentTask));

      // Get current parent branch tip
      const tipResult = await runGit(['rev-parse', parentBranch], { cwd: lazyRoot });
      if (tipResult.exitCode !== 0) continue;
      const currentTip = tipResult.stdout.trim();

      const previousTip = state.previousParentTips.get(parentBranch);
      state.previousParentTips.set(parentBranch, currentTip);

      // Skip if tip hasn't changed (or first tick)
      if (!previousTip || previousTip === currentTip) continue;

      logger.debug(`Auto-deliver: parent branch ${parentBranch} changed (${shortId(previousTip)} → ${shortId(currentTip)})`);

      // Get all children of this parent
      const children = await storage.getChildTasks(parentId);
      for (const child of children) {
        // Skip terminal tasks
        if (child.status === 'complete' || child.status === 'abandoned') {
          continue;
        }

        // Emit signal unconditionally — state checks belong in the delivery phase.
        emitSignal(child.id, {
          type: 'upstream_change',
          summary: `Parent branch changed (tip ${shortId(currentTip)})`,
          details: { parent_tip: currentTip, reason: 'branch_push' },
        });
        logger.debug(`Auto-deliver: emitted upstream_change signal for child ${shortId(child.id)} (tip ${shortId(currentTip)})`);
      }
    } catch (err) {
      logger.debug(`Auto-deliver: parent branch check failed for ${shortId(parentId)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Deliver events for state changes detected by the reconcile loop.
 *
 * Called after reconcileTasks() to handle auto-unblock for blocked parents
 * when children complete or fail.
 */
export async function deliverStateChangeEvents(
  storage: Storage,
  stateChanges: Array<{
    taskId: string;
    previousStatus: TaskStatus;
    currentStatus: TaskStatus;
    parentTaskId: string | null;
  }>,
  lazyRoot: string,
): Promise<void> {
  for (const change of stateChanges) {
    const { taskId, previousStatus, currentStatus, parentTaskId } = change;
    if (!parentTaskId) continue;

    // task.completed: working → blocked (turn finished)
    if (previousStatus === 'working' && (currentStatus === 'blocked' || currentStatus === 'conflict')) {
      const parentTask = await storage.getTask(parentTaskId);
      if (parentTask && parentTask.status === 'blocked') {
        await deliverTaskCompleted(storage, parentTask, taskId, lazyRoot);
      }
    }

    // task.failed: working → interrupted
    if (previousStatus === 'working' && currentStatus === 'interrupted') {
      const parentTask = await storage.getTask(parentTaskId);
      if (parentTask && parentTask.status === 'blocked') {
        await deliverTaskFailed(storage, parentTask, taskId, lazyRoot);
      }
    }
  }
}

// --- Signal delivery for eligible tasks ---
//
// Signals are emitted at event sources (detectParentBranchChanges,
// fetchRemoteComments, fetchCIFailures, lazy comment CLI) and persist
// in SQLite. This function processes the pending signal queues and
// delivers them to eligible tasks (blocked/submitted).
//
// Phase 1 (durable catchup) re-derives signals from persistent state
// to catch anything missed across daemon restarts. Phase 2 delivers
// all pending signals concurrently.

/**
 * Durable catchup: check all blocked tasks for conditions that require
 * auto-delivery, regardless of whether a transition was detected.
 *
 * Runs once per reconcile tick. For each blocked task:
 * 1. If parent branch is ahead of merge-base → emit upstream_change signal
 * 2. If children are in actionable state → emit child_completed/child_failed signal
 * 3. Deliver pending signals to eligible tasks (blocked/submitted)
 *
 * This is the safety net that ensures no signal is lost across daemon
 * restarts, supervisor restarts, or concurrent signal arrival. Signals
 * persist in SQLite, so they survive daemon restarts without re-derivation.
 */
export async function runBlockedTaskCatchup(
  storage: Storage,
  lazyRoot: string,
): Promise<void> {
  try {
    const allTasks = await storage.listTasks();
    const blockedTasks = allTasks.filter(t => t.status === 'blocked');

    logger.debug(`Catchup: ${blockedTasks.length} blocked task(s), lazyRoot=${lazyRoot}`);

    // --- Phase 1: Detect conditions and emit durable signals ---
    for (const task of blockedTasks) {
      // --- Check 1: Parent branch ahead of merge-base ---
      const parentId = parentTaskIdOf(task);
      if (parentId) {
        try {
          const { ahead, parentTip } = await isParentBranchAhead(storage, task, lazyRoot);
          logger.debug(`Catchup: task ${shortId(task.id)} parent_task_id=${shortId(parentId)} ahead=${ahead} parentTip=${parentTip ? shortId(parentTip) : 'null'}`);

          if (ahead && parentTip) {
            // Content-based dedup: check if a signal already exists for this parent tip
            const existingSignals = readSignals(task.id);
            const alreadySignaled = existingSignals.some(
              s => s.type === 'upstream_change' && s.details?.parent_tip === parentTip,
            );
            if (!alreadySignaled) {
              emitSignal(task.id, {
                type: 'upstream_change',
                summary: `Parent branch ahead (tip ${shortId(parentTip)})`,
                details: { parent_tip: parentTip },
              });
              logger.debug(`Catchup: emitted upstream_change signal for task ${shortId(task.id)} (tip ${shortId(parentTip)})`);
            }
          } else {
            // Parent is not ahead — clean up any stale upstream signals
            const existingSignals = readSignals(task.id);
            const staleSignals = existingSignals.filter(s => s.type === 'upstream_change');
            if (staleSignals.length > 0) {
              consumeSignalsById(task.id, staleSignals.map(s => s.id));
            }
          }
        } catch (err) {
          logger.debug(`Catchup: parent check failed for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // --- Check 2: Children in actionable state ---
      // DISABLED: child_completed and child_failed signals are not emitted.
      // Parent auto-react to child completions/failures is disabled until a
      // proper parent-reviews-child system is built. The parent agent has
      // nothing useful to do — it just burns turns. See task add-turn-budget.
      //
      // Clean up any stale child signals that may exist from before this was disabled.
      try {
        const existingSignals = readSignals(task.id);
        const staleChildSignals = existingSignals.filter(
          s => s.type === 'child_completed' || s.type === 'child_failed',
        );
        if (staleChildSignals.length > 0) {
          consumeSignalsById(task.id, staleChildSignals.map(s => s.id));
        }
      } catch (err) {
        logger.debug(`Catchup: child signal cleanup failed for ${shortId(task.id)}: ${err instanceof Error ? err.message : err}`);
      }

      // --- Check 2b: children added to a blocked CLUSTER task ---
      // Derived from the tree, not from a signal or a comment, and confined to
      // `cluster` tasks — the full rationale, including why this does not weaken
      // "a lazy comment never starts a turn", is in ./cluster-restart.ts.
      if (isClusterTask(task)) {
        try {
          await restartClusterForAddedChildren(storage, task, lazyRoot);
        } catch (err) {
          logger.debug(
            `Catchup: cluster restart check failed for ${shortId(task.id)}: ` +
              `${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // --- Check 3: New comments since last interaction ---
      // REMOVED (fix-comment-auto-launch): catchup used to scan blocked tasks
      // for lazy comments newer than the session's last interaction and emit a
      // `comment` signal for each, which auto-unblocked the task within one
      // reconcile tick. That contradicted every comment surface's documented
      // contract (a comment is delivered into the target's NEXT turn prompt)
      // and raced the human: they would comment, then run `lazy unblock`, and
      // unblock refused with "task is busy" because the daemon had already
      // started a system turn carrying only the comment.
      //
      // Lazy comments are delivered by the next `lazy unblock` (or the initial
      // start), the only two launches that build a "NOTES ADDED SINCE YOUR LAST
      // TURN" block from storage (buildNotesContext in
      // src/task/turn-context.ts) — `lazy ask` skips notes deliberately and
      // `lazy sync` never builds them, and neither consumes a queued comment.
      // Nothing is lost by not signalling here; forge PR/MR comments still
      // arrive as remote-sourced signals from remote-sync.ts.
    }

    // --- Phase 2: Deliver pending signals to eligible tasks ---
    // Delivery targets: blocked and submitted tasks.
    // Signals are emitted unconditionally; the delivery phase decides which
    // tasks are eligible to act on them.
    const eligibleTasks = allTasks.filter(t =>
      t.status === 'blocked' || t.status === 'submitted'
    );

    logger.debug(`Signal delivery: ${eligibleTasks.length} eligible task(s) (blocked/submitted)`);

    await deliverPendingSignals(storage, lazyRoot, eligibleTasks);
  } catch (err) {
    logger.debug(`Catchup: runBlockedTaskCatchup failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Max concurrent signal deliveries. Each task's queue is independent, but
 *  deliveries may launch supervisors or run git operations, so we limit
 *  concurrency to avoid overwhelming the system. */
const MAX_SIGNAL_DELIVERY_CONCURRENCY = 5;

/**
 * Deliver pending signals from SQLite to eligible tasks concurrently.
 *
 * For each eligible task (blocked/submitted/approved) with pending signals:
 * 1. Read signals from SQLite
 * 2. Determine delivery type (upstream sync, CI result, comment, etc.)
 * 3. Deliver using existing autoUnblockTask mechanism
 * 4. Consume signals on successful delivery
 *
 * Tasks are processed concurrently (up to MAX_SIGNAL_DELIVERY_CONCURRENCY)
 * since each task's queue is independent. Signals are consumed ONLY after
 * successful delivery. If delivery fails (budget exhausted, no worktree,
 * etc.), signals persist in SQLite and will be retried on the next tick.
 */
async function deliverPendingSignals(
  storage: Storage,
  lazyRoot: string,
  eligibleTasks: Task[],
): Promise<void> {
  // Collect tasks that have pending signals
  const tasksWithSignals: Array<{ task: Task; signals: ReturnType<typeof readSignals> }> = [];
  for (const task of eligibleTasks) {
    const signals = readSignals(task.id);
    if (signals.length > 0) {
      tasksWithSignals.push({ task, signals });
    }
  }

  if (tasksWithSignals.length === 0) return;

  logger.debug(`Signal delivery: ${tasksWithSignals.length} task(s) with pending signals`);

  // Read once per tick: forge-comment auto-react is a config switch, not a
  // deferral. With it off, remote comment signals are DROPPED rather than left
  // pending — otherwise they are re-evaluated on every 5s tick forever and the
  // queue grows without bound. The comments themselves stay in storage and are
  // still shown at review.
  const autoReactComments = (await loadConfig(lazyRoot)).daemon.auto_react_comments;

  async function deliverForTask(entry: { task: Task; signals: ReturnType<typeof readSignals> }): Promise<void> {
    const { task, signals } = entry;
    const taskShortId = shortId(task.id);

    try {
      // Group signals by type for prioritized delivery
      // INVARIANT: a task pinned to a base commit (lazy clone --same-base) is never
      // merged with its parent automatically, so its upstream_change signals are
      // CONSUMED here rather than left queued: the pin, not a failure, is why
      // nothing merges, and a queued upstream signal would otherwise re-run sync
      // every tick and, by the priority chain below, starve the task's CI-result
      // and forge-comment deliveries forever.
      const rawUpstreamSignals = signals.filter(s => s.type === 'upstream_change');
      let upstreamSignals = rawUpstreamSignals;
      if (pinnedBaseOf(task) && rawUpstreamSignals.length > 0) {
        consumeSignalsById(task.id, rawUpstreamSignals.map(s => s.id));
        logger.debug(`Signal delivery: consumed ${rawUpstreamSignals.length} upstream_change signal(s) for pinned task ${taskShortId}`);
        upstreamSignals = [];
      }
      // INVARIANT (fix-comment-auto-launch): only comments that arrived from the
      // FORGE may start a turn. A comment made through lazy itself is feedback
      // for the next turn the human starts, never a start signal — see
      // deliverNewComments. Signals without an explicit remote source are local
      // (or predate the source tag) and are dropped below, not delivered.
      const allCommentSignals = signals.filter(s => s.type === 'comment');
      const remoteCommentSignals = allCommentSignals.filter(s => s.details?.source === 'remote');
      const commentSignals = autoReactComments ? remoteCommentSignals : [];
      // Dropped without delivery: every local comment signal, plus the remote
      // ones when auto-react is switched off (disabled, not deferred).
      const dropCommentSignals = allCommentSignals.filter(s => !commentSignals.includes(s));
      const ciSignals = signals.filter(s => s.type === 'ci_result');
      const childCompletedSignals = signals.filter(s => s.type === 'child_completed');
      const childFailedSignals = signals.filter(s => s.type === 'child_failed');

      let delivered = false;

      // Priority: upstream sync > ci_result > comment
      // Only one delivery per task per tick (the unblock transitions task to working)
      if (upstreamSignals.length > 0) {
        logger.debug(`Signal delivery: ${upstreamSignals.length} upstream_change signal(s) for task ${taskShortId}`);
        delivered = await deliverUpstreamUpdated(
          storage, task, lazyRoot, 'signal_queue', upstreamSignals.map(s => s.id),
        );
      } else if (ciSignals.length > 0) {
        logger.debug(`Signal delivery: ${ciSignals.length} ci_result signal(s) for task ${taskShortId}`);
        delivered = await deliverCISignals(storage, task, ciSignals, lazyRoot);
      } else if (commentSignals.length > 0) {
        logger.debug(`Signal delivery: ${commentSignals.length} comment signal(s) for task ${taskShortId}`);
        delivered = await deliverNewComments(storage, task, commentSignals, lazyRoot);
      }

      // child_completed and child_failed signals are consumed without delivery.
      // Parent auto-react to child completions/failures is disabled.
      if (!delivered && (childCompletedSignals.length > 0 || childFailedSignals.length > 0)) {
        const staleIds = [...childCompletedSignals, ...childFailedSignals].map(s => s.id);
        consumeSignalsById(task.id, staleIds);
        logger.debug(`Signal delivery: consumed ${staleIds.length} stale child signal(s) for task ${taskShortId} (delivery disabled)`);
      }

      // Undeliverable comment signals are consumed without delivery. Nothing
      // emits local ones any more; queues written before fix-comment-auto-launch
      // (and any future emitter that forgets the rule) must not auto-launch a
      // turn on the next tick. The comments themselves are untouched in storage
      // and ride the next unblock.
      if (!delivered && dropCommentSignals.length > 0) {
        consumeSignalsById(task.id, dropCommentSignals.map(s => s.id));
        logger.debug(`Signal delivery: consumed ${dropCommentSignals.length} undelivered comment signal(s) for task ${taskShortId} (lazy comments never launch a turn; forge auto-react ${autoReactComments ? 'on' : 'off'})`);
      }

      if (delivered) {
        // Consume ALL signals for this task — the task is now working and
        // will observe the current state when the agent runs
        consumeSignals(task.id);
        logger.debug(`Signal delivery: delivered and consumed ${signals.length} signal(s) for task ${taskShortId}`);
      }
    } catch (err) {
      logger.debug(`Signal delivery failed for task ${taskShortId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Process tasks concurrently with a sliding window
  const inflight = new Set<Promise<void>>();
  for (const entry of tasksWithSignals) {
    const p = deliverForTask(entry);
    inflight.add(p);
    p.finally(() => inflight.delete(p));

    if (inflight.size >= MAX_SIGNAL_DELIVERY_CONCURRENCY) {
      await Promise.race(inflight);
    }
  }

  // Wait for remaining in-flight deliveries
  await Promise.allSettled([...inflight]);
}
