/**
 * Auto-resume logic for interrupted tasks.
 *
 * Shared between the reconciler (automatic) and the resume command (manual).
 * Performs the minimum steps to restart a task: write unblock command,
 * launch supervisor container, update session state.
 */

import { pathExists } from './fs';
import { setupSandbox } from './sandbox';
import type { Storage } from '../storage';
import type { Task, Session } from '../types';
import { loadConfig } from '../config/loader';
import { resolveAndPersistLowHighLoop } from '../daemon/effort';
import type { EffortLevel } from '../config/types';
import { resolveTurnLaunchIdentity } from '../daemon/launch-identity';
import { createRunner } from '../runner';
import { harnessForTask, setRunnerAgentForTask } from '../daemon/task-harness';
import { stampSessionRunner, removeTaskRun, mustRecreateForContainerAgent } from '../runner/session-launch';
import { pinnedCustomImage } from '../docker/worktree-image';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields } from '../protocol';
import type { UnblockCommand } from '../protocol';
import { acquireLock, removeLock } from './lock';
import { logger } from './logger';
import { taskRef, getWorktreePathForRef, getBranchNameFromId } from '../task/identity';
import { getRemoteDefaultBranch, hasUncommittedChanges, getTaskTargetBranch } from '../git/operations';
import { parentTaskIdOf } from '../task-target';
import { writeDaemonMcpConfig } from '../daemon/task-launcher';
import { resolveUpstreamMergeRefForCommand } from '../daemon/upstream-command-ref';
import { resolveWrapUpCommandFields } from '../daemon/wrap-up-plan';
import { planTurnCredential, mustRecreateForCredentialPlan, systemTurnBlock } from '../daemon/turn-credentials';
import { usagePauseHold } from '../daemon/usage-pause';
import { hasDaemonContext } from '../daemon/context';
import { findPendingFeedback, buildFeedbackRedeliveryPrompt } from './feedback-redelivery';
import { isTurnInFlight } from '../daemon/in-flight-turn';
import { memberInsideTask } from '../server/member-terminals';
import { withTaskLifecycleLock } from '../daemon/task-lifecycle-lock';
import { supervisorStillOwnsTurn } from '../daemon/supervisor-handback';
import { buildAgentSwitchHandoffContext } from '../agent/switch-handoff';
import { rediscoverSessionIdForHarness } from '../agent/session-discovery';
import { typeConstraintsSection } from '../task/type-constraints';
import { buildTurnHistoryContext } from '../task/turn-context';
import { systemActor } from '../identity/system-identity';

import lazyToolInstructions from '../prompts/tool-instructions.md' with { type: 'text' };
import systemInstructionsResumeText from '../prompts/system-instructions-resume.md' with { type: 'text' };
import resumeContextText from '../prompts/resume-context.md' with { type: 'text' };
import goalContextResumeText from '../prompts/goal-context-resume.md' with { type: 'text' };
import { pinnedBaseOf } from '../task/base-pin';

/** Maximum consecutive interruptions before circuit breaker stops auto-resume */
export const MAX_CONSECUTIVE_INTERRUPTIONS = 3;

/**
 * Translate a container exit code to a human-readable reason.
 */
export function exitCodeToReason(exitCode: number | null): string {
  if (exitCode === null) return 'Container disappeared (no exit code)';
  switch (exitCode) {
    case 0: return 'Clean exit (exit code 0)';
    case 1: return 'General error (exit code 1)';
    case 137: return 'OOM killed or SIGKILL (exit code 137)';
    case 143: return 'Graceful shutdown / SIGTERM (exit code 143)';
    default: return `Container exited with code ${exitCode}`;
  }
}

/**
 * Build the resume prompt.
 *
 * INVARIANT (CLAUDE.md — never lose human feedback): when `redeliveredFeedback`
 * is present it REPLACES the generic "you were interrupted, carry on" context.
 * The generic prompt leaves unconsumed feedback available only implicitly via
 * turn history, and in practice the agent never acts on it.
 */
function buildResumePrompt(goal: string, redeliveredFeedback?: string): string {
  const goalContext = goalContextResumeText.replace(/\{\{goal\}\}/g, goal) + '\n\n';
  const resumeContext = (redeliveredFeedback ?? resumeContextText) + '\n';
  const lazyBinaryInstructions = lazyToolInstructions + '\n';
  const systemInstructions = systemInstructionsResumeText + '\n';
  return goalContext + resumeContext + lazyBinaryInstructions + systemInstructions;
}

