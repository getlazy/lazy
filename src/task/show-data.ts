/**
 * Everything `lazy show` needs about one task, loaded once.
 *
 * The shape and the loading are domain work — the daemon's `show` RPC serves it
 * to the web review surface, Teams and `lazy_show` over MCP, and the CLI is one
 * more consumer that happens to render it as text. Rendering stays in
 * `src/cli/commands/show.ts`; what to load lives here.
 */

import { withPromotedTaskCodes } from './show-sections';
import { join } from 'path';
import { protocolDir as getProtocolDir, readStatus } from '../protocol';
import { createRunner } from '../runner';
import type { WorkingSubstate } from '../utils/working-substate';
import { computeTaskWorkingSubstate } from '../utils/working-run';
import { checkOrphanedChild, type OrphanCheckResult } from './orphan';
import type { Task, Session, Turn, Commit, Comment, JournalEntry, RaisedItem, TaskArtifact, TurnReport, FileDecision } from '../types';
import { TERMINAL_STATUSES } from '../types';
import type { StatusChange, TagEvent } from '../storage/types';
import type { SupervisorStatus } from '../protocol/types';
import type { AgentFailureClass } from '../agent/failure-taxonomy';
import { parentTaskIdOf } from '../task-target';
import { readWorktreeMergeState, type WorktreeMergeState } from '../git/operations';
import { shortId, taskRef, getWorktreePathForRef } from './identity';
import { pathExists } from '../utils/fs';
import { getTaskServeState, type TaskServeState } from '../serve/discovery';
import { primeDashboardAuthority } from '../serve/authority';
import type { Storage } from '../storage/interface';
import { getAutoReactSummary, type AutoReactTrigger } from '../daemon/auto-react-budget';
import { logger } from '../utils/logger';
import { loadConfig } from '../config/loader';
import type { ReviewSettingsView } from '../review/mode';
import { getSlowLaneState, getLastProjectAutoResumeAt } from '../daemon/auto-resume-queue';
import { MAX_CONSECUTIVE_INTERRUPTIONS } from '../utils/auto-resume';
import {
  loadTaskProtectionStatus,
  type TaskProtectionStatus,
} from '../protection/status';

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
  /**
   * Everything the agent raised for a human. Blocking ones gate accept while
   * open; non-blocking ones are the orthogonal proposals that used to be
   * follow-ups (docs/design/raised-items-unified.md).
   */
  raisedItems: RaisedItem[];
  /** Structured end-of-turn report for the current session (null if none). */
  turnReport: TurnReport | null;
  /** Keep/skip reasons from lazy_justify_* (display-only). */
  fileDecisions: FileDecision[];
  /** Files attached to the task, and files it published back. Metadata only. */
  artifacts: TaskArtifact[];
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
  /** Declared [serve] ports and where they are reachable. Null when not resolvable. */
  serveState: TaskServeState | null;
  /**
   * Read-only branch-protection status (add-protection-surfacing): is this
   * task's accept gated, and does a captured builder review sit pending?
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
  /**
   * One-line upstream status from getTaskUpstreamStatus (no fetch). Optional
   * so search/line-number callers and fixtures that skip the RPC stay valid.
   */
  upstreamLine?: string | null;
  /**
   * The task's EFFECTIVE review settings, resolved daemon-side from what the
   * task pinned plus the project's `[review]`.
   *
   * Sent as the ANSWER rather than the rule: a client re-resolving inheritance
   * in another language is a second copy of a load-bearing decision, and the
   * one thing a reader wants here is "will a review gate my accept", not the
   * three inputs it came from. Optional so fixtures and the search path, which
   * skip the RPC, stay valid.
   *
   * `explanations` and `sources` are the same rule applied to the SECOND
   * question a `Review:` line raises — "why is it that, I never chose it" —
   * which is unanswerable from the values alone.
   */
  review?: ReviewSettingsView;
  /**
   * `[models] default` from the project-root config, when we could load it.
   * Used only to phrase the "actual model is older than requested suggests"
   * warning on turn lines — never as a fallback for an unrecorded turn model.
   */
  modelsDefault?: string;
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
        // The reconciler's own liveness question — see src/utils/working-run.ts.
        workingSubstate = await computeTaskWorkingSubstate(root, task, sess, await createRunner(root));
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

  // Declared [serve] ports and where they are reachable. Costs nothing for a
  // project with no [serve] section (getTaskServeState returns before touching
  // the runner), and one `docker port` call for one that has one.
  let serveState: TaskServeState | null = null;
  if (root && !TERMINAL_STATUSES.has(task.status)) {
    try {
      // Where the proxy answers, so the services can be named rather than
      // numbered. Never fatal — no daemon means no proxy either, and the
      // direct 127.0.0.1 URL is then both the fallback and the right answer.
      await primeDashboardAuthority(root);
      serveState = await getTaskServeState(root, task, sess ?? null);
    } catch (err) {
      logger.debug(`Task ${shortId(task.id)}: could not resolve [serve] ports: ${err instanceof Error ? err.message : err}`);
    }
  }

  const turns = sess ? await storage.getSessionTurns(sess.id) : [];
  const commits = sess ? await storage.getSessionCommits(sess.id) : [];
  const comments = await storage.getTaskComments(task.id);
  const journal = await storage.getTaskJournal(task.id);
  const raisedItems = await withPromotedTaskCodes(await storage.getTaskRaisedItems(task.id), (id) => storage.getTask(id));
  const turnReport = sess
    ? (await storage.getTurnReportBySession(task.id, sess.id))
    : null;
  const fileDecisions = await storage.getTaskFileDecisions(task.id);
  const artifacts = await storage.listTaskArtifacts(task.id);
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
  let modelsDefault: string | undefined;
  if (root) {
    try {
      const config = await loadConfig(root);
      modelsDefault = config.models.default?.trim() || undefined;
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

  return { task, session: sess, turns, commits, comments, journal, raisedItems, turnReport, fileDecisions, artifacts, statusHistory, tagHistory, children, childSessions, parent, retryStatus, orphanStatus, autoReactStatus, supervisorStatus, workingSubstate, mergeState, serveState, protection, autoResumeQueue, modelsDefault };
}
