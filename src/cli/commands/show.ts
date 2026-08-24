import { requireStorage, shortId, displayId, formatDate, formatDuration, formatTokenCount, totalTokens, totalInputTokens, parseFlags, parseLineRange, sliceLines, taskRef } from '../helpers';
import { queryTaskShow, type ShowResult } from '../../daemon/rpc-fallback';
import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { createRunner } from '../../runner';
import { theme, dim } from '../theme';
import { renderStatusHeader } from '../status-header';
import { computeWorkingSubstate, renderWorkingStatus, type WorkingSubstate } from '../../utils/working-substate';
import { formatTurnLaunchLabels } from '../../utils/turn-labels';
import { isBuiltinPromptCode, readBuiltinPrompt, listBuiltinPrompts } from './prompts';
import { showConversationTranscript } from './import-conversation';
import { isTTY, promptChoice } from '../editor';
import { checkOrphanedChild, type OrphanCheckResult } from '../orphan';
import type { Task, Session, Turn, Commit, Comment, JournalEntry, FollowUp } from '../../types';
import type { StatusChange, TagEvent } from '../../storage/types';
import type { SupervisorStatus } from '../../protocol/types';
import type { AgentFailureClass } from '../../agent/failure-taxonomy';
import { parentTaskIdOf } from '../../task-target';
import { readWorktreeMergeState, isMidMerge, describeMergeState, type WorktreeMergeState } from '../../git/operations';
import { getWorktreePathForRef } from '../helpers';
import { pathExists } from '../../utils/fs';
import { TERMINAL_STATUSES } from '../../types';
import type { Storage } from '../../storage/interface';
import { getAutoReactSummary, type AutoReactTrigger } from '../../daemon/auto-react-budget';
import { showFileViewer } from '../tui/file-viewer';
import { groupTurnsIntoChunks } from '../../utils/turn-chunks';
import { logger } from '../../utils/logger';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { turnText } from '../../utils/turn-content';
import { loadConfig } from '../../config/loader';
import { describeExpiry } from '../../utils/local-day';
import { getSlowLaneState, getLastProjectAutoResumeAt } from '../../daemon/auto-resume-queue';
import { MAX_CONSECUTIVE_INTERRUPTIONS } from '../../utils/auto-resume';
import {
  loadTaskProtectionStatus,
  protectionSummary,
  protectionAdvice,
  type TaskProtectionStatus,
} from '../../protection/status';

/**
 * Pre-loaded data for building task show output.
 * Passed to buildTaskShowLines to avoid duplicating data loading.
 */
export interface TaskShowData {
  task: Task;
  session: Session | null;
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
  journal: JournalEntry[];
  followUps: FollowUp[];
  statusHistory: StatusChange[];
  tagHistory: TagEvent[];
  children: Task[];
  childSessions: Map<string, Session | null>;
  parent: Task | null;
  retryStatus: {
    retryCount: number;
    errors: { count: number; message: string; firstSeen: string; lastSeen: string; failure_class?: AgentFailureClass }[];
    /** Taxonomy class of the latest failure — says WHY the turn is retrying. */
    failureClass?: AgentFailureClass;
    failureReason?: string;
    /** Delay before the next attempt (ms), when the supervisor has scheduled one. */
    nextDelayMs?: number;
  } | null;
  orphanStatus: OrphanCheckResult | null;
  autoReactStatus: { paused: boolean; reason: string | null; counts: Record<AutoReactTrigger, number>; consecutiveAutoTurns: number } | null;
  /** Supervisor status snapshot for working tasks (null when task is not working or status file is missing). */
  supervisorStatus: SupervisorStatus | null;
  /**
   * Derived working substate (agent / harness:<phase> / not-alive) for working
   * tasks. Observational only. Null when the task is not working or no substate
   * can be derived. Shares the single derivation used by ls/blocked/active/watch.
   */
  workingSubstate: WorkingSubstate | null;
  /**
   * Merge state of the task's worktree, when one exists on disk.
   *
   * INVARIANT (fix-sync-silent-conflict): a task whose worktree is mid-merge must
   * SAY so. A stranded merge used to be invisible on every status surface — the
   * task read as a plain `blocked` and the only symptom was accept refusing much
   * later with the wrong reason. Null when there is no worktree to read.
   */
  mergeState: WorktreeMergeState | null;
  /**
   * Read-only branch-protection status (add-protection-surfacing): is this
   * task's accept gated, and does a `lazy approve` already sit pending?
   *
   * Null when no project root was available to read config/git from (e.g. the
   * search command's line-number computation), NOT when nothing is protected —
   * an unprotected task carries a status object saying so.
   */
  protection: TaskProtectionStatus | null;
  /**
   * Slow-lane auto-resume queue position (src/daemon/auto-resume-queue.ts),
   * present only when this task's fast-lane circuit breaker has tripped and
   * it is now waiting for a round-robin retry. Null otherwise — including
   * when daemon.auto_resume is off, since nothing is queued then.
   */
  autoResumeQueue: { attempts: number; maxAttempts: number; nextEligibleAt: number } | null;
}

/**
 * Load all data needed for task show output.
 */