/**
 * Auto-resume an interrupted task. Called by the reconciler after marking
 * a task as interrupted and checking the circuit breaker.
 *
 * Returns true if resume was successful, false if it failed.
 */
export async function autoResumeTask(
  storage: Storage,
  task: Task,
  session: Session,
  lazyRoot: string,
): Promise<boolean> {
  const tRef = taskRef(task);
  const taskShortId = task.id.substring(0, 8);
  const worktreePath = getWorktreePathForRef(lazyRoot, tRef);
  // Whoever configured this install's automation — resolved once, used by every
  // row this resume writes, including the failure paths at the bottom.
  const resumedBy = await systemActor(lazyRoot);

  // INVARIANT: never write a command into a protocol dir a synchronous daemon
  // turn (ask / review / wrap-up) is waiting on. The protocol has no
  // command↔response correlation id, so a command written here displaces the
  // running turn's response (writeCommand renames it aside) and the waiter then
  // consumes THIS command's answer instead. Both lanes (fast and slow) funnel
  // through here, so this is the one place that has to say it.
  if (await isTurnInFlight(storage, task.id)) {
    logger.debug(`Auto-resume ${taskShortId}: a synchronous daemon turn is in flight for this task, skipping`);
    return false;
  }

  // A member has a terminal open on the task (a Teams Shell, Pair or Chat): no
  // turn starts underneath them. Checked here, before anything is written, so
  // a pass that finds them still there leaves no trace; the launch below
  // re-checks under the lifecycle lock (refuseLaunchWhileMemberInside), which
  // is the authority.
  const memberInside = memberInsideTask(task.id);
  if (memberInside) {
    logger.debug(`Auto-resume ${taskShortId}: ${memberInside} has a terminal open on this task, skipping`);
    return false;
  }

  // INVARIANT (engineer rule, 2026-09-20): the daemon does not act on a task
  // before the supervisor has returned control. An interrupted task normally has
  // no supervisor left — but an answer that landed just before the interrupt is
  // still that turn's, and the sweeps that record it own the mailbox until they
  // have. Resuming across it displaces the response instead.
  const supervisorOwner = await supervisorStillOwnsTurn(lazyRoot, task, session);
  if (supervisorOwner) {
    logger.debug(`Auto-resume ${taskShortId}: ${supervisorOwner}, skipping`);
    return false;
  }

  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept): a
  // pending protected-file violation does NOT block an auto-resume. The turn it
  // launches never reverts a file, so an interrupted task can finish its work
  // with the decision still outstanding; `lazy accept` is the gate that refuses
  // until every violation is approved. The old skip existed only because the
  // unblock path used to revert whatever it was not told to keep, which would
  // have destroyed the agent's changes behind the reviewer's back.

  // Pre-flight checks
  if (!await pathExists(worktreePath)) {
    logger.debug(`Auto-resume ${taskShortId}: worktree not found, skipping`);
    return false;
  }

  const runner = await createRunner(lazyRoot, task.runner_type ?? undefined);

  try {
    await runner.checkAvailability();
  } catch {
    logger.debug(`Auto-resume ${taskShortId}: runner not available, skipping`);
    return false;
  }

  // Nobody asked for this turn, so a per-user-credential project runs it on the
  // project's service credential — and refuses rather than billing an arbitrary
  // member if there isn't one. Warned, not debug-logged: a silently non-resuming
  // task looks like a bug in auto-resume.
  const systemBlock = await systemTurnBlock(lazyRoot);
  if (systemBlock) {
    logger.warn(`Auto-resume ${taskShortId}: skipped — ${systemBlock}`);
    return false;
  }

  // [usage_pause]: the credential this turn would spend is past its threshold.
  // Held, not dropped — returning before anything is consumed is what lets the
  // caller retry it once the window resets (src/daemon/usage-pause.ts).
  const usageHold = await usagePauseHold(lazyRoot, storage, task, 'auto-resume');
  if (usageHold) {
    logger.info(`Auto-resume ${taskShortId}: held by usage pause — ${usageHold}`);
    return false;
  }

  // Acquire worktree lock
  try {
    await acquireLock(worktreePath, 'lazy auto-resume');
  } catch {
    logger.debug(`Auto-resume ${taskShortId}: could not acquire worktree lock, skipping`);
    return false;
  }

  // Bridge/stamp the resolved runner onto the session before launch.
  await stampSessionRunner(storage, lazyRoot, session, worktreePath, runner.type);

  const containerName = runner.runNameForTask(tRef);

  try {
    // The PROJECT ROOT's config, never the task worktree's copy — a task branch
    // is agent-writable and its lazy.toml has no authority (see findConfigDir
    // in src/config/loader.ts). This used to load from the worktree so that "the
    // branch may have settings that aren't on the root yet"; that rationale is
    // retired by decision, because it let a turn choose the permissions,
    // checks, watchdog and model its own next turn would run under.
    const config = await loadConfig(lazyRoot);

    // INVARIANT: every launchSupervisor path must set the runner's agent profile
    // BEFORE launch. Without this, launchSupervisorAsync falls back to the
    // default `claude-code` profile — Anthropic env only — while the command
    // still says agent_id=cursor/codex. cursor-agent then dies with
    // "set CURSOR_API_KEY", the session stamps container_agent_id as cursor, and
    // every later resume reuses the wrongly wired container. That was the
    // inform-the-task-when-a-subtask-is-accepted fatal_auth incident, and it is
    // also what made a Cursor task look like it had "reverted to Claude" after
    // an interruption (or after a review left the task interrupted).
    setRunnerAgentForTask(runner, config, task);

    const sandbox = await setupSandbox(worktreePath, { storage, taskId: task.id });

    // An auto-resume continues an interrupted turn, so it runs on exactly what
    // that turn ran on. Nobody is here to name an override — the task record IS
    // the answer. One rule for every turn type; see resolveTurnLaunchIdentity.
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

    // Agent session id: rediscover only what THIS harness can resume — Claude
    // sessions for claude-code, pi sessions for pi. After an agent switch the
    // id is cleared on purpose; inventing a Claude resume token for
    // Cursor/Codex skips the distilled handoff and fails, and those harnesses
    // have no per-worktree session file to rediscover either.
    //
    // Rediscovery matters most exactly here: `agent_session_id` is only written
    // when a turn FINALIZES, so a task whose very first turn was killed has none
    // stored, and without this it would resume as a brand-new conversation —
    // the 2026-09-16 pi incident re-sent the full prompt to a fresh session an
    // hour after the crash. Discovery goes through the one module that knows
    // each harness's session layout, asking the RUNNER where that layout's
    // directory is — the sandbox for docker, the host HOME for host-process.
    const harness = harnessForTask(config, task);
    let agentSessionId = session.agent_session_id;
    if (!agentSessionId) {
      agentSessionId = await rediscoverSessionIdForHarness(harness, runner, worktreePath);
      if (agentSessionId) {
        await storage.updateSessionClaudeId(session.id, agentSessionId);
        session.agent_session_id = agentSessionId;
      }
    }
    const canResume = !!agentSessionId;

    // Build resume prompt.
    //
    // INVARIANT (CLAUDE.md — never lose human feedback): if the interrupted turn
    // crashed before the agent consumed its feedback, re-deliver that feedback
    // verbatim instead of the generic resume prompt. Applies to EVERY crash
    // cause, not just any particular one.
    const pendingFeedback = findPendingFeedback(await storage.getSessionTurns(session.id));
    let fullPrompt = buildResumePrompt(
      task.goal,
      pendingFeedback ? buildFeedbackRedeliveryPrompt(pendingFeedback) : undefined,
    );
    if (pendingFeedback) {
      logger.info(`Auto-resume ${taskShortId}: re-delivering unconsumed feedback from turn ${pendingFeedback.turn.sequence}` +
        (pendingFeedback.olderPendingCount > 0 ? ` (${pendingFeedback.olderPendingCount} older also pending)` : ''));
    }
    if (!canResume) {
      const turns = await storage.getSessionTurns(session.id);
      if (turns.length > 0) {
        try {
          const handoff = await buildAgentSwitchHandoffContext({
            turns,
            branchName: session.git_branch,
            gitStartSha: session.git_start_sha,
            worktreePath,
          });
          fullPrompt = `${handoff}\n\n${fullPrompt}`;
        } catch (err) {
          logger.warn(
            `Auto-resume ${taskShortId}: agent-switch handoff failed (${err instanceof Error ? err.message : String(err)}); falling back to turn history only`,
          );
          fullPrompt = `${buildTurnHistoryContext(turns)}\n\n${fullPrompt}`;
        }
      }
    }

    // --- Persist state BEFORE launching container ---

    // Bind this turn's credential BEFORE the status flip and the command write.
    // Nobody asked for an auto-resume, so in a per-user-credential project it
    // runs on the project's service credential (the gate at the top of this
    // function established there is one). This is the path a task stranded by a
    // dead daemon comes back on, and the supervisor it is resuming may have
    // outlived that daemon — binding after the command is written lets it start
    // the turn on a revoked placeholder. See prepareTurnLaunch.
    //
    // FIRST, before the resume notice below, because this call can REFUSE: a
    // store that cannot clear the previous turn's owner fails the launch rather
    // than attribute this turn to them (src/daemon/turn-owner.ts). This path is
    // retried on every reconciler pass, so anything written before the refusal
    // is written again on the next one — the notice is not content-idempotent,
    // and a wedged store would grow one per pass forever.
    const credentialPlan = await planTurnCredential(lazyRoot, {
      taskId: task.id,
      sessionId: session.id,
      storage,
    });

    // UNDER THE TASK'S LIFECYCLE LOCK, like every launch path, and the notice
    // turn with it: a member's entry into this task (src/daemon/member-entry.ts)
    // takes the same lock, so either this launch sees the member inside and refuses
    // BEFORE writing anything
    // (refuseLaunchWhileMemberInside, inside mustRecreateForCredentialPlan), or the entry sees
    // this task `working` and is refused — never a member working in the
    // worktree while a turn runs on it.
    const mustRecreateForCredential = await withTaskLifecycleLock(task.id, async () => {
      const recreate = await mustRecreateForCredentialPlan(lazyRoot, task.id, credentialPlan);
      // The notice is written only once the member check above has passed,
      // in the same lock: a member entering between the two would otherwise
      // leave a notice for a resume refused a moment later.
      // Record synthetic human turn for the auto-resume.
      //
      // NOBODY ASKED FOR THIS TURN — the reconciler noticed a stranded one and
      // brought it back — so the row names the account that CONFIGURED the
      // automation, under the role `system` it already carried (§3.3 case 3,
      // src/identity/system-identity.ts). The bare role is still what an install
      // that has configured nobody records.
      //
      // NOT autoTriggered: resume continues an interrupted turn — it's the same
      // logical turn, not a new auto-react trigger. Does not count against the
      // auto-turn budget.
      //
      // Deliberately NOT carriesFeedback: this notice is not new feedback, and the
      // re-delivered turn stays 'pending' until the agent actually completes a
      // turn — so a crash during the resume re-delivers it again.
      const nextSeq = await storage.getNextTurnSequence(session.id);
      await storage.createTurn({
        sessionId: session.id,
        sequence: nextSeq,
        role: 'human',
        content: pendingFeedback
          ? '[system] Session interrupted and auto-resumed (unconsumed feedback re-delivered)'
          : '[system] Session interrupted and auto-resumed',
        // Labelled like every other request turn (unblock, ask, review): what
        // this turn was DISPATCHED to run on. Without them the resume notice was
        // a hole in the per-turn record — the one place a reviewer looks to see
        // which model a stranded task came back on.
        agent: task.agent_id,
        model: modelName,
        effort: effortValue,
        actor: resumedBy,
      });
      await storage.setAutoResumed(session.id, true);
      await storage.updateTaskStatus(task.id, 'working', resumedBy);
      return recreate;
    });
    const mustRecreateForAgent = mustRecreateForContainerAgent(session, task.agent_id);
    if (mustRecreateForAgent) {
      logger.info(
        `Auto-resume ${taskShortId}: recreating container — agent changed ` +
        `(${session.container_agent_id} → ${task.agent_id}); launch env is fixed at create time`,
      );
    }

    // (Marked auto-resumed and moved to working above, under the lock.)

    // --- Write command and launch supervisor ---

    const protoDir = getProtocolDir(task.id);
    ensureProtocolDir(protoDir);

    // INVARIANT: Every unblock merges upstream before giving feedback.
    // Resolve the parent branch the same way the normal unblock path does
    // (shared.ts lines 1078-1083) so the supervisor merges upstream before
    // the agent resumes. Without this, auto-resumed tasks drift behind main.
    //
    // However, merging upstream is unsafe when the worktree has uncommitted
    // changes from a crashed turn — git merge on a dirty worktree will fail
    // or create confusing state. In that case, skip the merge and let the
    // agent deal with the uncommitted changes first.
    const worktreeDirty = await hasUncommittedChanges(worktreePath);
    let parentBranch: string | undefined;
    let upstreamMergeRef: string | undefined;
    let syncBeforeWork = false;

    if (pinnedBaseOf(task)) {
      // INVARIANT: a pinned task (lazy clone --same-base) is never merged with
      // its parent by the daemon — only an explicit human `lazy sync` does
      // that. See the matching gate in syncTaskRun (src/daemon/task-lifecycle.ts).
      logger.debug(`Auto-resume ${taskShortId}: pinned to a base commit, skipping upstream merge`);
    } else if (worktreeDirty) {
      logger.debug(`Auto-resume ${taskShortId}: worktree is dirty, skipping upstream merge`);
    } else {
      try {
        const arParentId = parentTaskIdOf(task);
        if (arParentId) {
          parentBranch = await getBranchNameFromId(arParentId, storage);
        } else {
          // Top-level task: prefer the task's stored integration target; fall
          // back to the repo's configured default branch — NEVER to whatever
          // branch the user currently has checked out. Auto-resume runs from
          // the daemon, possibly while the user is on an unrelated branch.
          parentBranch = await getTaskTargetBranch(task, lazyRoot) ?? await getRemoteDefaultBranch(lazyRoot, config.remote.git_remote);
        }
        if (parentBranch) {
          const upstreamResolution = await resolveUpstreamMergeRefForCommand(
            lazyRoot,
            worktreePath,
            parentBranch,
            config,
          );
          if (upstreamResolution.ref) {
            upstreamMergeRef = upstreamResolution.ref;
            parentBranch = upstreamResolution.ref;
          }
        }
        syncBeforeWork = true;
      } catch (err) {
        logger.debug(`Auto-resume ${taskShortId}: could not resolve parent branch: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Inject crash-state context so the agent knows what happened
    const crashContext = worktreeDirty
      ? 'You are being resumed after a crash. There are uncommitted changes in your worktree from your interrupted turn. Review them, decide what to keep, commit or discard, then continue your work.\n\n'
      : 'You are being resumed after a crash. Upstream has been merged into your branch since your last turn. Don\'t assume your previous state is intact — verify before continuing.\n\n';

    const unblockCommand: UnblockCommand = {
      type: 'unblock',
      task_id: task.id,
      goal: task.goal,
      // A loop's constraints hold on EVERY turn it takes, including the ones the
      // daemon starts for it. Without this a resumed loop — which may well be
      // running on a FRESH agent session, since a turn killed before finalize
      // never recorded a resumable session id — is handed a bare "carry on"
      // prompt with no contract, and does its children's work itself instead of
      // re-reading its tree. Same injection `unblock` makes; see
      // src/task/type-constraints.ts.
      prompt: typeConstraintsSection(task) + crashContext + fullPrompt,
      agent_id: task.agent_id,
      harness,
      model_id: modelId,
      effort: turnEffort,
      ...(lowHighLoop ? { low_high_loop: { review_effort: lowHighLoop.reviewEffort } } : {}),
      agent_session_id: canResume ? agentSessionId! : undefined,
      parent_branch: parentBranch,
      upstream_merge_ref: upstreamMergeRef,
      sync_before_work: syncBeforeWork,
      branch_point_sha: session.git_start_sha,
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
      logger.debug(`Auto-resume ${taskShortId}: supervisor already running, command written`);
    } else {
      await removeTaskRun(runner, storage, session, containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath, tRef, task.id, pinnedCustomImage(task));
      } catch (err) {
        logger.warn(`Auto-resume ${taskShortId}: failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
        await storage.updateTaskStatus(task.id, 'interrupted', resumedBy);
        return false;
      }
    }

    // Store container name and update interaction timestamp
    await storage.updateSessionContainerName(session.id, containerName, task.agent_id);
    session.container_agent_id = task.agent_id;
    await storage.updateSessionInteraction(session.id, 0);

    logger.info(`Auto-resumed task ${taskShortId} (consecutive interruptions: ${session.consecutive_interruptions})`);
    return true;
  } catch (err) {
    logger.warn(`Auto-resume ${taskShortId} failed: ${err instanceof Error ? err.message : err}`);
    // Ensure task stays interrupted if auto-resume fails
    try {
      await storage.updateTaskStatus(task.id, 'interrupted', resumedBy);
    } catch {
      // Best effort
    }
    return false;
  } finally {
    await removeLock(worktreePath);
  }
}