export async function loadTaskShowData(storage: Storage, task: Task, root?: string): Promise<TaskShowData> {
  const sess = await storage.getSessionByTaskId(task.id);
  const children = await storage.getChildTasks(task.id);

  let retryStatus: TaskShowData['retryStatus'] = null;
  let supervisorStatus: SupervisorStatus | null = null;
  let workingSubstate: WorkingSubstate | null = null;
  if (task.status === 'working' && sess) {
    const protoDir = getProtocolDir(task.id);
    const status = readStatus(protoDir);
    supervisorStatus = status;
    if (status?.phase === 'retrying') {
      retryStatus = {
        retryCount: status.retryCount ?? 0,
        errors: status.errors ?? [],
        failureClass: status.retry_failure_class,
        failureReason: status.retry_failure_reason,
        nextDelayMs: status.retry_next_delay_ms,
      };
    }

    // Derive the working substate from status.json + run liveness. Requires a
    // root to probe the runner; when absent (e.g. search line-number computation)
    // we degrade to no substate rather than guessing alive/dead.
    if (root) {
      try {
        const runner = await createRunner(root);
        const cn = sess.container_name ?? runner.runNameForTask(taskRef(task));
        const info = await runner.getRunInfo(cn);
        workingSubstate = await computeWorkingSubstate(protoDir, info?.running === true);
      } catch (err) {
        logger.debug(`Task ${shortId(task.id)}: could not derive working substate: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Read the worktree's merge state for any task that still has a worktree. This
  // is two cheap git calls and it is the ONLY thing that makes a stranded merge
  // visible before accept trips over it (fix-sync-silent-conflict).
  let mergeState: WorktreeMergeState | null = null;
  if (root && !TERMINAL_STATUSES.has(task.status)) {
    try {
      const wt = getWorktreePathForRef(root, taskRef(task));
      if (await pathExists(wt)) mergeState = await readWorktreeMergeState(wt);
    } catch (err) {
      logger.debug(`Task ${shortId(task.id)}: could not read worktree merge state: ${err instanceof Error ? err.message : err}`);
    }
  }

  const turns = sess ? await storage.getSessionTurns(sess.id) : [];
  const commits = sess ? await storage.getSessionCommits(sess.id) : [];
  const comments = await storage.getTaskComments(task.id);
  const journal = await storage.getTaskJournal(task.id);
  const followUps = await storage.getTaskFollowUps(task.id);
  const statusHistory = await storage.getStatusHistory(task.id);
  const tagHistory = await storage.getTagHistory(task.id);

  const parentId = parentTaskIdOf(task);
  const parent = parentId ? await storage.getTask(parentId) : null;

  const childSessions = new Map<string, Session | null>();
  for (const child of children) {
    childSessions.set(child.id, await storage.getSessionByTaskId(child.id));
  }

  // Check orphan status for child tasks
  let orphanStatus: OrphanCheckResult | null = null;
  if (parentId && root) {
    orphanStatus = await checkOrphanedChild(task, storage, root);
  }

  // Load auto-react status
  let autoReactStatus: TaskShowData['autoReactStatus'] = null;
  try {
    autoReactStatus = await getAutoReactSummary(storage, task.id);
    // Only include if there's meaningful data (any count > 0, paused, or auto-turns)
    const hasData = autoReactStatus.paused || Object.values(autoReactStatus.counts).some(c => c > 0) || autoReactStatus.consecutiveAutoTurns > 0;
    if (!hasData) autoReactStatus = null;
  } catch {
    // Non-critical
  }

  // Branch-protection status. Read-only and best-effort: a project whose
  // config or git we cannot read must still show the task, so this degrades to
  // null rather than failing the command.
  let protection: TaskProtectionStatus | null = null;
  let autoResumeQueue: TaskShowData['autoResumeQueue'] = null;
  if (root) {
    try {
      const config = await loadConfig(root);
      protection = await loadTaskProtectionStatus(storage, config, root, task, {
        hasBranch: Boolean(sess?.git_branch),
      });

      // Slow-lane queue position — only meaningful for an interrupted task
      // whose fast-lane circuit breaker has already tripped (mirrors
      // listSlowLaneQueue's own filter, so this can't disagree with
      // `lazy daemon resume-queue`/`lazy list`).
      if (config.daemon.auto_resume && task.status === 'interrupted' && sess && !sess.ended_at
        && sess.consecutive_interruptions >= MAX_CONSECUTIVE_INTERRUPTIONS && !sess.user_stopped) {
        const state = await getSlowLaneState(storage, task.id);
        if (!state.exhausted) {
          const now = Date.now();
          const intervalMs = config.daemon.auto_resume_interval_minutes * 60_000;
          const dataDir = join(root, config.data.path);
          const lastProjectAttempt = await getLastProjectAutoResumeAt(dataDir);
          const gapMs = config.daemon.auto_resume_gap_minutes * 60_000;
          const gapEligibleAt = lastProjectAttempt === null ? now : lastProjectAttempt + gapMs;
          const intervalEligibleAt = state.lastAttemptAt === null ? now : state.lastAttemptAt + intervalMs;
          // Approximation: this floors the ETA at the project-wide gap as if this
          // task were always next in the round-robin. When another task is ahead
          // of it, the real wait is longer — `lazy daemon resume-queue` shows the
          // exact order for that case.
          autoResumeQueue = {
            attempts: state.attempts,
            maxAttempts: config.daemon.auto_resume_max_attempts,
            nextEligibleAt: Math.max(intervalEligibleAt, gapEligibleAt),
          };
        }
      }
    } catch (err) {
      logger.debug(`Task ${shortId(task.id)}: could not resolve protection/auto-resume status: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { task, session: sess, turns, commits, comments, journal, followUps, statusHistory, tagHistory, children, childSessions, parent, retryStatus, orphanStatus, autoReactStatus, supervisorStatus, workingSubstate, mergeState, protection, autoResumeQueue };
}

/**
 * Build the text output lines for a task.
 * Used by both the show command (for display) and the search command (for line number computation).
 *
 * When `showChunks` is true, the Turns section is grouped into review chunks
 * (one human/builder boundary plus its following agent/supervisor/system turns)
 * using the single source of truth in `src/utils/turn-chunks.ts`. The per-turn
 * rendering is identical in both modes — only the grouping/headers differ.
 */
export function buildTaskShowLines(data: TaskShowData, showFull: boolean, showChunks = false): string[] {
  const { task, session: sess, turns, commits, comments, journal, followUps, statusHistory, tagHistory, children, childSessions, parent, retryStatus, orphanStatus, autoReactStatus, supervisorStatus, workingSubstate, mergeState, protection, autoResumeQueue } = data;
  const outputLines: string[] = [];

  // Status text decorated with the derived working substate for working tasks.
  // Retry detail is stripped here: `show` already spells it out in the header
  // line and the Retry State block, so repeating it in the status word would be
  // the same error text three times on one screen.
  const substateForStatus = workingSubstate && workingSubstate.kind === 'harness' && workingSubstate.retry
    ? { ...workingSubstate, retry: undefined }
    : workingSubstate;
  const taskStatusText = task.status === 'working' && substateForStatus
    ? renderWorkingStatus(substateForStatus)
    : task.status;

  // Supervisor status header (only for working tasks with a status file)
  if (task.status === 'working' && supervisorStatus) {
    outputLines.push(dim(renderStatusHeader(supervisorStatus)));
    outputLines.push('');
  }

  // Task info
  outputLines.push(`Task ${theme.taskId(displayId(task))}`);
  outputLines.push(`  ${theme.label('ID:')}      ${task.id}`);
  if (task.code) {
    outputLines.push(`  ${theme.label('Code:')}    ${task.code}`);
  }
  outputLines.push(`  ${theme.label('Goal:')}    ${task.goal}`);
  outputLines.push(`  ${theme.label('Status:')}  ${theme.status(taskStatusText)}`);
  // A mid-merge worktree is reported next to the status, because it CONTRADICTS
  // it: `blocked` reads as "settled, waiting for you", and this says otherwise.
  if (mergeState && isMidMerge(mergeState)) {
    outputLines.push(
      `  ${theme.label('Worktree:')} ${theme.warning(`unresolved merge — ${describeMergeState(mergeState)}`)}`,
    );
    outputLines.push(
      `            ${dim(`A sync did not finish. Run \`lazy sync ${displayId(task)}\` to complete it.`)}`,
    );
  }
  // Branch protection, next to the status because it is a fact about what this
  // task can DO — a gated task reads as "ready to accept" until the accept is
  // refused. Printed only when there is something to say, so an unprotected
  // project's `show` output is byte-for-byte what it was.
  const protectionValue = protection ? protectionSummary(protection) : null;
  if (protection && protectionValue) {
    const paint = protection.gated ? theme.warning : dim;
    outputLines.push(`  ${theme.label('Protected:')} ${paint(protectionValue)}`);
    for (const line of protectionAdvice(protection, displayId(task))) {
      outputLines.push(`             ${dim(line)}`);
    }
  }
  outputLines.push(`  ${theme.label('Model:')}   ${theme.model(task.model ?? '-')}`);
  outputLines.push(`  ${theme.label('Agent:')}   ${task.agent_id}`);
  outputLines.push(`  ${theme.label('Type:')}    ${task.type ?? 'task'}`);
  if (task.tags && task.tags.length > 0) {
    outputLines.push(`  ${theme.label('Tags:')}    ${task.tags.map(t => theme.tag('#' + t)).join(' ')}`);
  }

  outputLines.push(`  ${theme.label('Created:')} ${theme.timestamp(formatDate(task.created_at))}`);
  if (task.completed_at) {
    outputLines.push(`  ${theme.label('Done:')}    ${theme.timestamp(formatDate(task.completed_at))}`);
  }
  if (task.close_reason) {
    outputLines.push(`  ${theme.label('Close Reason:')} ${task.close_reason}`);
  }
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    outputLines.push(`  ${theme.label('Metadata:')}`);
    for (const [key, value] of Object.entries(task.metadata)) {
      outputLines.push(`    ${key}: ${value}`);
    }
  }

  // Parent info
  const parentTaskId = parentTaskIdOf(task);
  if (parentTaskId) {
    outputLines.push(`\n${theme.label('Parent Task:')}`);
    outputLines.push(`  ${theme.taskId(parent ? displayId(parent) : shortId(parentTaskId))} - ${parent?.goal ?? '(unknown)'}`);
    if (task.branched_from_sha) {
      outputLines.push(`  ${theme.label('Branched from:')} ${theme.commitSha(task.branched_from_sha.substring(0, 8))}`);
    }
    // Orphan warning: parent task was accepted and its branch is gone
    if (orphanStatus?.isOrphaned && orphanStatus.retargetBranch) {
      outputLines.push(`\n  ${theme.warning('Warning: Parent task was accepted and its branch deleted.')}`);
      outputLines.push(`  ${theme.warning(`This task needs rebasing onto ${orphanStatus.retargetBranch} before it can continue.`)}`);
      outputLines.push(`  Run ${theme.command('lazy unblock ' + displayId(task))} or ${theme.command('lazy start ' + displayId(task))} to retarget automatically.`);
    }
  }

  // Session info (unified view)
  if (sess) {
    const status = sess.outcome ?? (sess.ended_at ? 'ended' : taskStatusText);
    outputLines.push(`\n${theme.label('Session')} (${sess.agent_id})`);
    outputLines.push(`  ${theme.label('Status:')}           ${theme.status(status)}${sess.ended_at ? ' (' + theme.timestamp(formatDate(sess.ended_at)) + ')' : ''}`);
    outputLines.push(`  ${theme.label('Branch:')}           ${sess.git_branch}`);
    outputLines.push(`  ${theme.label('Started:')}          ${theme.timestamp(formatDate(sess.started_at))}`);
    if (sess.last_interaction_at) {
      outputLines.push(`  ${theme.label('Last Interaction:')} ${theme.timestamp(formatDate(sess.last_interaction_at))}`);
    }
    outputLines.push(`  ${theme.label('Total Duration:')}   ${theme.duration(formatDuration(sess.total_duration_ms))}`);
    if (sess.total_usage) {
      const total = totalTokens(sess.total_usage);
      const inputTotal = totalInputTokens(sess.total_usage);
      outputLines.push(`  ${theme.label('Token Usage:')}      ${formatTokenCount(total)} (${formatTokenCount(inputTotal)} in, ${formatTokenCount(sess.total_usage.outputTokens)} out)`);
      if (sess.total_usage.cacheCreationTokens > 0 || sess.total_usage.cacheReadTokens > 0) {
        outputLines.push(`  ${theme.label('Cache Tokens:')}     ${formatTokenCount(sess.total_usage.cacheCreationTokens)} write, ${formatTokenCount(sess.total_usage.cacheReadTokens)} read`);
      }
    }
    outputLines.push(`  ${theme.label('Start SHA:')}        ${theme.commitSha(sess.git_start_sha.substring(0, 8))}`);

    // Interrupt diagnostics (if task was interrupted)
    if (sess.interrupt_at) {
      outputLines.push(`\n  ${theme.label('Last Interrupt:')}`);
      outputLines.push(`    ${theme.label('Reason:')} ${sess.interrupt_reason ?? 'unknown'}`);
      if (sess.interrupt_exit_code !== null) {
        outputLines.push(`    ${theme.label('Exit Code:')} ${sess.interrupt_exit_code}`);
      }
      outputLines.push(`    ${theme.label('Time:')} ${theme.timestamp(formatDate(sess.interrupt_at))}`);
      outputLines.push(`    ${theme.label('Consecutive:')} ${sess.consecutive_interruptions}`);
      if (sess.auto_resumed) {
        outputLines.push(`    ${theme.label('Auto-resumed:')} yes`);
      }
      if (sess.user_stopped) {
        outputLines.push(`    ${theme.label('User-stopped:')} yes (reconciler will not auto-resume)`);
      }
      if (autoResumeQueue) {
        const eta = autoResumeQueue.nextEligibleAt <= Date.now() ? 'now' : describeExpiry(new Date(autoResumeQueue.nextEligibleAt));
        outputLines.push(
          `    ${theme.label('Slow-lane auto-resume:')} ${eta} (attempt ${autoResumeQueue.attempts + 1}/${autoResumeQueue.maxAttempts})`,
        );
        outputLines.push(`      ${dim(`Full queue: ${theme.command('lazy daemon resume-queue')}`)}`);
      }
      if (showFull && sess.interrupt_logs) {
        outputLines.push(`    ${theme.label('Logs (last 50 lines):')}`);
        for (const line of sess.interrupt_logs.split('\n').slice(0, 50)) {
          outputLines.push(`      ${line}`);
        }
      }
    }

    // Retry state (if currently retrying)
    if (retryStatus) {
      outputLines.push(`\n  Retry State:`);
      outputLines.push(`    Retry Count:    ${retryStatus.retryCount}`);
      if (retryStatus.failureClass) {
        outputLines.push(
          `    Failure:        ${retryStatus.failureClass}${retryStatus.failureReason ? ` — ${retryStatus.failureReason}` : ''}`,
        );
      }
      if (retryStatus.nextDelayMs !== undefined) {
        outputLines.push(`    Next Attempt:   in ${Math.round(retryStatus.nextDelayMs / 1000)}s`);
      }
      if (retryStatus.errors.length > 0) {
        outputLines.push(`    Error Log (deduplicated, last 10):`);
        for (const err of retryStatus.errors) {
          outputLines.push(`      - [${err.count}x] ${err.message}`);
          outputLines.push(`        First: ${err.firstSeen}, Last: ${err.lastSeen}`);
        }
      }
    }

    // Auto-react budget status (if any auto-reacts have occurred or limits reached)
    if (autoReactStatus) {
      if (autoReactStatus.paused) {
        outputLines.push(`\n  ${theme.error('Auto-react paused:')} ${autoReactStatus.reason ?? 'limit reached'}`);
      } else {
        outputLines.push(`\n  ${theme.label('Auto-react counts:')}`);
      }
      const triggerLabels: Record<string, string> = {
        ci_failure: 'CI failures',
        upstream_sync: 'Upstream syncs',
        comment: 'Comments',
        crash: 'Crashes',
      };
      for (const [trigger, count] of Object.entries(autoReactStatus.counts)) {
        if (count > 0) {
          outputLines.push(`    ${theme.label(triggerLabels[trigger] + ':')} ${count}`);
        }
      }
      if (autoReactStatus.consecutiveAutoTurns > 0) {
        outputLines.push(`    ${theme.label('Consecutive auto-turns (current burst):')} ${autoReactStatus.consecutiveAutoTurns}`);
      }
    }

    // Turns
    if (turns.length > 0) {
      // Render one turn's lines (identical in flat and chunked modes). Provenance
      // — the authoring actor for non-human human-role turns, and the `auto` flag
      // — is surfaced in the header so a reviewer can tell a real human/builder
      // turn from an automation turn.
      const renderTurn = (turn: typeof turns[number]) => {
        const turnBody = turnText(turn);
        const isErrorTurn = turn.role === 'agent' && turnBody.startsWith('[Agent crashed]');
        const usageSuffix = turn.usage
          ? ` | ${formatTokenCount(totalInputTokens(turn.usage))} in, ${formatTokenCount(turn.usage.outputTokens)} out`
          : '';
        // Per-turn launch labels: which agent, model and effort this turn ran
        // under, always all three, `unknown` for anything the turn does not
        // carry. Built by the shared formatter so `lazy show`, `lazy review` and
        // the web UI agree; an absent field is never filled in from the task's
        // current setting (see src/utils/turn-labels.ts).
        // A turn lazy wrote itself (supervisor nudge, [system] notice) ran no
        // agent and gets no labels at all — see turnRanNoAgent.
        const launchSegment = formatTurnLaunchLabels(turn);
        const launchLabels: string[] = launchSegment ? [launchSegment] : [];
        // What the agent reported about its own lazy tools at session start.
        // Printed only when it is NEWS — i.e. the turn ran with no lazy tools —
        // since the healthy case is every turn and would be pure noise. Absent
        // (older turns, agents that report nothing) prints nothing at all.
        if (turn.mcp_tools && / tools=0$/.test(turn.mcp_tools)) {
          launchLabels.push(theme.error(`no lazy tools (${turn.mcp_tools})`));
        }
        const modelSuffix = launchLabels.length > 0 ? ` | ${launchLabels.join(' | ')}` : '';
        const checkSuffix = turn.check_exit_code !== undefined
          ? (turn.check_exit_code === 0
            ? ` | ${theme.status('check: OK')}`
            : ` | ${theme.error(`check: FAILED (exit ${turn.check_exit_code})`)}`)
          : '';
        const autoSuffix = turn.auto_triggered ? ` | ${theme.warning('auto')}` : '';
        // Show the author for human-role turns authored by a non-human actor
        // (e.g. 'supervisor' for push-back/maintain prompts, 'builder' for MCP),
        // so the reader can tell "the human said" from "the supervisor pushed back".
        const authorLabel = turn.role === 'human' && turn.actor && turn.actor !== 'human'
          ? turn.actor
          : turn.role;
        const roleDisplay = isErrorTurn ? theme.error('crash') : theme.turnRole(authorLabel);
        if (showFull) {
          outputLines.push(`\n    --- Turn #${turn.sequence} [${roleDisplay}]${usageSuffix}${modelSuffix}${checkSuffix}${autoSuffix} ---`);
          if (isErrorTurn) {
            for (const line of turnBody.split('\n')) {
              outputLines.push(`    ${theme.error(line)}`);
            }
          } else {
            // For human turns with a full prompt, show the prompt (what agent saw)
            if (turn.role === 'human' && turn.prompt) {
              outputLines.push(`\n    ${theme.label('--- Full prompt sent to agent ---')}\n`);
              outputLines.push(turn.prompt);
            } else {
              outputLines.push(turnBody);
            }
          }
          // Show check output in full view
          if (turn.check_output) {
            outputLines.push(`\n    ${theme.label('--- Post-turn check output ---')}`);
            for (const line of turn.check_output.split('\n')) {
              outputLines.push(`    ${line}`);
            }
          }
        } else {
          const preview = turnBody.substring(0, 80).replace(/\n/g, ' ');
          if (isErrorTurn) {
            outputLines.push(`    #${turn.sequence} [${roleDisplay}]${usageSuffix}${modelSuffix}${checkSuffix}${autoSuffix} ${theme.error(preview)}${turnBody.length > 80 ? '...' : ''}`);
          } else {
            outputLines.push(`    #${turn.sequence} [${theme.turnRole(authorLabel)}]${usageSuffix}${modelSuffix}${checkSuffix}${autoSuffix} ${preview}${turnBody.length > 80 ? '...' : ''}`);
          }
        }
      };

      const autoTriggeredCount = turns.filter(t => t.auto_triggered).length;
      const humanTriggeredCount = turns.length - autoTriggeredCount;
      const turnSummary = autoTriggeredCount > 0
        ? `${theme.count(String(turns.length))} total (${humanTriggeredCount} human, ${autoTriggeredCount} auto)`
        : theme.count(String(turns.length));

      if (showChunks) {
        // Group by review boundary using the single source of truth. Each chunk
        // header names its boundary turn (or "(no boundary)" for the leading
        // automation-only chunk) so the grouping is legible.
        const chunks = groupTurnsIntoChunks(turns);
        outputLines.push(`\n  ${theme.label('Turns (chunked):')} ${turnSummary} in ${theme.count(String(chunks.length))} chunk${chunks.length === 1 ? '' : 's'}`);
        for (const chunk of chunks) {
          const b = chunk.boundary;
          const boundaryDesc = b
            ? `#${b.sequence} [${b.role === 'human' && b.actor && b.actor !== 'human' ? b.actor : b.role}]`
            : '(no boundary — leading automation turns)';
          outputLines.push(`\n  ${theme.separator('━')} ${theme.label(`Chunk ${chunk.index + 1}`)} ${dim(boundaryDesc)} ${dim(`(${chunk.turns.length} turn${chunk.turns.length === 1 ? '' : 's'})`)}`);
          for (const turn of chunk.turns) {
            renderTurn(turn);
          }
        }
      } else {
        outputLines.push(`\n  ${theme.label('Turns:')} ${turnSummary}`);
        for (const turn of turns) {
          renderTurn(turn);
        }
      }
    }

    // Commits
    if (commits.length > 0) {
      outputLines.push(`\n  ${theme.label('Commits:')} ${theme.count(String(commits.length))}`);
      for (const c of commits) {
        outputLines.push(`    ${theme.commitSha(c.sha.substring(0, 8))} [${theme.status(c.status)}] ${c.message}`);
      }
    }
  } else {
    outputLines.push(`\n${theme.label('Session:')} (not started)`);
    outputLines.push(`  Start with: ${theme.command('lazy start ' + displayId(task))}`);
  }

  // Children (variants)
  if (children.length > 0) {
    outputLines.push(`\n${theme.label('Child Tasks (variants):')} ${theme.count(String(children.length))}`);
    for (const child of children) {
      const childSess = childSessions.get(child.id) ?? null;
      const childStatus = childSess
        ? (childSess.outcome ?? (childSess.ended_at ? 'ended' : child.status))
        : child.status;
      outputLines.push(`  ${theme.taskId(displayId(child))} [${theme.status(childStatus)}] ${child.goal}`);
    }
  }

  // Comments
  if (comments.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Comments (${comments.length})`)} ${theme.separator('---')}`);

    for (const comment of comments) {
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(comment.created_at))}]`);
        const lines = comment.content.split('\n');
        for (const line of lines) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = comment.content.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(comment.created_at))}] ${preview}${comment.content.length > 80 ? '...' : ''}`);
      }
    }
  }

  // Journal (append-only, prompt-immune side channel — separate from Comments)
  if (journal.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Journal (${journal.length})`)} ${theme.separator('---')}`);

    for (const entry of journal) {
      const who = entry.actor ? ` ${theme.label(entry.actor)}` : '';
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(entry.created_at))}]${who}`);
        for (const line of entry.content.split('\n')) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = entry.content.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(entry.created_at))}]${who} ${preview}${entry.content.length > 80 ? '...' : ''}`);
      }
    }
  }

  // Follow-ups (orthogonal-work discoveries recorded by the agent; for triage)
  if (followUps.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Follow-ups (${followUps.length})`)} ${theme.separator('---')}`);

    for (const f of followUps) {
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(f.created_at))}]`);
        for (const line of f.content.split('\n')) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = f.content.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(f.created_at))}] ${preview}${f.content.length > 80 ? '...' : ''}`);
      }
    }
  }

  // Status History (audit trail of status transitions)
  if (statusHistory.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Status History (${statusHistory.length})`)} ${theme.separator('---')}`);
    let prev: string | null = null;
    for (const change of statusHistory) {
      const transition = prev === null
        ? theme.status(change.status)
        : `${theme.status(prev)} → ${theme.status(change.status)}`;
      const actor = change.actor ? ` ${theme.label('by')} ${change.actor}` : '';
      outputLines.push(`  [${theme.timestamp(formatDate(change.timestamp))}] ${transition}${actor}`);
      prev = change.status;
    }
  }

  // Tag History (append-only audit trail of every tag/untag, actor-attributed)
  if (tagHistory.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Tag History (${tagHistory.length})`)} ${theme.separator('---')}`);
    for (const event of tagHistory) {
      const verb = event.action === 'tag' ? theme.success('tagged') : theme.warning('untagged');
      const actor = event.actor ? ` ${theme.label('by')} ${event.actor}` : '';
      outputLines.push(`  [${theme.timestamp(formatDate(event.timestamp))}] ${verb} ${theme.tag('#' + event.tag)}${actor}`);
    }
  }

  // Prompt
  if (task.prompt) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label('Prompt')} ${theme.separator('---')}`);
    outputLines.push(task.prompt);
  } else {
    outputLines.push('\n  (no prompt yet)');
  }

  return outputLines;
}

export async function commandShow(args: string[], invokedAs = 'show'): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'full', takesValue: false },
    { name: 'lines', takesValue: true },
    { name: 'json', takesValue: false },
    { name: 'chunks', takesValue: false },
    { name: 'flat', takesValue: false },
  ], invokedAs);

  const taskId = parsed.positional[0];
  if (!taskId) {
    showUsage();
    process.exit(1);
  }

  // Parse line range if specified
  let lineRange = null;
  const linesValue = parsed.flags.get('lines') as string | undefined;
  if (linesValue !== undefined) {
    lineRange = parseLineRange(linesValue);
    if (!lineRange) {
      console.error(`Invalid line range: ${linesValue}. Format: N..M, N.., or ..M`);
      process.exit(1);
    }
  }

  const jsonOutput = parsed.flags.get('json') === true;

  // Handle built-in prompt codes (lazy-prompt-* prefix)
  if (isBuiltinPromptCode(taskId)) {
    const content = await readBuiltinPrompt(taskId);
    if (!content) {
      // Show available prompts to help the user
      const available = (await listBuiltinPrompts()).map(p => p.code);
      console.error(`No built-in system prompt found for '${taskId}'.`);
      console.error(`\nAvailable prompts: ${available.join(', ')}`);
      console.error(`\nRun ${theme.command('lazy system prompts')} to see all built-in system prompts.`);
      process.exit(1);
    }

    if (jsonOutput) {
      const prompts = await listBuiltinPrompts();
      const meta = prompts.find(p => p.code === taskId);
      console.log(JSON.stringify({
        type: 'prompt',
        code: taskId,
        filename: meta?.filename ?? null,
        content,
      }));
      return;
    }

    // Find the prompt metadata for display
    const prompts = await listBuiltinPrompts();
    const meta = prompts.find(p => p.code === taskId);

    const outputLines: string[] = [];
    outputLines.push(`${theme.label('Prompt')} ${theme.taskId(taskId)}`);
    if (meta) {
      outputLines.push(`  ${theme.label('File:')} ${meta.filename}`);
    }
    outputLines.push(`  ${theme.label('Size:')} ${content.length} chars, ${content.split('\n').length} lines`);
    outputLines.push(`\n${theme.separator('─'.repeat(60))}\n`);
    outputLines.push(content);

    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  const showFull = parsed.flags.get('full') === true;
  // Turn grouping default depends on the invoked name: `lazy view` groups turns
  // into review chunks by default (parity with `lazy review`, which groups by
  // default), while the canonical `lazy show` stays flat by default so scripts
  // reading its text output are undisturbed. `--chunks`/`--flat` force either
  // mode explicitly on both; `--flat` wins if both are somehow passed.
  const chunkedByDefault = invokedAs === 'view';
  const showChunks = parsed.flags.get('flat') === true
    ? false
    : parsed.flags.get('chunks') === true
      ? true
      : chunkedByDefault;

  // Resolve as a task via daemon RPC
  const showResult = await queryTaskShow(taskId);

  if (showResult && !showResult.ambiguous) {
    const data = showResult.data;

    if (jsonOutput) {
      const jsonData = buildShowJson(data);
      console.log(JSON.stringify(jsonData));
      return;
    }

    const outputLines = buildTaskShowLines(data, showFull, showChunks);
    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  if (showResult?.ambiguous) {
    // Build formatted options for each task
    const options: string[] = [];
    for (const t of showResult.matches) {
      // Same columns as resolveTaskOrExit (src/cli/helpers.ts): the timestamp is
      // what actually distinguishes two same-code tasks for a human, so `show`
      // must not drop it while every other command shows it.
      const paddedStatus = t.status.padEnd(12);
      options.push(`${shortId(t.id)}  ${paddedStatus}  ${formatDate(t.lastInteractionAt)}  ${t.goal}`);
    }


    // In TTY mode, offer interactive choice
    if (isTTY()) {
      const choice = await promptChoice(`Multiple tasks match code '${taskId}'. Choose one:`, options);
      const selectedMatch = showResult.matches[choice];

      // Re-query with the full ID to get the task data
      const resolved = await queryTaskShow(selectedMatch.id);
      if (resolved && !resolved.ambiguous) {
        if (jsonOutput) {
          const jsonData = buildShowJson(resolved.data);
          console.log(JSON.stringify(jsonData));
          return;
        }

        const outputLines = buildTaskShowLines(resolved.data, showFull, showChunks);
        let output = outputLines.join('\n');
        if (lineRange) {
          output = sliceLines(output, lineRange);
        }
        console.log(output);
        return;
      }
    }

    // In non-TTY mode, print error and exit
    console.error(`Multiple tasks match code '${taskId}'. Use the ID to disambiguate:`);
    for (const option of options) {
      console.error(`  ${option}`);
    }
    process.exit(1);
  }

  // Not a task — try conversation session ID, then file path
  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversations();
    // Prefer an exact session-ID match; otherwise accept a unique prefix, the
    // same way tasks resolve short IDs. A prefix matching more than one
    // conversation is ambiguous — error rather than silently picking the first.
    const exact = conversations.find(c => c.sessionId === taskId);
    const prefixMatches = conversations.filter(c => c.sessionId.startsWith(taskId));
    const convMatch = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);

    if (!convMatch && prefixMatches.length > 1) {
      console.error(`Multiple conversations match '${taskId}'. Use a longer prefix to disambiguate:`);
      for (const c of prefixMatches) {
        const firstUserMsg = c.messages.find(m => m.role === 'user');
        const firstLine = firstUserMsg ? firstUserMsg.text.split('\n')[0].substring(0, 60) : '(no prompt)';
        console.error(`  ${c.sessionId.substring(0, 8)}  ${firstLine}`);
      }
      process.exit(1);
    }

    if (convMatch) {
      if (jsonOutput) {
        const conv = await storage.loadConversation(convMatch.sessionId);
        if (conv) {
          console.log(JSON.stringify({
            type: 'conversation',
            session_id: conv.sessionId,
            summary: conv.summary,
            git_branch: conv.gitBranch,
            started_at: conv.startedAt,
            ended_at: conv.endedAt,
            stats: conv.stats,
            total_usage: conv.totalUsage,
            messages: conv.messages.map(m => ({
              role: m.role,
              text: m.text,
              timestamp: m.timestamp,
              model: m.model,
              usage: m.usage,
            })),
          }));
        }
        return;
      }
      await showConversationTranscript(storage, convMatch.sessionId, lineRange);
      return;
    }
  } finally {
    await storage.close();
  }

  // Try as a file path
  if (existsSync(taskId)) {
    // JSON output for files
    if (jsonOutput) {
      const content = readFileSync(taskId, 'utf-8');
      console.log(JSON.stringify({
        type: 'file',
        path: taskId,
        content,
        size: content.length,
        lines: content.split('\n').length,
      }));
      return;
    }

    // Line range output for files
    if (lineRange) {
      const content = readFileSync(taskId, 'utf-8');
      const output = sliceLines(content, lineRange);
      console.log(output);
      return;
    }

    // Launch full-screen TUI viewer
    await showFileViewer(taskId);
    return;
  }

  console.error(`No task, conversation, or file found matching '${taskId}'`);
  process.exit(1);
}

/** Build the JSON output structure from TaskShowData. Used by both direct and daemon paths. */
function buildShowJson(data: TaskShowData): Record<string, unknown> {
  const { task, session: sess, turns, commits, comments, journal, followUps, children, retryStatus, autoReactStatus, mergeState } = data;

  const jsonData: Record<string, unknown> = {
    id: task.id,
    code: task.code,
    goal: task.goal,
    status: task.status,
    type: task.type ?? 'task',
    priority: task.priority ?? 'normal',
    model: task.model,
    agent_id: task.agent_id,
    prompt: task.prompt || null,
    created_at: task.created_at,
    completed_at: task.completed_at,
    close_reason: task.close_reason,
    parent_task_id: parentTaskIdOf(task),
    branched_from_sha: task.branched_from_sha,
    metadata: task.metadata,
    session: sess ? {
      id: sess.id,
      agent_id: sess.agent_id,
      status: sess.outcome ?? (sess.ended_at ? 'ended' : task.status),
      git_branch: sess.git_branch,
      git_start_sha: sess.git_start_sha,
      started_at: sess.started_at,
      ended_at: sess.ended_at,
      last_interaction_at: sess.last_interaction_at,
      total_duration_ms: sess.total_duration_ms,
      total_usage: sess.total_usage,
      consecutive_interruptions: sess.consecutive_interruptions,
      auto_resumed: sess.auto_resumed,
    } : null,
    turns: turns.map(t => ({
      sequence: t.sequence,
      role: t.role,
      content: turnText(t),
      prompt: t.prompt ?? null,
      timestamp: t.timestamp,
      usage: t.usage,
      // Null means "unknown", never the task's current agent — turns written
      // before this field existed have no agent, and `lazy edit --agent` can
      // switch agents mid-task. See `Turn.agent`.
      agent: t.agent ?? null,
      model: t.model ?? null,
      // Null, not the alias, when the agent reported no concrete id — a consumer
      // labelling experiment arms must be able to tell "ran on this exact model"
      // from "we only ever knew the tier alias".
      model_id: t.model_id ?? null,
      effort: t.effort ?? null,
      // Null means "never observed" (older turn, or an agent that reports no
      // tool list) — deliberately distinct from an observed `tools=0`.
      mcp_tools: t.mcp_tools ?? null,
      auto_triggered: t.auto_triggered ?? false,
      ...(t.check_exit_code !== undefined ? { check_exit_code: t.check_exit_code } : {}),
      ...(t.check_output !== undefined ? { check_output: t.check_output } : {}),
    })),
    commits: commits.map(c => ({
      sha: c.sha,
      message: c.message,
      status: c.status,
      timestamp: c.timestamp,
    })),
    comments: comments.map(c => ({
      content: c.content,
      created_at: c.created_at,
    })),
    journal: journal.map(j => ({
      content: j.content,
      created_at: j.created_at,
      actor: j.actor ?? null,
    })),
    follow_ups: followUps.map(f => ({
      content: f.content,
      created_at: f.created_at,
      session_id: f.session_id ?? null,
    })),
    children: children.map(c => ({
      id: c.id,
      code: c.code,
      goal: c.goal,
      status: c.status,
    })),
  };

  if (retryStatus) {
    jsonData.retry_status = retryStatus;
  }

  if (autoReactStatus) {
    jsonData.auto_react_status = autoReactStatus;
  }

  // A scripted consumer must be able to see a stranded merge too — the text
  // output is not the only surface that used to lie (fix-sync-silent-conflict).
  if (mergeState && isMidMerge(mergeState)) {
    jsonData.merge_state = {
      merge_in_progress: mergeState.mergeInProgress,
      unmerged_files: mergeState.unmergedFiles,
      summary: describeMergeState(mergeState),
    };
  }

  return jsonData;
}

export function showUsage(): void {
  console.log(`Usage: lazy show|view <id> [--full] [--chunks] [--flat] [--lines N..M] [--json]

Show detailed information about a task, conversation, or file.

If given a task ID or task code, shows the task with its session, turns,
commits, comments, and any child tasks (variants).

If given a conversation session ID (or prefix), shows the full interleaved
conversation transcript.

If given a file path, renders the file in a scrollable TUI viewer.
Markdown files (.md) are rendered with formatting.

Also supports viewing built-in system prompts (lazy-prompt-*).

Arguments:
  <id>         Task ID, task code, conversation session ID, file path,
               or built-in prompt code

Turn grouping:
  'lazy view' groups turns into review chunks by default (parity with the
  'lazy review' TUI); the canonical 'lazy show' lists turns flat by default.
  Use --chunks or --flat to force either mode regardless of how it was invoked.

Options:
  --full       Show complete turn and comment content instead of truncated preview
  --chunks     Group turns into review chunks (one human/builder boundary plus its
               following agent/supervisor/system turns) instead of a flat list
  --flat       List turns flat (the default for 'lazy show'; overrides the chunked
               default of 'lazy view')
  --lines N..M Return only lines N through M of the output (1-indexed, inclusive)
               Formats: N..M (range), N.. (from N to end), ..M (start to M)
  --json       Output as structured JSON instead of human-readable text

Examples:
  lazy show abc12345                          # Show task by ID
  lazy show abc1                              # Prefix matching works
  lazy show abc1 --full                       # Show full turn and comment content
  lazy show abc1 --chunks                     # Group turns by human/builder review boundary
  lazy view abc1                              # Turns grouped into chunks by default
  lazy view abc1 --flat                       # Force the flat turn list
  lazy show abc1 --lines 10..20               # Show only lines 10-20 of output
  lazy show abc1 --lines 50..                 # Show from line 50 to end
  lazy show abc1 --json                       # Output task as JSON
  lazy show dddddddd                          # Show conversation by session ID prefix
  lazy show dddddddd --lines 1..100           # Show first 100 lines of conversation
  lazy show lazy-prompt-system-instructions   # View a built-in system prompt
  lazy show README.md                         # View a file in scrollable TUI
  lazy show src/index.ts                      # View a TypeScript file
  lazy show CLAUDE.md --lines 1..50           # Show first 50 lines of file`)
}
