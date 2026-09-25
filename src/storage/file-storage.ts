/**
 * File-based storage implementation
 *
 * Stores all data as JSON files in a directory structure:
 *   <datadir>/
 *     version.json
 *     tasks/
 *       <task-id>/
 *         task.json
 *         session.json
 *         turns.json
 *         commits.json
 *         prompt-history.json
 *         snapshots.json
 *         reviews.json
 *         comments.json
 *     conversations/
 *       <sessionId>.json
 *     conversations-index.json  (derived listing metadata; rebuildable)
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat, unlink } from 'fs/promises';
import type { Dirent } from 'fs';
import { join } from 'path';
import type { Storage, CreateTurnOptions } from './interface';
import {
  mergeUsageLimitReading,
  readStoredUsageLimitReading,
  UsageLimitReadingsUnreadableError,
  validateStoredUsageLimitReading,
} from './usage-limit-readings';
import { BuilderSessionActiveError, BuilderSessionStateConflictError } from './interface';
import { normalizeTurnContent, normalizeRecordContent, repairRecordContents } from '../utils/turn-content';
import type { SpanRecord } from '../tracing/types';
import { appendSpansJsonl, readSpansJsonl } from './trace-spans';
import {
  appendWaitStartJsonl,
  appendWaitEndJsonl,
  readWaitIntervalsJsonl,
  type WaitIntervalStart,
  type WaitIntervalFilter,
} from './wait-intervals';
import { getDataDir } from '../project-paths';
import { assertArtifactWithinLimits } from '../artifacts/limits';
import { normalizeArtifactName, guessMimeType, isBinaryContent } from '../artifacts/name';
import {
  normalizeTurnReportSections,
  normalizeFileDecisionScope,
  normalizeFileDecisionReason,
  normalizeFileDecisionTarget,
} from './turn-report';
import {
  normalizeReviewPresentation,
  assertNoWholeFileClaimTwice,
  assignPresentationGroupIds,
} from './presentation';
import type {
  Task,
  Session,
  Turn,
  MergeConflict,
  FileViolation,
  ReviewReport,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  ActorIdentityMigrationResult,
  FollowUpMigrationResult,
  RaisedItem,
  RaisedItemComment,
  RaisedItemInput,
  RaisedItemResolveAction,
  TurnReport,
  TurnReportInput,
  FileDecision,
  FileDecisionInput,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnOwner,
  TurnRole,
  InFlightTurn,
  InFlightTurnOutcome,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  TaskCodeEntry,
  StorageVersion,
  SearchResult,
  StoredConversation,
  ConversationSummary,
  AgentSessionLog,
  BuilderResumeIntent,
  BuilderSession,
  BuilderSessionUpdate,
  ProjectSettings,
  TurnsFile,
  CommitsFile,
  PromptHistoryFile,
  SnapshotsFile,
  ReviewsFile,
  CommentsFile,
  JournalEntry,
  JournalFile,
  RaisedItemsFile,
  TurnReportsFile,
  FileDecisionsFile,
  TaskArtifact,
  TaskArtifactContent,
  TaskArtifactInput,
  TaskToolStatsRecord,
  StoredUsageLimitReading,
  ArtifactsFile,
  RegionCoverFile,
  RegionOverlaysFile,
  HunkApprovalsFile,
  StatusChange,
  StatusChangelogFile,
  Actor,
  TagEvent,
  TagHistoryFile,
  MemoryRecord,
  MemoryEvent,
  MemoryWriteInput,
  MemoriesFile,
  MemoryHistoryFile,
  ScratchFilesFile,
  MemoryCompact,
  MemoryCompactInput,
  ScratchFile,
  ScratchFileInput,
  MemoryCompactFile,
  SystemMessage,
  SystemMessageInput,
  SystemMessagesFile,
  CommentSource,
  CommentCreateOptions,
  CommentUpdate,
  HunkApproval,
  HunkApprovalLineage,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  ReviewCommentsFile,
  ReviewSession,
  ReviewSessionMessage,
  ReviewSessionMessageInput,
  ReviewSessionMessageUpdate,
  ReviewSessionUpdate,
  ReviewSessionFile,
  ReviewDraftState,
  ReviewDraftPatch,
  ReviewDraftsFile,
} from './types';
import { isTerminalStatus, isBlockedStatus, raisedStatusForAction, LEGACY_CLUSTER_TASK_TYPE } from '../types';
import { emptyReviewDraft, MAX_LINE_DRAFTS, MAX_VIEWED_FILES } from '../review-draft';
import { normalizeTagOrThrow } from '../utils/tags';
import { targetFromLegacy, parentTaskIdOf } from '../task-target';
import { logger } from '../utils/logger';
import type { TaskTarget, WaitInterval, WaitOutcome } from '../types';
import type { OverlayActor, RegionCover, RegionOverlay } from '../regions';
import type { RunnerType } from '../config/types';
import { assertValidTransition } from '../task-state-machine';
import { assertScratchFileWithinCap } from '../builder/scratch-limits';
import { raisedSearchText } from '../raised/content';
import { repairStoredRaisedItem } from '../raised/migrate';
import type { LegacyFollowUpsFile } from '../raised/legacy-view';
import { BoundedTextMatcher } from '../search/text-matcher';
import { entityTimeFromIso } from '../search/ranking';
import { actorEmail, actorFields, actorName, actorRole, personFieldsAs } from '../actor-ref';
import type { ActorInput } from '../types';
import { StorageLock } from '../utils/storage-lock';
import { TaskMutex } from '../utils/task-mutex';

const STORAGE_VERSION = 1;

/**
 * Derived listing index for stored conversations. Filename is at the store
 * root, never inside `conversations/`, so a directory scan of transcripts
 * cannot pick it up as a conversation. Bump `version` if the entry shape
 * changes — an unknown version is treated as missing and rebuilt.
 */
const CONVERSATION_INDEX_VERSION = 1 as const;
const CONVERSATION_INDEX_FILENAME = 'conversations-index.json';

/** Per-task durable tool statistics, one small file in the task's directory. */
const TOOL_STATS_FILENAME = 'tool-stats.json';

interface ConversationTranscriptFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

interface ConversationIndexEntry extends ConversationSummary {
  mtimeMs: number;
  size: number;
}

interface ConversationIndexFile {
  version: typeof CONVERSATION_INDEX_VERSION;
  entries: ConversationIndexEntry[];
}

/**
 * Drop the PRE-IDENTITY decision-attribution keys off a raised-item record.
 *
 * Before the store named people as git does, a decision carried
 * `resolved_by_user_id` / `unresolved_by_user_id`. A re-decision that deletes
 * only today's spellings leaves those standing on a record whose own code
 * promises the previous decider is gone — so an unattributed caller's decision
 * would still read as the last person's, which is exactly the inheritance those
 * deletes exist to prevent.
 *
 * Rewriting the values that are already stored is a migration's job; NOT
 * writing one back out is this code's, and it costs two deletes.
 */
function dropLegacyDecisionPerson(row: RaisedItem): void {
  const legacy = row as unknown as Record<string, unknown>;
  delete legacy.resolved_by_user_id;
  delete legacy.unresolved_by_user_id;
}

function isConversationTranscriptFilename(name: string): boolean {
  return name.endsWith('.json') && name !== CONVERSATION_INDEX_FILENAME;
}

function conversationSummaryOf(conv: StoredConversation): ConversationSummary {
  return {
    sessionId: conv.sessionId,
    startedAt: conv.startedAt,
    endedAt: conv.endedAt,
    importedAt: conv.importedAt,
    summary: conv.summary,
    gitBranch: conv.gitBranch,
    stats: conv.stats,
  };
}

function toIndexEntry(
  conv: StoredConversation,
  file: Pick<ConversationTranscriptFile, 'mtimeMs' | 'size'>,
): ConversationIndexEntry {
  return {
    ...conversationSummaryOf(conv),
    mtimeMs: file.mtimeMs,
    size: file.size,
  };
}

function indexEntryToSummary(entry: ConversationIndexEntry): ConversationSummary {
  return {
    sessionId: entry.sessionId,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    importedAt: entry.importedAt,
    summary: entry.summary,
    gitBranch: entry.gitBranch,
    stats: entry.stats,
  };
}

function sortByStartedAtDesc<T extends { startedAt: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

function conversationIndexMatches(
  index: ConversationIndexFile,
  files: ConversationTranscriptFile[],
): boolean {
  if (index.version !== CONVERSATION_INDEX_VERSION) return false;
  if (index.entries.length !== files.length) return false;
  const byId = new Map(index.entries.map((e) => [e.sessionId, e]));
  for (const file of files) {
    const entry = byId.get(file.sessionId);
    if (!entry) return false;
    if (entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) return false;
  }
  return true;
}

/** Canonical UUID shape (8-4-4-4-12 hex), as produced by randomUUID() for task ids. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Legacy model aliases → current names (removed in remove-model-aliases) */
const LEGACY_MODEL_MAP: Record<string, string> = {
  apprentice: 'haiku',
  journeyman: 'sonnet',
  master: 'opus',
};

/**
 * In-memory indexes over the task store, holding IDENTITY ONLY — ids, and the
 * code that is a task's other name. Never task or session CONTENT: every read
 * still loads the JSON it returns from disk, so a task whose fields changed
 * (status, goal, prompt, …) can never be served stale. Only four facts are
 * cached, and each has exactly one writer:
 *
 *   - a task's parent   → changed only by createTask / updateTaskTarget
 *   - a task's code     → changed only by createTask / updateTaskCode
 *   - a task's session  → changed only by createSession (session.json is a
 *                         single object per task; every other session write
 *                         preserves its `id`)
 *   - the set of tasks  → reconciled from a readdir on every index use
 *
 * The self-healing read path in listTasksWithOptions rewrites `status` and
 * `completed_at` only, and readTask's migrations rewrite fields that are not
 * indexed either, so neither can leave an index stale.
 *
 * The code map narrows lookups; it never decides them. Resolving a code still
 * reads the candidate task.json files, so the disambiguation rules
 * (non-terminal wins, most recently created among terminals) run on fresh
 * status and created_at — the index only says which files to open.
 */
interface TaskStoreIndex {
  /** task id → parent task id (null for a root task) */
  parentOf: Map<string, string | null>;
  /** parent task id → child task ids */
  childrenOf: Map<string, Set<string>>;
  /** task id → its code (null when the task has none) */
  codeOf: Map<string, string | null>;
  /** code → the task ids carrying it (more than one after a code is reused) */
  idsByCode: Map<string, Set<string>>;
  /** session id → owning task id */
  sessionToTask: Map<string, string>;
  /** task id → its current session id */
  taskToSession: Map<string, string>;
}

export interface FileStorageOptions {
  /** Override the base path instead of computing from lazyRoot + dataDir */
  basePath?: string;
  /**
   * Fail an operation after this long waiting for the storage lock instead of
   * running the default retry loop. Only for read-only diagnostics that must
   * not block (`lazy doctor`) — see StorageLockOptions.
   */
  lockTimeoutMs?: number;
}

/** The fields `search()` reads out of a stored conversation file. */
interface SearchableConversationFile {
  sessionId: string;
  summary: string;
  /** endedAt as stored (ISO string), read for the summary row's recency. */
  endedAt?: string | null;
  /** importedAt (unix ms), the fallback recency signal for the summary row. */
  importedAt?: number;
  messages: Array<{ text: string; role: string; timestamp?: string }>;
}

/**
 * Thrown by `createBuilderSession` when the member already has an active
 * (non-`ended`) session for the same project: ONE SESSION PER MEMBER PER
 * PROJECT (§5.7), enforced at write time inside the storage lock — see the
 * interface contract on createBuilderSession and BuilderSessionActiveError.
 */
export class FileStorage implements Storage {
  private readonly basePath: string;
  private readonly tasksPath: string;
  private readonly lock: StorageLock;
  private readonly taskMutex = new TaskMutex();
  /** Built lazily on first use; see TaskStoreIndex for what it may hold. */
  private taskIndex: TaskStoreIndex | null = null;
  /** In-flight build, so concurrent callers share one full scan. */
  private indexBuild: Promise<TaskStoreIndex> | null = null;

  constructor(lazyRoot: string, options?: FileStorageOptions) {
    this.basePath = options?.basePath ?? join(lazyRoot, getDataDir(lazyRoot));
    this.tasksPath = join(this.basePath, 'tasks');
    this.lock = new StorageLock(lazyRoot, options?.basePath, {
      acquireTimeoutMs: options?.lockTimeoutMs,
    });
  }

  // --- Path accessors ---

  getStoragePath(): string {
    return this.basePath;
  }

  getTaskDir(taskId: string): string {
    return join(this.tasksPath, taskId);
  }

  // --- Private Helpers ---

  /**
   * Migrate a legacy ISO-string timestamp to a unix millisecond number.
   * If the value is already a number, return it as-is.
   * Handles the custom "YYYY-MM-DD HH:MM:SS" format (no timezone) by appending 'Z'.
   */
  private static migrateTimestamp(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      let str = value;
      // Handle "YYYY-MM-DD HH:MM:SS" format (no 'T', no 'Z')
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
        str = str.replace(' ', 'T') + 'Z';
      }
      const ms = new Date(str).getTime();
      if (!isNaN(ms)) return ms;
    }
    // Fallback: return current time if value is unrecognized
    return Date.now();
  }

  /**
   * Migrate timestamp fields in an array of records.
   * Mutates records in-place; returns true if any field was migrated.
   */
  private migrateTimestampFields(
    records: Record<string, unknown>[],
    fields: string[]
  ): boolean {
    let migrated = false;
    for (const record of records) {
      for (const field of fields) {
        if (record[field] !== undefined && record[field] !== null && typeof record[field] !== 'number') {
          record[field] = FileStorage.migrateTimestamp(record[field]);
          migrated = true;
        }
      }
    }
    return migrated;
  }

  private taskDir(taskId: string): string {
    return join(this.tasksPath, taskId);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /**
   * Read and normalize a task.json, handling legacy fields.
   * Persists migrations back to disk on first read (self-healing).
   */
  private async readTask(path: string): Promise<Task | null> {
    const raw = await this.readJson<Record<string, unknown>>(path);
    if (!raw) return null;

    let needsWrite = false;

    // Handle legacy 'title' -> 'goal' migration
    if (!raw.goal && raw.title) {
      raw.goal = raw.title;
      delete raw.title;
      needsWrite = true;
    }

    // Ensure model field exists
    if (raw.model === undefined) {
      raw.model = null;
      needsWrite = true;
    }

    // Ensure code field exists
    if (raw.code === undefined) {
      raw.code = null;
      needsWrite = true;
    }

    // Ensure metadata field exists
    if (raw.metadata === undefined) {
      raw.metadata = null;
      needsWrite = true;
    }

    // Ensure tags field exists (backward compat: tasks created before tagging
    // have no tags array — normalize to [] so no migration is needed)
    if (raw.tags === undefined || raw.tags === null) {
      raw.tags = [];
      needsWrite = true;
    }

    // Ensure type field exists (defaults to 'task')
    if (raw.type === undefined) {
      raw.type = 'task';
      needsWrite = true;
    }

    // Legacy: drop the removed priority field, and normalize the removed
    // 'queued' status (both retired with the agent concurrency cap —
    // remove-reaper-cap-sweep). A formerly-queued task returns to 'backlog';
    // the user re-starts it.
    if (raw.priority !== undefined) {
      delete raw.priority;
      needsWrite = true;
    }
    if (raw.status === 'queued') {
      raw.status = 'backlog';
      needsWrite = true;
    }

    // Ensure agent_id field exists (defaults to 'claude-code' for backward compat)
    if (raw.agent_id === undefined) {
      raw.agent_id = 'claude-code';
      needsWrite = true;
    }

    // Ensure runner_type field exists (null = inherit global [runner] type)
    if (raw.runner_type === undefined) {
      raw.runner_type = null;
      needsWrite = true;
    }

    // Migrate legacy model aliases to current names
    if (raw.model && LEGACY_MODEL_MAP[raw.model as string]) {
      raw.model = LEGACY_MODEL_MAP[raw.model as string];
      needsWrite = true;
    }

    // Ensure in_flight_turn exists (added for synchronous-turn correlation).
    // Absent means "no turn in flight" — never rewritten to disk on read, so a
    // task file only grows the field when something actually claims the slot.
    if (raw.in_flight_turn === undefined) {
      raw.in_flight_turn = null;
    }

    // Migrate pending_sync: boolean→number (false→0, true→1, undefined→0)
    if (raw.pending_sync === undefined || raw.pending_sync === false) {
      raw.pending_sync = 0;
      needsWrite = true;
    } else if (raw.pending_sync === true) {
      raw.pending_sync = 1;
      needsWrite = true;
    }

    // The `loop` task type was renamed `cluster` (2026-09-20, when the serial
    // one-running-child rule was dropped and the driver became free to schedule
    // its children concurrently). Read the old value as the new one so tasks
    // created under the old name keep their driver contract, their restart and
    // their fix-round budget.
    //
    // NO `needsWrite`: the alias alone never dirties a file, so a project that
    // only reads a legacy task leaves its bytes alone. That is NOT a guarantee
    // the stored value survives, and this comment must not be rewritten to say
    // it is — two review rounds were spent on exactly that claim. `readTask` is
    // the first step of every mutator (`updateTaskStatus`,
    // `updateTaskMetadata`, `updateTaskGoal` and their siblings all
    // re-serialise the object it returns), so the first status change,
    // watermark write or fix-round increment persists `cluster` — and for a
    // task anything is actually driving, that is within a tick.
    //
    // Which is fine. The migration is idempotent, nothing downstream of this
    // line ever compares against `loop`, and downgrading a live project to a
    // binary whose VALID_TASK_TYPES predates `cluster` is not a path lazy
    // supports. Pinned by test/unit/legacy-loop-task-type.test.ts, which
    // asserts the read-only case AND the post-mutator case.
    if (raw.type === LEGACY_CLUSTER_TASK_TYPE) {
      raw.type = 'cluster';
    }

    // Handle legacy 'draft' -> 'interrupted' migration
    // Draft tasks no longer exist; they're like a session that was started
    // but the container immediately crashed (no agent work done)
    if (raw.status === 'draft') {
      raw.status = 'interrupted';
      needsWrite = true;
    }

    // Handle legacy 'active' -> 'blocked' migration
    if (raw.status === 'active') {
      raw.status = 'blocked';
      needsWrite = true;
    }

    // Migrate 'closed' → 'abandoned' (unified abandon command)
    if (raw.status === 'closed') {
      raw.status = 'abandoned';
      needsWrite = true;
    }

    // Migrate timestamp fields from string to number
    if (raw.created_at !== undefined && raw.created_at !== null && typeof raw.created_at !== 'number') {
      raw.created_at = FileStorage.migrateTimestamp(raw.created_at);
      needsWrite = true;
    }
    if (raw.completed_at !== undefined && raw.completed_at !== null && typeof raw.completed_at !== 'number') {
      raw.completed_at = FileStorage.migrateTimestamp(raw.completed_at);
      needsWrite = true;
    }

    // Normalize the legacy (parent_task_id, metadata.remote_target_branch) pair
    // into the canonical `target` discriminated union. This is the ONE place
    // the legacy two-field shape is mapped (see src/task-target.ts). After
    // normalization `target` is the single source of truth: parent_task_id and
    // the metadata.remote_target_branch / github_pr_target_branch keys are no
    // longer read by anything (this READ is their last consumer), so they are
    // dropped from the canonical on-disk form on first load.
    if (raw.target === undefined || raw.target === null) {
      const legacyParent = (raw.parent_task_id as string | null | undefined) ?? null;
      const legacyBranch =
        (raw.metadata as Record<string, string> | null | undefined)?.remote_target_branch ?? null;
      raw.target = targetFromLegacy(legacyParent, legacyBranch) as unknown as Record<string, unknown>;
      needsWrite = true;
    }
    if ('parent_task_id' in raw) {
      delete raw.parent_task_id;
      needsWrite = true;
    }
    // Drop the dead legacy target keys from metadata once their value has been
    // folded into `target` above. Safe: nothing reads them anymore.
    const rawMeta = raw.metadata as Record<string, unknown> | null | undefined;
    if (rawMeta && ('remote_target_branch' in rawMeta || 'github_pr_target_branch' in rawMeta)) {
      delete rawMeta.remote_target_branch;
      delete rawMeta.github_pr_target_branch;
      needsWrite = true;
    }

    // Persist migrations back to disk so they only happen once
    if (needsWrite) {
      try {
        await this.writeJson(path, raw);
      } catch {
        // Best-effort: if we can't write, the in-memory migration still works
      }
    }

    return raw as unknown as Task;
  }

  /**
   * Read and normalize a session.json, handling missing container_name field
   */
  private async readSession(path: string): Promise<Session | null> {
    const raw = await this.readJson<Record<string, unknown>>(path);
    if (!raw) return null;

    let needsWrite = false;

    // Ensure container_name field exists (added for async execution)
    if (raw.container_name === undefined) {
      raw.container_name = null;
    }
    // Stamp for which agent profile the running container was launched —
    // absent on legacy sessions; agent-switch seeds it from the previous
    // profile so a first switch still forces recreate.
    if (raw.container_agent_id === undefined) {
      raw.container_agent_id = null;
    }

    // Ensure total_usage field exists (added for token tracking)
    if (raw.total_usage === undefined) {
      raw.total_usage = null;
    }

    // Ensure interrupt diagnostic fields exist (added for auto-resume)
    if (raw.interrupt_reason === undefined) {
      raw.interrupt_reason = null;
    }
    if (raw.interrupt_exit_code === undefined) {
      raw.interrupt_exit_code = null;
    }
    if (raw.interrupt_at === undefined) {
      raw.interrupt_at = null;
    }
    if (raw.interrupt_logs === undefined) {
      raw.interrupt_logs = null;
    }
    if (raw.consecutive_interruptions === undefined) {
      raw.consecutive_interruptions = 0;
    }
    if (raw.auto_resumed === undefined) {
      raw.auto_resumed = false;
    }
    if (raw.user_stopped === undefined) {
      raw.user_stopped = false;
    }
    // Ensure reserved_turn_sequence exists (added for turn-sequence reservation)
    if (raw.reserved_turn_sequence === undefined) {
      raw.reserved_turn_sequence = 0;
    }
    // Ensure runner_type field exists (null = legacy / no override → monitoring
    // falls back to global config.runner.type)
    if (raw.runner_type === undefined) {
      raw.runner_type = null;
    }

    // Migrate claude_session_id to agent_session_id (backward compat)
    if (raw.agent_session_id === undefined && raw.claude_session_id !== undefined) {
      raw.agent_session_id = raw.claude_session_id;
      delete raw.claude_session_id;
      needsWrite = true;
    }

    // Migrate timestamp fields from string to number
    if (raw.started_at !== undefined && raw.started_at !== null && typeof raw.started_at !== 'number') {
      raw.started_at = FileStorage.migrateTimestamp(raw.started_at);
      needsWrite = true;
    }
    if (raw.ended_at !== undefined && raw.ended_at !== null && typeof raw.ended_at !== 'number') {
      raw.ended_at = FileStorage.migrateTimestamp(raw.ended_at);
      needsWrite = true;
    }
    if (raw.last_interaction_at !== undefined && raw.last_interaction_at !== null && typeof raw.last_interaction_at !== 'number') {
      raw.last_interaction_at = FileStorage.migrateTimestamp(raw.last_interaction_at);
      needsWrite = true;
    }

    // Persist migrations back to disk so they only happen once
    if (needsWrite) {
      try {
        await this.writeJson(path, raw);
      } catch {
        // Best-effort: if we can't write, the in-memory migration still works
      }
    }

    return raw as unknown as Session;
  }

  /**
   * Write JSON atomically: write to a temp file, then rename into place.
   * This ensures readers never see partial/corrupt content, which allows
   * read operations to proceed without holding the storage lock.
   */
  private async writeJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, path);
  }

  /**
   * Write a set of files into a task's directory, each atomically.
   *
   * Stages every file in a temp directory and then renames them into place
   * one by one. A rename within a filesystem is atomic, so a reader either
   * sees the whole old file or the whole new one — which is what lets reads
   * run without the storage lock.
   *
   * INVARIANT: this must NEVER swap the task DIRECTORY itself. The previous
   * implementation copied the directory, renamed the original aside and moved
   * the copy into place, which had two failure modes that both bit in
   * production:
   *
   *   1. It wrote back a snapshot of every OTHER file taken before this
   *      operation started, so an interleaved write was not merely raced on
   *      one field — the loser's entire write was reverted. An acknowledged
   *      `lazy edit --prompt` was silently rolled back this way (see
   *      CLAUDE.md, "Never Lose Human Feedback").
   *   2. Between the two renames the task directory did not exist, so a
   *      concurrent lock-free reader saw the task VANISH — observed as
   *      "404 Task not found" from a `start` racing an `edit`.
   *
   * Writing only the named files also makes the cost O(files written) rather
   * than O(directory size).
   */
  private async atomicWriteTask(taskId: string, files: Record<string, unknown>): Promise<void> {
    // Serialize concurrent async operations on the same task directory, so two
    // writers cannot interleave their stage→rename sequences.
    return this.taskMutex.withLock(taskId, async () => {
      const taskDir = this.taskDir(taskId);
      const tmpDir = `${taskDir}.tmp.${Date.now()}`;

      try {
        await mkdir(taskDir, { recursive: true });
        await mkdir(tmpDir, { recursive: true });

        // Stage every file first, so a failure to serialize one of them leaves
        // the task directory completely untouched.
        for (const [filename, data] of Object.entries(files)) {
          await this.writeJson(join(tmpDir, filename), data);
        }

        for (const filename of Object.keys(files)) {
          await rename(join(tmpDir, filename), join(taskDir, filename));
        }
      } finally {
        // Always clear the staging directory — on success it is empty, on
        // failure it holds partial writes that must not linger.
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  }

  // --- Task store index ---
  //
  // Two read paths used to be quadratic: getTaskTree called getChildTasks (a
  // full store scan) once per node, and every session lookup read every task's
  // session.json until it matched. Both are now served from TaskStoreIndex.

  /** A directory under tasks/ that is a real task, not write staging. */
  private static isTaskDirName(dir: string): boolean {
    return !dir.includes('.tmp') && !dir.includes('.backup');
  }

  /**
   * The names of the real task directories under tasks/ — write staging and
   * anything that is not a directory at all excluded.
   *
   * That second half is what a store-walking MIGRATION needs and a plain
   * `readdir` does not give it. Opening a file inside a `.DS_Store` fails with
   * ENOTDIR, not ENOENT, so a loop that only forgives ENOENT reports a stray
   * entry as a failure on every daemon start, forever, with nothing any retry
   * can do about it. A migration's whole value is that its report can be
   * trusted, and a warning that fires regardless of state teaches an operator
   * to skim past the ones that matter.
   *
   * A store with no tasks directory yet answers `[]`; anything else that stops
   * the directory being read throws, named by `context`.
   */
  private async listTaskDirNames(context: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.tasksPath, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        `${context} could not read tasks directory ${this.tasksPath}: ${(err as Error).message}`,
      );
    }
    return entries
      // A symlinked task directory is unusual but legitimate, and `isDirectory`
      // is false for one — so exclude only what is definitely not a directory.
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => FileStorage.isTaskDirName(name));
  }

  /**
   * Get the index, building it on first use and reconciling it with the tasks
   * directory on every subsequent use.
   *
   * Reconciliation is one readdir — it costs O(entries) dirents rather than
   * O(store) file reads — and it only ADDS tasks the index has not seen and
   * DROPS ones whose directory is gone. That keeps a long-lived daemon instance
   * correct across a store restore or an import that writes task directories
   * without going through this class.
   */
  private async ensureIndex(): Promise<TaskStoreIndex> {
    if (this.taskIndex) {
      await this.reconcileIndex(this.taskIndex);
      return this.taskIndex;
    }

    if (!this.indexBuild) {
      this.indexBuild = (async () => {
        try {
          const index = await this.buildIndex();
          this.taskIndex = index;
          return index;
        } finally {
          this.indexBuild = null;
        }
      })();
    }

    return this.indexBuild;
  }

  private async buildIndex(): Promise<TaskStoreIndex> {
    const index: TaskStoreIndex = {
      parentOf: new Map(),
      childrenOf: new Map(),
      codeOf: new Map(),
      idsByCode: new Map(),
      sessionToTask: new Map(),
      taskToSession: new Map(),
    };

    let dirs: string[];
    try {
      dirs = await readdir(this.tasksPath);
    } catch {
      // No tasks directory yet — an empty index is the correct answer, and the
      // next ensureIndex() reconcile picks up whatever appears later.
      return index;
    }

    for (const dir of dirs) {
      if (!FileStorage.isTaskDirName(dir)) continue;
      await this.indexTaskDir(index, dir);
    }

    return index;
  }

  private async reconcileIndex(index: TaskStoreIndex): Promise<void> {
    // Snapshot the known ids BEFORE the readdir: a task created while the
    // readdir is in flight is in the index but not in `dirs`, and dropping it
    // here would be wrong.
    const known = new Set(index.parentOf.keys());

    let dirs: string[];
    try {
      dirs = await readdir(this.tasksPath);
    } catch {
      return;
    }

    const present = new Set<string>();
    for (const dir of dirs) {
      if (!FileStorage.isTaskDirName(dir)) continue;
      present.add(dir);
      if (!index.parentOf.has(dir)) {
        await this.indexTaskDir(index, dir);
      }
    }

    for (const taskId of known) {
      if (!present.has(taskId)) this.indexForgetTask(index, taskId);
    }
  }

  /** Read one task directory from disk and fold it into the index. */
  private async indexTaskDir(index: TaskStoreIndex, dir: string): Promise<void> {
    const task = await this.readTask(join(this.tasksPath, dir, 'task.json'));
    if (!task) return;
    this.indexSetParent(index, dir, parentTaskIdOf(task));
    this.indexSetCode(index, dir, task.code ?? null);

    const session = await this.readSession(join(this.tasksPath, dir, 'session.json'));
    if (session) this.indexSetSession(index, dir, session.id);
  }

  private indexSetParent(index: TaskStoreIndex, taskId: string, parentId: string | null): void {
    const previous = index.parentOf.get(taskId);
    if (previous) index.childrenOf.get(previous)?.delete(taskId);

    index.parentOf.set(taskId, parentId);
    if (parentId) {
      let siblings = index.childrenOf.get(parentId);
      if (!siblings) {
        siblings = new Set();
        index.childrenOf.set(parentId, siblings);
      }
      siblings.add(taskId);
    }
  }

  private indexSetCode(index: TaskStoreIndex, taskId: string, code: string | null): void {
    const previous = index.codeOf.get(taskId);
    if (previous) {
      const holders = index.idsByCode.get(previous);
      holders?.delete(taskId);
      if (holders?.size === 0) index.idsByCode.delete(previous);
    }

    index.codeOf.set(taskId, code);
    if (code) {
      let holders = index.idsByCode.get(code);
      if (!holders) {
        holders = new Set();
        index.idsByCode.set(code, holders);
      }
      holders.add(taskId);
    }
  }

  private indexSetSession(index: TaskStoreIndex, taskId: string, sessionId: string): void {
    // A task holds one session.json at a time, so a new session makes the old
    // session id unreachable — drop it rather than leave it pointing here.
    const previous = index.taskToSession.get(taskId);
    if (previous && previous !== sessionId) index.sessionToTask.delete(previous);

    index.taskToSession.set(taskId, sessionId);
    index.sessionToTask.set(sessionId, taskId);
  }

  private indexForgetTask(index: TaskStoreIndex, taskId: string): void {
    const parentId = index.parentOf.get(taskId);
    if (parentId) {
      const siblings = index.childrenOf.get(parentId);
      siblings?.delete(taskId);
      if (siblings?.size === 0) index.childrenOf.delete(parentId);
    }
    index.parentOf.delete(taskId);
    // NOT childrenOf[taskId]: a task whose directory is gone can still have
    // children on disk pointing at it, and the full-store filter this replaces
    // would still return them for that parent id.

    const code = index.codeOf.get(taskId);
    if (code) {
      const holders = index.idsByCode.get(code);
      holders?.delete(taskId);
      if (holders?.size === 0) index.idsByCode.delete(code);
    }
    index.codeOf.delete(taskId);

    const sessionId = index.taskToSession.get(taskId);
    if (sessionId) index.sessionToTask.delete(sessionId);
    index.taskToSession.delete(taskId);
  }

  /**
   * Apply a write-path update to the index.
   *
   * Callers run inside the storage lock and call this AFTER the write landed on
   * disk. If no index exists yet there is nothing to keep coherent — the next
   * build reads the new state from disk. If a build is in flight we wait for it
   * and then apply: the build may or may not have seen this write, and since
   * every update here is an idempotent set-to-this-value, the result is the
   * same either way.
   */
  private async applyIndexUpdate(update: (index: TaskStoreIndex) => void): Promise<void> {
    const build = this.indexBuild;
    if (build) {
      try {
        update(await build);
      } catch {
        // The build failed; it left no index behind, so there is nothing to
        // update and the next ensureIndex() rebuilds from disk.
      }
      return;
    }
    if (this.taskIndex) update(this.taskIndex);
  }

  /**
   * Find task ID by prefix match or code lookup.
   *
   * Resolution order:
   * 1. Canonical UUID shape -> taken as the id itself (never retried as a code)
   * 2. Hex prefix -> directory prefix match
   * 3. Otherwise -> search tasks by code field
   */
  private async findTaskIdByPrefix(input: string): Promise<string | null> {
    const result = await this.findTaskIdWithDetails(input);
    return result.id;
  }

  /**
   * Find task ID with full resolution details (for error reporting).
   */
  private async findTaskIdWithDetails(input: string): Promise<{ id: string | null; ambiguousIds?: string[] }> {
    // Take the id fast path on UUID SHAPE, never on length alone: a task code can
    // be exactly 36 characters long (e.g. 'fix-approval-burned-on-failed-accept'),
    // and treating it as an id made every lookup by that code fail with "No task
    // found matching" while the task sat there in `lazy list`.
    //
    // A UUID-shaped input stays in the id namespace even when no such task exists
    // — it is NOT retried as a code. That keeps an id miss to one failed file read
    // instead of a full-store scan (the code branch below reads every task.json),
    // which `lazy doctor`'s storage liveness probe depends on: it deliberately
    // looks up the nil UUID against a store of unbounded size under a fixed
    // timeout. The two namespaces are disjoint by shape, so nothing is lost unless
    // someone names a task code as a canonical UUID.
    if (UUID_PATTERN.test(input)) {
      return { id: input };
    }

    try {
      const index = await this.ensureIndex();
      const cleanDirs = [...index.parentOf.keys()];

      // Try hex prefix match first
      const prefixMatches = cleanDirs.filter(d => d.startsWith(input));
      if (prefixMatches.length === 1) {
        return { id: prefixMatches[0] };
      }

      // If input looks like a hex prefix (even if ambiguous), don't fall through to code
      if (/^[a-f0-9]+$/.test(input) && prefixMatches.length > 0) {
        return { id: null }; // Ambiguous hex prefix
      }

      // Code lookup, narrowed by the index: read the candidate task.json files
      // rather than every task.json in the store. A URL like /tasks/<code> hits
      // this on every page render, and the full scan it replaces was the single
      // largest phase in the web task page (~87ms on a 2000-task store).
      //
      // The index says WHICH files to open; the files still decide. A miss
      // falls back to the full scan and repairs the index from what it finds,
      // so a code written by something that bypassed this class is still
      // resolved — at exactly the cost this method used to have unconditionally.
      const candidateIds = index.idsByCode.get(input);
      let codeTasks = candidateIds
        ? await this.readTasksWithCode([...candidateIds], input)
        : [];
      if (codeTasks.length === 0) {
        codeTasks = await this.readTasksWithCode(cleanDirs, input);
        for (const task of codeTasks) this.indexSetCode(index, task.id, task.code ?? null);
      }

      if (codeTasks.length === 0) {
        return { id: null }; // No match
      }

      if (codeTasks.length === 1) {
        return { id: codeTasks[0].id };
      }

      // Multiple matches: apply disambiguation logic
      // 1. Prefer non-terminal tasks over terminal tasks
      const nonTerminal = codeTasks.filter(t => !isTerminalStatus(t.status));
      const terminal = codeTasks.filter(t => isTerminalStatus(t.status));

      if (nonTerminal.length === 1) {
        // Single non-terminal task - use it even if there are terminal tasks
        return { id: nonTerminal[0].id };
      }

      if (nonTerminal.length > 1) {
        // Multiple non-terminal tasks - genuinely ambiguous, error
        return { id: null, ambiguousIds: nonTerminal.map(t => t.id) };
      }

      // All matches are terminal (closed, abandoned, complete)
      if (terminal.length === 1) {
        return { id: terminal[0].id };
      }

      // Multiple terminal tasks - prefer most recent (all inactive, so not genuinely ambiguous)
      const sorted = terminal.sort((a, b) => b.created_at - a.created_at);
      return { id: sorted[0].id };
    } catch {
      return { id: null };
    }
  }

  /** Read the given task dirs and keep the ones actually carrying `code`. */
  private async readTasksWithCode(taskIds: string[], code: string): Promise<Task[]> {
    const matches: Task[] = [];
    for (const taskId of taskIds) {
      const task = await this.readTask(join(this.tasksPath, taskId, 'task.json'));
      if (task && task.code === code) matches.push(task);
    }
    return matches;
  }

  /**
   * Get task ID from a session id or id prefix.
   *
   * Served from the index: an exact id is a map hit, a prefix walks the
   * in-memory session ids (no I/O). A miss falls back to the full scan this
   * used to do unconditionally and repairs the index from what it finds, so a
   * session the index has not seen is still found rather than reported absent
   * — at exactly the cost this method used to have.
   */
  private async findTaskIdBySessionPrefix(sessionPrefix: string): Promise<string | null> {
    const index = await this.ensureIndex();

    const exact = index.sessionToTask.get(sessionPrefix);
    if (exact !== undefined) return exact;

    for (const [sessionId, taskId] of index.sessionToTask) {
      if (sessionId.startsWith(sessionPrefix)) return taskId;
    }

    return this.scanForTaskIdBySessionPrefix(sessionPrefix, index);
  }

  /** Pre-index full-store scan, kept as the miss path for the lookup above. */
  private async scanForTaskIdBySessionPrefix(
    sessionPrefix: string,
    index: TaskStoreIndex,
  ): Promise<string | null> {
    try {
      const dirs = await readdir(this.tasksPath);
      for (const dir of dirs) {
        if (!FileStorage.isTaskDirName(dir)) continue;

        const sessionPath = join(this.tasksPath, dir, 'session.json');
        const session = await this.readSession(sessionPath);
        if (session && session.id.startsWith(sessionPrefix)) {
          this.indexSetSession(index, dir, session.id);
          return dir;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Append a status change entry to a task's status-changelog.json.
   * Returns the updated changelog for inclusion in atomicWriteTask.
   */
  private async readAndAppendStatusChange(
    taskId: string,
    status: string,
    timestamp: number,
    actor?: ActorInput,
  ): Promise<StatusChangelogFile> {
    const changelogPath = join(this.taskDir(taskId), 'status-changelog.json');
    const file = await this.readJson<StatusChangelogFile>(changelogPath);
    const changes = file?.changes ?? [];
    changes.push({ status, timestamp, ...actorFields(actor) });
    return { changes };
  }

  /**
   * Throw if the task is in a terminal state (complete, abandoned, closed).
   * Terminal tasks are frozen — their core fields cannot be modified.
   *
   * @param targetStatus - If provided and equals task.status, treats the transition as a no-op (idempotent)
   */
  private assertNotTerminal(task: Task, operation: string, targetStatus?: TaskStatus): void {
    // Idempotent transitions (same state → same state) are a no-op, not an error
    if (targetStatus !== undefined && task.status === targetStatus) {
      return;
    }

    if (isTerminalStatus(task.status)) {
      throw new Error(
        `Task ${task.id.substring(0, 8)} is already in terminal state '${task.status}'. Cannot ${operation}.`
      );
    }
  }


  // --- Lifecycle ---

  async initialize(): Promise<void> {
    // Ensure basePath exists BEFORE acquiring the lock.
    // The storage lock checks that its directory exists, so we must create
    // the basePath first. This is safe without a lock because mkdir with
    // { recursive: true } is idempotent — concurrent calls won't conflict.
    await mkdir(this.basePath, { recursive: true });

    return this.lock.withLock(async () => {
      // Create subdirectories
      await mkdir(this.tasksPath, { recursive: true });

      // Write/check version
      const versionPath = join(this.basePath, 'version.json');
      const version = await this.readJson<StorageVersion>(versionPath);

      if (!version) {
        await this.writeJson(versionPath, {
          schema_version: STORAGE_VERSION,
          migrated_at: new Date().toISOString(),
        });
      }

      // Cleanup any leftover temp/backup directories from crashes
      await this.cleanupTempDirs();
    });
  }

  private async cleanupTempDirs(): Promise<void> {
    try {
      const dirs = await readdir(this.tasksPath);
      for (const dir of dirs) {
        if (dir.includes('.tmp') || dir.includes('.backup')) {
          await rm(join(this.tasksPath, dir), { recursive: true, force: true });
        }
      }

      // Clean up leftover .tmp files from atomic writeJson inside task dirs
      for (const dir of dirs) {
        if (dir.includes('.tmp') || dir.includes('.backup')) continue;
        try {
          const files = await readdir(join(this.tasksPath, dir));
          for (const file of files) {
            if (file.endsWith('.tmp')) {
              await rm(join(this.tasksPath, dir, file), { force: true });
            }
          }
        } catch {
          // Ignore per-task cleanup errors
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  async close(): Promise<void> {
    // No resources to release for file storage
  }

  // --- Tasks ---

  async createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string, agentId?: string, actor?: ActorInput): Promise<Task> {
    return this.lock.withLock(async () => {
      // Reject duplicate codes against non-terminal tasks
      if (code) {
        const existing = await this.listTasks();
        const conflict = existing.find(t => t.code === code && !isTerminalStatus(t.status));
        if (conflict) {
          throw new Error(`A task with code '${code}' already exists (${conflict.id.slice(0, 8)}, status: ${conflict.status}). Choose a different code or close/reject the existing task first.`);
        }
      }

      const id = randomUUID();
      const now = Date.now();

      const task: Task = {
        id,
        code: code ?? null,
        goal,
        prompt: '',
        type: (type as Task['type']) ?? 'task',
        status: 'backlog',
        created_at: now,
        completed_at: null,
        target: targetFromLegacy(parentTaskId ?? null, null),
        branched_from_sha: branchedFromSha ?? null,
        close_reason: null,
        model: null,
        agent_id: agentId ?? 'claude-code',
        runner_type: null,
        metadata: null,
        tags: [],
        pending_sync: 0,
        in_flight_turn: null,
      };

      await this.atomicWriteTask(id, {
        'task.json': task,
        'turns.json': { turns: [] },
        'commits.json': { commits: [] },
        'prompt-history.json': { versions: [] },
        'snapshots.json': { snapshots: [] },
        'reviews.json': { reviews: [] },
        'comments.json': { comments: [] },
        'raised-items.json': { raised_items: [] },
        'turn-reports.json': { turn_reports: [] },
        'file-decisions.json': { file_decisions: [] },
        'artifacts.json': { artifacts: [] },
        'status-changelog.json': { changes: [{ status: 'backlog', timestamp: now, ...actorFields(actor) }] },
        'tag-history.json': { events: [] },
      });

      await this.applyIndexUpdate((index) => {
        this.indexSetParent(index, id, parentTaskIdOf(task));
        this.indexSetCode(index, id, task.code);
      });

      return task;
    });
  }

  async getTask(taskId: string): Promise<Task | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;

    return this.readTask(join(this.taskDir(fullId), 'task.json'));
  }

  async resolveTask(input: string): Promise<{ task: Task | null; ambiguousMatches?: Task[] }> {
    const result = await this.findTaskIdWithDetails(input);

    if (result.id) {
      const task = await this.readTask(join(this.taskDir(result.id), 'task.json'));
      return { task };
    }

    if (result.ambiguousIds && result.ambiguousIds.length > 0) {
      const tasks: Task[] = [];
      for (const id of result.ambiguousIds) {
        const task = await this.readTask(join(this.taskDir(id), 'task.json'));
        if (task) tasks.push(task);
      }
      return { task: null, ambiguousMatches: tasks };
    }

    return { task: null };
  }

  async listTasks(): Promise<Task[]> {
    try {
      const dirs = await readdir(this.tasksPath);
      const tasks: Task[] = [];

      for (const dir of dirs) {
        if (dir.includes('.tmp') || dir.includes('.backup')) continue;

        const task = await this.readTask(join(this.tasksPath, dir, 'task.json'));
        if (task) {
          tasks.push(task);
        }
      }

      // Sort by created_at DESC
      return tasks.sort((a, b) => b.created_at - a.created_at);
    } catch {
      return [];
    }
  }

  /**
   * Served from the index — one readdir to reconcile, then no file reads at
   * all. The full `listTasks()` this replaces for identity-only callers reads
   * every task.json in the store; the web task page paid that on every render
   * just to autolink task codes in prose.
   */
  async listTaskCodes(): Promise<TaskCodeEntry[]> {
    const index = await this.ensureIndex();
    return [...index.codeOf].map(([id, code]) => ({ id, code }));
  }

  /**
   * Served from the index's parent graph — no file reads. Same answer as
   * `descendantCounts()` over `listTasks()`, which is what the Subtasks tab
   * used to build a "+N" column with.
   */
  async countDescendants(taskIds: string[]): Promise<Record<string, number>> {
    const index = await this.ensureIndex();
    const counts: Record<string, number> = {};

    for (const rootId of taskIds) {
      // Breadth-first over childrenOf, cycle-safe the same way collectSubtreeIds
      // is: a corrupt parent link is visited once, not forever.
      const seen = new Set<string>([rootId]);
      const queue = [rootId];
      let total = 0;
      while (queue.length > 0) {
        for (const childId of index.childrenOf.get(queue.pop()!) ?? []) {
          if (seen.has(childId)) continue;
          seen.add(childId);
          total++;
          queue.push(childId);
        }
      }
      counts[rootId] = total;
    }

    return counts;
  }

  async listTasksWithOptions(options: ListTasksOptions): Promise<Task[]> {
    let tasks = await this.listTasks();

    // Pre-filter: narrow to tasks with sessions if requested
    if (options.withSessionsOnly) {
      const tasksWithSessions: Task[] = [];
      for (const task of tasks) {
        const session = await this.getSessionByTaskId(task.id);
        if (session) {
          tasksWithSessions.push(task);
        }
      }
      tasks = tasksWithSessions;
    }

    // Self-healing: fix tasks with ended sessions but non-terminal status.
    // This can happen if accept/reject updates the session but crashes before
    // updating the task status. We detect and repair this inconsistency.
    // Never auto-heal working tasks — the agent is actively running.
    for (const task of tasks) {
      if (!isTerminalStatus(task.status) && task.status !== 'working') {
        const session = await this.getSessionByTaskId(task.id);
        if (session?.ended_at && session.outcome) {
          const newStatus = session.outcome === 'accepted' ? 'complete' : 'abandoned';
          const now = Date.now();
          task.status = newStatus;
          task.completed_at = task.completed_at ?? session.ended_at;
          // Persist the fix (best-effort, self-healing) — lock only for the
          // write. Re-read task.json INSIDE the lock and apply just the two
          // healed fields: `task` was loaded before this await-heavy sweep, and
          // atomicWriteTask replaces the whole file, so writing the stale object
          // would silently revert any field another operation changed meanwhile
          // (e.g. an accepted `lazy edit --prompt`).
          try {
            await this.lock.withLock(async () => {
              const current = await this.readTask(join(this.taskDir(task.id), 'task.json'));
              if (!current) return;
              current.status = newStatus;
              current.completed_at = current.completed_at ?? session.ended_at;
              const changelog = await this.readAndAppendStatusChange(task.id, newStatus, now);
              await this.atomicWriteTask(task.id, { 'task.json': current, 'status-changelog.json': changelog });
            });
          } catch {
            // In-memory fix still applies for this query
          }
        }
      }
    }

    return tasks.filter((task) => {
      if (options.rootsOnly && parentTaskIdOf(task) !== null) {
        return false;
      }
      if (options.blockedOnly && !isBlockedStatus(task.status)) {
        return false;
      }
      if (options.backlogOnly && task.status !== 'backlog') {
        return false;
      }
      if (options.workingOnly && task.status !== 'working') {
        return false;
      }
      if (options.interruptedOnly && task.status !== 'interrupted') {
        return false;
      }
      if (options.pairingOnly && task.status !== 'pairing') {
        return false;
      }
      if (options.mergingOnly && task.status !== 'merging') {
        return false;
      }
      if (options.submittedOnly && task.status !== 'submitted') {
        return false;
      }
      if (options.nonTerminalOnly && isTerminalStatus(task.status)) {
        return false;
      }
      return true;
    });
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, actor?: ActorInput): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      // Idempotent: same state → same state is a no-op
      if (task.status === status) {
        return;
      }

      // Enforce valid transitions via the state machine
      assertValidTransition(task.status, status, actorRole(actor));

      const now = Date.now();
      task.status = status;
      if (isTerminalStatus(status) && !task.completed_at) {
        task.completed_at = now;
      }

      const changelog = await this.readAndAppendStatusChange(fullId, status, now, actor);
      await this.atomicWriteTask(fullId, { 'task.json': task, 'status-changelog.json': changelog });
    });
  }

  async updateTaskGoal(taskId: string, goal: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      this.assertNotTerminal(task, 'update goal');

      task.goal = goal;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async updateTaskCode(taskId: string, code: string | null): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      task.code = code;

      await this.atomicWriteTask(fullId, { 'task.json': task });

      // The only write path that changes a task's code (lazy edit --code, and
      // the clone/redo suffixing that goes through it).
      await this.applyIndexUpdate((index) => this.indexSetCode(index, fullId, code));
    });
  }

  async updateTaskTarget(taskId: string, target: TaskTarget): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      this.assertNotTerminal(task, 'update target');

      task.target = target;
      // task.target is the single source of truth. The legacy
      // metadata.remote_target_branch / github_pr_target_branch keys are no
      // longer written or read; readTask already stripped them on load, so the
      // task we persist here carries none.

      await this.atomicWriteTask(fullId, { 'task.json': task });

      // The only write path that changes a task's parentage (lazy reparent).
      await this.applyIndexUpdate((index) =>
        this.indexSetParent(index, fullId, parentTaskIdOf(task)),
      );
    });
  }

  async updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      this.assertNotTerminal(task, 'update branched_from_sha');

      task.branched_from_sha = sha;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async updateTaskModel(taskId: string, model: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      this.assertNotTerminal(task, 'update model');

      task.model = model as Task['model'];

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async updateTaskRunnerType(taskId: string, runnerType: RunnerType | null): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      // Allowed at any time while the task is live (changeable per design); the
      // override takes effect on the next launch. Terminal tasks are immutable.
      this.assertNotTerminal(task, 'update runner type');

      task.runner_type = runnerType;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async updateTaskType(taskId: string, type: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      this.assertNotTerminal(task, 'update type');

      task.type = type as Task['type'];

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async updateTaskAgent(taskId: string, agentId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      // Allowed at any time while the task is live; the change takes effect on
      // the next turn. Terminal tasks are immutable.
      this.assertNotTerminal(task, 'update agent');

      task.agent_id = agentId;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async resetTaskPendingSync(taskId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      task.pending_sync = 0;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async incrementTaskPendingSync(taskId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      task.pending_sync = (task.pending_sync ?? 0) + 1;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async abandonTask(taskId: string, reason: string, actor?: ActorInput): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      assertValidTransition(task.status, 'abandoned');

      const now = Date.now();
      task.status = 'abandoned';
      task.close_reason = reason;
      task.completed_at = now;

      const changelog = await this.readAndAppendStatusChange(fullId, 'abandoned', now, actor);
      await this.atomicWriteTask(fullId, { 'task.json': task, 'status-changelog.json': changelog });
    });
  }

  async reopenTask(taskId: string, actor?: ActorInput): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      // If task has a session (was started), reopen to 'blocked' (waiting for review).
      // If task has no session (never started), reopen to 'backlog'.
      const session = await this.getSessionByTaskId(fullId);
      const newStatus = session ? 'blocked' : 'backlog';

      // Enforce valid transition via the state machine
      assertValidTransition(task.status, newStatus);
      const now = Date.now();
      task.status = newStatus;
      task.completed_at = null;

      const changelog = await this.readAndAppendStatusChange(fullId, newStatus, now, actor);
      await this.atomicWriteTask(fullId, { 'task.json': task, 'status-changelog.json': changelog });
    });
  }

  async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      if (!task.metadata) {
        task.metadata = {};
      }
      task.metadata[key] = value;

      await this.atomicWriteTask(fullId, { 'task.json': task });
    });
  }

  async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;

    const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
    if (!task) return null;

    return task.metadata?.[key] ?? null;
  }

  async updateTaskPrompt(
    taskId: string,
    content: string,
    sessionId?: string
  ): Promise<TaskPromptVersion> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const taskDir = this.taskDir(fullId);
      const task = await this.readTask(join(taskDir, 'task.json'));
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      this.assertNotTerminal(task, 'update prompt');

      const historyFile = await this.readJson<PromptHistoryFile>(join(taskDir, 'prompt-history.json'));
      const history = historyFile?.versions ?? [];

      // Migrate legacy string timestamps in prompt history
      this.migrateTimestampFields(
        history as unknown as Record<string, unknown>[],
        ['created_at']
      );

      const maxVersion = history.reduce((max, v) => Math.max(max, v.version), 0);
      const nextVersion = maxVersion + 1;

      const version: TaskPromptVersion = {
        id: randomUUID(),
        task_id: fullId,
        version: nextVersion,
        content,
        created_at: Date.now(),
        session_id: sessionId ?? null,
      };

      history.push(version);
      task.prompt = content;

      await this.atomicWriteTask(fullId, {
        'task.json': task,
        'prompt-history.json': { versions: history },
      });

      return version;
    });
  }

  async getPromptHistory(taskId: string): Promise<TaskPromptVersion[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const historyFile = await this.readJson<PromptHistoryFile>(
      join(this.taskDir(fullId), 'prompt-history.json')
    );

    const versions = historyFile?.versions ?? [];

    // Migrate legacy string timestamps (best-effort write, no lock needed)
    const migrated = this.migrateTimestampFields(
      versions as unknown as Record<string, unknown>[],
      ['created_at']
    );
    if (migrated) {
      try {
        await this.writeJson(join(this.taskDir(fullId), 'prompt-history.json'), { versions });
      } catch {
        // Best-effort
      }
    }

    return versions.sort((a, b) => b.version - a.version);
  }

  async getPromptVersion(taskId: string, version: number): Promise<TaskPromptVersion | null> {
    const history = await this.getPromptHistory(taskId);
    return history.find((v) => v.version === version) ?? null;
  }

  // --- Sessions ---

  async createSession(
    taskId: string,
    agentId: string,
    gitBranch: string,
    gitStartSha: string,
    claudeSessionId?: string
  ): Promise<Session> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const now = Date.now();
      const session: Session = {
        id: randomUUID(),
        task_id: fullId,
        agent_id: agentId,
        started_at: now,
        ended_at: null,
        outcome: null,
        git_branch: gitBranch,
        git_start_sha: gitStartSha,
        agent_session_id: claudeSessionId ?? null,
        last_interaction_at: now,
        total_duration_ms: 0,
        total_usage: null,
        container_name: null,
        container_agent_id: null,
        interrupt_reason: null,
        interrupt_exit_code: null,
        interrupt_at: null,
        interrupt_logs: null,
        consecutive_interruptions: 0,
        auto_resumed: false,
        user_stopped: false,
        upstream_merge_sha: null,
        runner_type: null,
        reserved_turn_sequence: 0,
        notes_delivered_through: null,
      };

      await this.atomicWriteTask(fullId, { 'session.json': session });

      // The only write path that changes a task's session id — session.json is
      // replaced wholesale here, and every other session write preserves `id`.
      await this.applyIndexUpdate((index) => this.indexSetSession(index, fullId, session.id));

      return session;
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const taskId = await this.findTaskIdBySessionPrefix(sessionId);
    if (!taskId) return null;

    return this.readSession(join(this.taskDir(taskId), 'session.json'));
  }

  async getSessionByTaskId(taskId: string): Promise<Session | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;

    return this.readSession(join(this.taskDir(fullId), 'session.json'));
  }

  async listSessions(taskId?: string, activeOnly: boolean = true): Promise<Session[]> {
    if (taskId) {
      const session = await this.getSessionByTaskId(taskId);
      if (!session) return [];
      if (activeOnly && (session.outcome !== null || session.ended_at !== null)) {
        return [];
      }
      return [session];
    }

    const tasks = await this.listTasks();
    const sessions: Session[] = [];

    for (const task of tasks) {
      const session = await this.getSessionByTaskId(task.id);
      if (session) {
        if (activeOnly && (session.outcome !== null || session.ended_at !== null)) {
          continue;
        }
        sessions.push(session);
      }
    }

    return sessions.sort((a, b) => b.started_at - a.started_at);
  }

  async endSession(sessionId: string, outcome: SessionOutcome): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.ended_at = Date.now();
      session.outcome = outcome;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async resetSession(sessionId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.ended_at = null;
      session.outcome = null;
      session.agent_session_id = null;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionClaudeId(sessionId: string, claudeSessionId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.agent_session_id = claudeSessionId;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionContainerName(
    sessionId: string,
    containerName: string | null,
    containerAgentId?: string | null,
  ): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.container_name = containerName;
      // Container gone → its agent stamp is meaningless. Fresh launch passes
      // the profile that was just launched so the next switch can detect mismatch.
      if (containerName === null) {
        session.container_agent_id = null;
      } else if (containerAgentId !== undefined) {
        session.container_agent_id = containerAgentId;
      }

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionRunnerType(sessionId: string, runnerType: RunnerType | null): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.runner_type = runnerType;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionAgent(sessionId: string, agentId: string, resetAgentSession: boolean): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      // agent_id is the PROFILE name and always follows the switch. The agent
      // session ID is the HARNESS's own resume token, so it is cleared only
      // when the caller says the harness changed — a session cannot be resumed
      // by a different agent binary, and need not be dropped by the same one.
      const previousAgent = session.agent_id;
      session.agent_id = agentId;
      if (resetAgentSession) session.agent_session_id = null;
      // Remember which profile the RUNNING container belongs to when we have
      // never stamped one. Without this, a first Claude→Codex/Cursor switch on
      // a legacy session cannot detect the env mismatch and reuses the old
      // container (LAZY_CODEX_API_BASE / CURSOR_API_ENDPOINT missing).
      if (previousAgent !== agentId && session.container_agent_id == null) {
        session.container_agent_id = previousAgent;
      }

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionInteraction(sessionId: string, durationMs: number): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.last_interaction_at = Date.now();
      session.total_duration_ms += durationMs;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readJson<Session>(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      if (!session.total_usage) {
        session.total_usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      }

      session.total_usage.inputTokens += usage.inputTokens;
      session.total_usage.outputTokens += usage.outputTokens;
      session.total_usage.cacheCreationTokens += usage.cacheCreationTokens;
      session.total_usage.cacheReadTokens += usage.cacheReadTokens;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async markNotesDelivered(sessionId: string, timestamp: number): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      // Monotonic: a later turn that delivered nothing new must not rewind the
      // mark and re-deliver notes the agent has already seen.
      const current = session.notes_delivered_through ?? 0;
      if (timestamp <= current) return;
      session.notes_delivered_through = timestamp;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async setSessionTurnOwner(
    sessionId: string,
    owner: TurnOwner | null,
    systemInitiated = false,
  ): Promise<void> {
    return this.lock.withLock(async () => {
      // Returning silently on a miss is this file's house style for every
      // session mutator, and it is kept — but it means a caller cannot read
      // "resolved" as "written". That is why the CLEARING direction in
      // src/daemon/turn-owner.ts reads the session back instead of trusting
      // this call: a clear that silently did nothing would leave the previous
      // turn owner's address on a turn they never asked for.
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      // Null is a real value here, not "leave it alone": a turn nobody asked
      // for must clear the previous turn's owner. See Session.turn_owner_email.
      session.turn_owner_email = owner ? owner.email : null;
      session.turn_owner_name = owner?.name ?? null;
      // ONE WRITE for both halves, so "nobody asked" and "the daemon did it
      // itself" can never disagree — including the false a person's launch
      // writes over a previous system turn's mark.
      session.turn_system_initiated = systemInitiated;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async updateSessionUpstreamMergeSha(sessionId: string, sha: string): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readJson<Session>(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.upstream_merge_sha = sha;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async recordInterrupt(sessionId: string, diagnostics: {
    reason: string;
    exit_code: number | null;
    logs: string | null;
  }): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.interrupt_reason = diagnostics.reason;
      session.interrupt_exit_code = diagnostics.exit_code;
      session.interrupt_at = Date.now();
      session.interrupt_logs = diagnostics.logs;
      session.consecutive_interruptions = (session.consecutive_interruptions ?? 0) + 1;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async resetConsecutiveInterruptions(sessionId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.consecutive_interruptions = 0;
      session.auto_resumed = false;
      // Manual resume/unblock re-arms auto-resume: clear the user-stop gate.
      session.user_stopped = false;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async setAutoResumed(sessionId: string, autoResumed: boolean): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.auto_resumed = autoResumed;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  async setUserStopped(sessionId: string, userStopped: boolean): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.user_stopped = userStopped;

      await this.atomicWriteTask(taskId, { 'session.json': session });
    });
  }

  // --- Turns ---

  async createTurn(options: CreateTurnOptions): Promise<Turn> {
    return this.lock.withLock(async () => {
      const {
        sessionId,
        sequence,
        role,
        content,
        usage,
        startSha,
        endSha,
        startShaWork,
        endShaWork,
        mergeConflicts,
        violations,
        uncommitted,
        agent,
        model,
        modelId,
        effort,
        mcpTools,
        prompt,
        actor,
        checkExitCode,
        checkOutput,
        preTurnExitCode,
        preTurnOutput,
        autoTriggered,
        turnType,
        carriesFeedback,
        agent_had_no_effect,
        review,
        reviewDispatch,
        reviewAddressed,
        final,
      } = options;

      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
      const turns = turnsFile?.turns ?? [];

      // Migrate legacy string timestamps in existing turns
      this.migrateTimestampFields(
        turns as unknown as Record<string, unknown>[],
        ['timestamp']
      );

      // Migrate legacy model aliases in existing turns
      for (const turn of turns) {
        if (turn.model && LEGACY_MODEL_MAP[turn.model]) {
          turn.model = LEGACY_MODEL_MAP[turn.model];
        }
      }

      const now = Date.now();

      const turn: Turn = {
        id: randomUUID(),
        session_id: sessionId,
        sequence,
        role,
        // INVARIANT: a persisted turn ALWAYS has string content. JSON.stringify
        // drops an `undefined` key entirely, which is how content-less turns
        // reached disk and crashed accept + search. Coerce and warn rather than
        // drop the turn — a crash/recovery turn is exactly the history a
        // reviewer needs. See src/utils/turn-content.ts.
        content: normalizeTurnContent(content, 'file-storage'),
        timestamp: now,
        usage: usage ?? null,
        start_sha: startSha ?? null,
        start_sha_work: startShaWork ?? null,
        end_sha_work: endShaWork ?? null,
        end_sha: endSha ?? null,
        ...(mergeConflicts && mergeConflicts.length > 0 ? { merge_conflicts: mergeConflicts } : {}),
        // Persist empty arrays too: an explicit re-detect of "none remain" is a
        // real observation about THAT turn's range and belongs on disk.
        //
        // It no longer CLEARS anything (move-file-approval-to-accept). Reading
        // one turn's empty array as "nothing is owed" is what let an earlier
        // turn's unapproved protected file merge in silence, now that a conflict
        // task runs many turns before anyone decides. Every gate reads the
        // outstanding set across all turns and, where it can, re-detects over
        // the whole branch — see src/protection/outstanding.ts. A file really
        // does drop out when the agent reverts it, because it is then absent
        // from the branch diff, not because a later turn said nothing.
        ...(violations !== undefined ? { violations } : {}),
        // Unlike violations, an EMPTY set is not persisted: this one is written
        // from a `git status` that can fail, and a stored `[]` would state "the
        // worktree was checked and clean" on a turn where it was never read.
        ...(uncommitted && uncommitted.length > 0 ? { uncommitted } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        ...(effort ? { effort } : {}),
        ...(mcpTools ? { mcp_tools: mcpTools } : {}),
        ...(prompt ? { prompt } : {}),
        ...actorFields(actor),
        ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
        ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
        ...(preTurnExitCode !== undefined ? { pre_turn_exit_code: preTurnExitCode } : {}),
        ...(preTurnOutput !== undefined ? { pre_turn_output: preTurnOutput } : {}),
        ...(autoTriggered ? { auto_triggered: true } : {}),
        // Only persist non-default turn types — missing field implies 'work'.
        ...(turnType && turnType !== 'work' ? { turn_type: turnType } : {}),
        // Feedback starts life unconsumed; absent means "carries no feedback".
        ...(carriesFeedback ? { feedback_delivery: 'pending' as const } : {}),
        // Agent-had-no-effect flag for error turns — absent means unknown.
        ...(agent_had_no_effect !== undefined ? { agent_had_no_effect } : {}),
        // Structured review findings — only set on review-turn agent answers.
        ...(review ? { review } : {}),
        ...(reviewDispatch ? { review_dispatch: reviewDispatch } : {}),
        ...(reviewAddressed ? { review_addressed: true } : {}),
        // Pencils down — only set on the turn that declared the work finished.
        ...(final ? { final } : {}),
      };

      turns.push(turn);

      // Update session timing: track last_interaction_at and accumulate
      // agent working time into total_duration_ms
      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      const writes: Record<string, unknown> = { 'turns.json': { turns } };

      if (session) {
        // For agent turns, compute elapsed time since the last interaction
        // (which is when the human turn was recorded, i.e. when the agent
        // started working). This gives us the agent's wall-clock working time.
        if (role === 'agent') {
          const anchor = session.last_interaction_at ?? session.started_at;
          if (anchor) {
            const elapsed = now - anchor;
            if (elapsed > 0) {
              session.total_duration_ms += elapsed;
            }
          }
        }

        session.last_interaction_at = now;
        writes['session.json'] = session;
      }

      await this.atomicWriteTask(taskId, writes);

      return turn;
    });
  }

  async getSessionTurns(sessionId: string): Promise<Turn[]> {
    const taskId = await this.findTaskIdBySessionPrefix(sessionId);
    if (!taskId) return [];

    const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
    const turns = turnsFile?.turns ?? [];

    // Migrate legacy string timestamps (best-effort write, no lock needed)
    let migrated = this.migrateTimestampFields(
      turns as unknown as Record<string, unknown>[],
      ['timestamp']
    );

    // Migrate legacy model aliases in turns
    for (const turn of turns) {
      if (turn.model && LEGACY_MODEL_MAP[turn.model]) {
        turn.model = LEGACY_MODEL_MAP[turn.model];
        migrated = true;
      }
    }

    if (migrated) {
      try {
        await this.writeJson(join(this.taskDir(taskId), 'turns.json'), { turns });
      } catch {
        // Best-effort
      }
    }

    return turns.sort((a, b) => a.sequence - b.sequence);
  }

  async getNextTurnSequence(sessionId: string): Promise<number> {
    const turns = await this.getSessionTurns(sessionId);
    const maxSeq = turns.reduce((max, t) => Math.max(max, t.sequence), 0);
    // A reserved sequence has been promised to a waiter that has not written
    // its turn yet, so it is occupied even though no turn carries it.
    const reserved = await this.readReservedTurnSequence(sessionId);
    return Math.max(maxSeq, reserved) + 1;
  }

  /** Reservation high-water mark for a session (0 when nothing was reserved). */
  private async readReservedTurnSequence(sessionId: string): Promise<number> {
    const taskId = await this.findTaskIdBySessionPrefix(sessionId);
    if (!taskId) return 0;
    const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
    return session?.reserved_turn_sequence ?? 0;
  }

  async reserveTurnSequences(sessionId: string, count: number): Promise<number> {
    if (count < 1) throw new Error(`reserveTurnSequences: count must be >= 1, got ${count}`);
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) throw new Error(`reserveTurnSequences: no task found for session ${sessionId}`);

      const sessionPath = join(this.taskDir(taskId), 'session.json');
      const session = await this.readSession(sessionPath);
      if (!session) throw new Error(`reserveTurnSequences: session ${sessionId} not found`);

      const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
      const maxSeq = (turnsFile?.turns ?? [])
        .filter(t => t.session_id === session.id)
        .reduce((max, t) => Math.max(max, t.sequence), 0);

      const first = Math.max(maxSeq, session.reserved_turn_sequence ?? 0) + 1;
      session.reserved_turn_sequence = first + count - 1;
      await this.atomicWriteTask(taskId, { 'session.json': session });
      return first;
    });
  }

  // --- In-flight turns ---

  async beginInFlightTurn(taskId: string, turn: InFlightTurn): Promise<boolean> {
    return this.lock.withLock(async () => {
      const taskPath = join(this.taskDir(taskId), 'task.json');
      const task = await this.readTask(taskPath);
      if (!task) return false;

      const existing = task.in_flight_turn;
      // An expired record is not a claim — see InFlightTurn.expires_at.
      if (existing && existing.expires_at > Date.now()) return false;

      task.in_flight_turn = turn;
      await this.atomicWriteTask(taskId, { 'task.json': task });
      return true;
    });
  }

  async stampInFlightTurnRun(
    taskId: string,
    turnSequence: number,
    run: { runName: string; runnerType?: RunnerType },
  ): Promise<boolean> {
    return this.lock.withLock(async () => {
      const taskPath = join(this.taskDir(taskId), 'task.json');
      const task = await this.readTask(taskPath);
      if (!task?.in_flight_turn || task.in_flight_turn.turn_sequence !== turnSequence) return false;

      task.in_flight_turn = {
        ...task.in_flight_turn,
        run_name: run.runName,
        ...(run.runnerType ? { runner_type: run.runnerType } : {}),
      };
      await this.atomicWriteTask(taskId, { 'task.json': task });
      return true;
    });
  }

  async settleInFlightTurn(taskId: string, turnSequence: number, outcome: InFlightTurnOutcome): Promise<boolean> {
    return this.lock.withLock(async () => {
      const taskPath = join(this.taskDir(taskId), 'task.json');
      const task = await this.readTask(taskPath);
      if (!task?.in_flight_turn || task.in_flight_turn.turn_sequence !== turnSequence) return false;

      task.in_flight_turn = { ...task.in_flight_turn, outcome };
      await this.atomicWriteTask(taskId, { 'task.json': task });
      return true;
    });
  }

  async clearInFlightTurn(taskId: string, turnSequence?: number): Promise<void> {
    return this.lock.withLock(async () => {
      const taskPath = join(this.taskDir(taskId), 'task.json');
      const task = await this.readTask(taskPath);
      if (!task?.in_flight_turn) return;
      if (turnSequence !== undefined && task.in_flight_turn.turn_sequence !== turnSequence) return;

      task.in_flight_turn = null;
      await this.atomicWriteTask(taskId, { 'task.json': task });
    });
  }

  async getTurnCountByTaskId(taskId: string): Promise<number> {
    const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
    return turnsFile?.turns?.length ?? 0;
  }

  async updateTurnViolations(taskId: string, turnId: string, violations: FileViolation[]): Promise<void> {
    return this.lock.withLock(async () => {
      const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
      if (turnsFile?.turns) {
        const turn = turnsFile.turns.find(t => t.id === turnId);
        if (turn) {
          turn.violations = violations;
          await this.atomicWriteTask(taskId, { 'turns.json': turnsFile });
          return;
        }
      }

      throw new Error(`Turn not found: ${turnId}`);
    });
  }

  async updateTurnWrapUpSteps(taskId: string, turnId: string, wrapUpSteps: string[]): Promise<void> {
    return this.lock.withLock(async () => {
      const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
      if (turnsFile?.turns) {
        const turn = turnsFile.turns.find(t => t.id === turnId);
        if (turn) {
          if (turn.final) {
            turn.final.wrap_up_steps = wrapUpSteps;
          }
          // No claim on the turn → nothing to stamp; succeed silently (the
          // caller only stamps turns it already checked carry a claim).
          await this.atomicWriteTask(taskId, { 'turns.json': turnsFile });
          return;
        }
      }

      throw new Error(`Turn not found: ${turnId}`);
    });
  }

  async updateTurnReview(taskId: string, turnId: string, review: ReviewReport): Promise<void> {
    return this.lock.withLock(async () => {
      const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
      if (turnsFile?.turns) {
        const turn = turnsFile.turns.find(t => t.id === turnId);
        if (turn) {
          turn.review = review;
          await this.atomicWriteTask(taskId, { 'turns.json': turnsFile });
          return;
        }
      }

      throw new Error(`Turn not found: ${turnId}`);
    });
  }

  async markFeedbackConsumed(sessionId: string): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const turnsFile = await this.readJson<TurnsFile>(join(this.taskDir(taskId), 'turns.json'));
      if (!turnsFile?.turns) return;

      let changed = false;
      for (const turn of turnsFile.turns) {
        if (turn.session_id === sessionId && turn.feedback_delivery === 'pending') {
          turn.feedback_delivery = 'consumed';
          changed = true;
        }
      }

      // No pending feedback is the common case — skip the write entirely.
      if (changed) {
        await this.atomicWriteTask(taskId, { 'turns.json': turnsFile });
      }
    });
  }

  // --- Commits ---

  async createCommit(
    sessionId: string,
    sha: string,
    message: string,
  ): Promise<Commit> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const commitsFile = await this.readJson<CommitsFile>(join(this.taskDir(taskId), 'commits.json'));
      const commits = commitsFile?.commits ?? [];

      // Migrate legacy string timestamps in existing commits
      this.migrateTimestampFields(
        commits as unknown as Record<string, unknown>[],
        ['timestamp']
      );

      // Deduplicate: skip if this SHA is already recorded
      if (commits.some(c => c.sha === sha)) {
        return commits.find(c => c.sha === sha)!;
      }

      const commit: Commit = {
        id: randomUUID(),
        session_id: sessionId,
        sha,
        message,
        status: 'pending_review',
        timestamp: Date.now(),
      };

      commits.push(commit);

      await this.atomicWriteTask(taskId, { 'commits.json': { commits } });

      return commit;
    });
  }

  async getSessionCommits(sessionId: string): Promise<Commit[]> {
    const taskId = await this.findTaskIdBySessionPrefix(sessionId);
    if (!taskId) return [];

    const commitsFile = await this.readJson<CommitsFile>(join(this.taskDir(taskId), 'commits.json'));
    const commits = commitsFile?.commits ?? [];

    // Migrate legacy string timestamps (best-effort write, no lock needed)
    const migrated = this.migrateTimestampFields(
      commits as unknown as Record<string, unknown>[],
      ['timestamp']
    );
    if (migrated) {
      try {
        await this.writeJson(join(this.taskDir(taskId), 'commits.json'), { commits });
      } catch {
        // Best-effort
      }
    }

    return commits.sort((a, b) => a.timestamp - b.timestamp);
  }

  async deleteSessionCommits(sessionId: string, shas: string[]): Promise<number> {
    if (shas.length === 0) return 0;

    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const commitsFile = await this.readJson<CommitsFile>(join(this.taskDir(taskId), 'commits.json'));
      const commits = commitsFile?.commits ?? [];
      const doomed = new Set(shas);
      const kept = commits.filter(c => !doomed.has(c.sha));
      const removed = commits.length - kept.length;
      if (removed === 0) return 0;

      await this.atomicWriteTask(taskId, { 'commits.json': { commits: kept } });
      return removed;
    });
  }

  // --- Reviews ---

  async createReview(
    commitId: string,
    verdict: ReviewVerdict,
    rationale: string,
    reviewer: string
  ): Promise<Review> {
    return this.lock.withLock(async () => {
      // Find which task has this commit
      const dirs = await readdir(this.tasksPath);
      for (const dir of dirs) {
        if (dir.includes('.tmp') || dir.includes('.backup')) continue;

        const commitsFile = await this.readJson<CommitsFile>(join(this.tasksPath, dir, 'commits.json'));
        const commits = commitsFile?.commits ?? [];
        const commit = commits.find((c) => c.id === commitId);

        if (commit) {
          const reviewsFile = await this.readJson<ReviewsFile>(join(this.tasksPath, dir, 'reviews.json'));
          const reviews = reviewsFile?.reviews ?? [];

          // Migrate legacy string timestamps in existing reviews
          this.migrateTimestampFields(
            reviews as unknown as Record<string, unknown>[],
            ['timestamp']
          );

          const review: Review = {
            id: randomUUID(),
            commit_id: commitId,
            verdict,
            rationale,
            reviewer,
            timestamp: Date.now(),
          };

          reviews.push(review);

          await this.atomicWriteTask(dir, { 'reviews.json': { reviews } });

          return review;
        }
      }

      throw new Error(`Commit not found: ${commitId}`);
    });
  }

  async getCommitReviews(commitId: string): Promise<Review[]> {
    // Find which task has this commit
    const dirs = await readdir(this.tasksPath);
    for (const dir of dirs) {
      if (dir.includes('.tmp') || dir.includes('.backup')) continue;

      const commitsFile = await this.readJson<CommitsFile>(join(this.tasksPath, dir, 'commits.json'));
      const commits = commitsFile?.commits ?? [];

      if (commits.some((c) => c.id === commitId)) {
        const reviewsFile = await this.readJson<ReviewsFile>(join(this.tasksPath, dir, 'reviews.json'));
        const reviews = reviewsFile?.reviews ?? [];

        // Migrate legacy string timestamps (best-effort write, no lock needed)
        const migrated = this.migrateTimestampFields(
          reviews as unknown as Record<string, unknown>[],
          ['timestamp']
        );
        if (migrated) {
          try {
            await this.writeJson(join(this.tasksPath, dir, 'reviews.json'), { reviews });
          } catch {
            // Best-effort
          }
        }

        return reviews
          .filter((r) => r.commit_id === commitId)
          .sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    return [];
  }

  // --- Worktree Snapshots ---

  async createWorktreeSnapshot(
    sessionId: string,
    turnSequence: number,
    uncommittedDiff: string,
    gitStatus: string
  ): Promise<WorktreeSnapshot> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const snapshotsFile = await this.readJson<SnapshotsFile>(
        join(this.taskDir(taskId), 'snapshots.json')
      );
      const snapshots = snapshotsFile?.snapshots ?? [];

      // Migrate legacy string timestamps in existing snapshots
      this.migrateTimestampFields(
        snapshots as unknown as Record<string, unknown>[],
        ['timestamp']
      );

      const snapshot: WorktreeSnapshot = {
        id: randomUUID(),
        session_id: sessionId,
        turn_sequence: turnSequence,
        uncommitted_diff: uncommittedDiff,
        git_status: gitStatus,
        timestamp: Date.now(),
      };

      snapshots.push(snapshot);

      await this.atomicWriteTask(taskId, { 'snapshots.json': { snapshots } });

      return snapshot;
    });
  }

  async getLatestWorktreeSnapshot(sessionId: string): Promise<WorktreeSnapshot | null> {
    const taskId = await this.findTaskIdBySessionPrefix(sessionId);
    if (!taskId) return null;

    const snapshotsFile = await this.readJson<SnapshotsFile>(
      join(this.taskDir(taskId), 'snapshots.json')
    );
    const snapshots = snapshotsFile?.snapshots ?? [];

    if (snapshots.length === 0) return null;

    // Migrate legacy string timestamps
    this.migrateTimestampFields(
      snapshots as unknown as Record<string, unknown>[],
      ['timestamp']
    );

    // Sort by turn_sequence DESC, timestamp DESC
    const sorted = [...snapshots].sort((a, b) => {
      if (b.turn_sequence !== a.turn_sequence) {
        return b.turn_sequence - a.turn_sequence;
      }
      return b.timestamp - a.timestamp;
    });

    return sorted[0];
  }

  async getWorktreeSnapshotForTurn(
    sessionId: string,
    turnSequence: number
  ): Promise<WorktreeSnapshot | null> {
    const taskId = await this.findTaskIdBySessionPrefix(sessionId);
    if (!taskId) return null;

    const snapshotsFile = await this.readJson<SnapshotsFile>(
      join(this.taskDir(taskId), 'snapshots.json')
    );
    const snapshots = snapshotsFile?.snapshots ?? [];

    // Migrate legacy string timestamps
    this.migrateTimestampFields(
      snapshots as unknown as Record<string, unknown>[],
      ['timestamp']
    );

    const matching = snapshots.filter((s) => s.turn_sequence === turnSequence);
    if (matching.length === 0) return null;

    // Return most recent for this turn
    return matching.sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  // --- Task Tree Operations ---

  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    const index = await this.ensureIndex();
    return this.childTasksFromIndex(index, parentTaskId);
  }

  /**
   * Load the children of one task from the index — O(children) file reads
   * instead of a full store scan.
   *
   * Each child's task.json is still read from disk and its parentage
   * re-checked, so the index can only ever narrow which files are opened; it
   * can never make this return a task that is not actually a child, nor serve
   * stale task content. Ordering matches the old implementation's
   * (created_at DESC, inherited from listTasks).
   */
  private async childTasksFromIndex(index: TaskStoreIndex, parentTaskId: string): Promise<Task[]> {
    const childIds = index.childrenOf.get(parentTaskId);
    if (!childIds || childIds.size === 0) return [];

    const children: Task[] = [];
    for (const childId of childIds) {
      const task = await this.readTask(join(this.taskDir(childId), 'task.json'));
      if (task && parentTaskIdOf(task) === parentTaskId) children.push(task);
    }

    return children.sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * Highest ancestor of a task. Walks iteratively (not recursively) and stops
   * on a repeated id.
   *
   * INVARIANT: a corrupt store must never hang or crash the daemon. A parent
   * cycle (A → B → A) used to recurse until the stack overflowed; now the walk
   * stops at the repeat and returns the highest task reached, matching the
   * cycle guard in `collectSubtreeIds` (src/task-target.ts).
   */
  async getRootTask(taskId: string): Promise<Task | null> {
    const ancestry = await this.getTaskAncestry(taskId);
    return ancestry.length > 0 ? ancestry[0] : null;
  }

  /**
   * Ancestry of a task, root first.
   *
   * INVARIANT: a corrupt store must never hang or crash the daemon. A parent
   * cycle used to spin this `while` loop forever while `unshift` grew the
   * array without bound; now a repeated id ends the walk and the chain walked
   * so far is returned, matching the cycle guard in `collectSubtreeIds`
   * (src/task-target.ts).
   */
  async getTaskAncestry(taskId: string): Promise<Task[]> {
    const ancestry: Task[] = [];
    const visited = new Set<string>();
    let currentId: string | null = taskId;

    while (currentId) {
      const task = await this.getTask(currentId);
      if (!task) break;
      if (visited.has(task.id)) {
        logger.error(
          `Corrupt task store: parent cycle detected while walking ancestry of task ${taskId}. ` +
          `Task ${task.id} is its own ancestor via ${[...visited].join(' → ')}. ` +
          `Returning the partial chain; repair the parent links of these tasks.`
        );
        break;
      }
      visited.add(task.id);
      ancestry.unshift(task); // Add to front (root first)
      currentId = parentTaskIdOf(task);
    }

    return ancestry;
  }

  async getTaskTree(rootTaskId: string): Promise<TaskTreeNode | null> {
    const rootTask = await this.getTask(rootTaskId);
    if (!rootTask) return null;

    // Reconcile the index ONCE for the whole walk; each node then costs its own
    // task.json + session.json, not a rescan of the store.
    const index = await this.ensureIndex();

    const buildNode = async (task: Task, depth: number): Promise<TaskTreeNode> => {
      const session = await this.getSessionByTaskId(task.id);
      const children = await this.childTasksFromIndex(index, task.id);
      const childNodes = await Promise.all(children.map((c) => buildNode(c, depth + 1)));

      return {
        task,
        session,
        children: childNodes,
        depth,
      };
    };

    return buildNode(rootTask, 0);
  }

  // --- Comments ---

  /**
   * Read comments for a task, with backward compatibility for legacy notes.json.
   * If comments.json exists, reads from it. Otherwise falls back to notes.json
   * and migrates the data to comments.json on read.
   */
  private async readComments(taskDir: string): Promise<Comment[]> {
    const commentsPath = join(taskDir, 'comments.json');
    const commentsFile = await this.readJson<CommentsFile>(commentsPath);
    if (commentsFile?.comments) {
      return commentsFile.comments;
    }

    // Backward compatibility: try legacy notes.json
    const notesPath = join(taskDir, 'notes.json');
    const notesFile = await this.readJson<{ notes: Comment[] }>(notesPath);
    if (notesFile?.notes && notesFile.notes.length > 0) {
      // Migrate: write to comments.json (best-effort, self-healing)
      try {
        await this.writeJson(commentsPath, { comments: notesFile.notes });
      } catch {
        // Migration failed — in-memory result still works
      }
      return notesFile.notes;
    }

    return [];
  }

  async createComment(taskId: string, content: string, actor?: ActorInput, source?: CommentSource, options?: CommentCreateOptions): Promise<Comment> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const comments = await this.readComments(this.taskDir(fullId));

      // Migrate legacy string timestamps in existing comments
      this.migrateTimestampFields(
        comments as unknown as Record<string, unknown>[],
        ['created_at']
      );

      const comment: Comment = {
        id: randomUUID(),
        task_id: fullId,
        content: normalizeRecordContent(content, 'file-storage', 'createComment', 'Comment.content'),
        created_at: Date.now(),
        ...actorFields(actor),
        ...(source ? { source } : {}),
        ...(options?.external ? { external: { ...options.external } } : {}),
        ...(options?.revises_comment_id ? { revises_comment_id: options.revises_comment_id } : {}),
      };

      comments.push(comment);

      await this.atomicWriteTask(fullId, { 'comments.json': { comments } });

      return comment;
    });
  }

  async updateComment(taskId: string, commentId: string, update: CommentUpdate, actor?: ActorInput): Promise<Comment> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const comments = await this.readComments(this.taskDir(fullId));
      this.migrateTimestampFields(
        comments as unknown as Record<string, unknown>[],
        ['created_at']
      );
      const idx = comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        throw new Error(`Comment ${commentId} not found on task ${fullId}`);
      }
      const next: Comment = { ...comments[idx] };
      if (update.content !== undefined) {
        next.content = normalizeRecordContent(update.content, 'file-storage', 'updateComment', 'Comment.content');
        next.edited_at = Date.now();
        const who = actorFields(actor);
        delete next.edited_by;
        delete next.edited_by_email;
        delete next.edited_by_name;
        if (who.actor) next.edited_by = who.actor;
        if (who.actor_email) next.edited_by_email = who.actor_email;
        if (who.actor_name) next.edited_by_name = who.actor_name;
      }
      if (update.external !== undefined) {
        next.external = { ...update.external };
      }
      comments[idx] = next;
      await this.atomicWriteTask(fullId, { 'comments.json': { comments } });
      return next;
    });
  }

  async getTaskComments(taskId: string): Promise<Comment[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const comments = await this.readComments(this.taskDir(fullId));

    // Migrate legacy string timestamps (best-effort write, no lock needed)
    const migrated = this.migrateTimestampFields(
      comments as unknown as Record<string, unknown>[],
      ['created_at']
    );
    if (migrated) {
      try {
        await this.writeJson(join(this.taskDir(fullId), 'comments.json'), { comments });
      } catch {
        // Best-effort
      }
    }

    // Records written before the MCP/`/rpc` boundaries validated their arguments
    // can lack `content` entirely; substitute a visible placeholder so a defective
    // record renders rather than crashing every reader (see repairRecordContents).
    return repairRecordContents(comments, 'comment', 'file-storage')
      .sort((a, b) => a.created_at - b.created_at);
  }

  // --- Journal ---
  //
  // Stored in journal.json (deliberately distinct from comments.json and the
  // legacy notes.json so the two can never collide). Prompt assembly reads
  // journal.json for exactly one thing — COUNTING entries new since the last
  // agent turn, for the count-only notice. Entry bodies never reach a prompt.

  private async readJournal(taskDir: string): Promise<JournalEntry[]> {
    const journalPath = join(taskDir, 'journal.json');
    const journalFile = await this.readJson<JournalFile>(journalPath);
    return journalFile?.journal ?? [];
  }

  async appendJournalEntry(taskId: string, content: string, actor?: ActorInput): Promise<JournalEntry> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const journal = await this.readJournal(this.taskDir(fullId));

      const entry: JournalEntry = {
        id: randomUUID(),
        task_id: fullId,
        content: normalizeRecordContent(content, 'file-storage', 'appendJournalEntry', 'JournalEntry.content'),
        created_at: Date.now(),
        ...actorFields(actor),
      };

      journal.push(entry);

      await this.atomicWriteTask(fullId, { 'journal.json': { journal } });

      return entry;
    });
  }

  async getTaskJournal(taskId: string): Promise<JournalEntry[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const journal = await this.readJournal(this.taskDir(fullId));
    return repairRecordContents(journal, 'journal', 'file-storage')
      .sort((a, b) => a.created_at - b.created_at);
  }

  // --- Raised items (everything an agent surfaces for human eyes) ---
  //
  // ONE store, `raised-items.json`, holding blocking and non-blocking items
  // alike. `follow-ups.json` is the pre-unification store; it is read only by
  // migrateFollowUpsToRaisedItems below. See docs/design/raised-items-unified.md.

  private async readRaisedItems(taskDir: string): Promise<RaisedItem[]> {
    const file = await this.readJson<RaisedItemsFile>(join(taskDir, 'raised-items.json'));
    // Read-repair: records written before the flag existed have no `blocking`
    // and are read as `true` — that store only ever held gating items.
    return (file?.raised_items ?? []).map(repairStoredRaisedItem);
  }

  async createRaisedItem(taskId: string, input: RaisedItemInput): Promise<RaisedItem> {
    const { normalizeRaisedCreateInput, raisedDedupeKey } = await import('../raised/content');

    if (typeof input?.blocking !== 'boolean') {
      throw new Error(
        'Raised item requires an explicit `blocking` flag: true when it is a question ' +
        "or decision about this task's own scope or diff, false otherwise",
      );
    }

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const normalized = normalizeRaisedCreateInput(input);
      const content = normalizeRecordContent(
        normalized.content,
        'file-storage',
        'createRaisedItem',
        'RaisedItem.content',
      );
      if (!content.trim()) {
        throw new Error('Raised item content must not be empty');
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const dedupeKey = raisedDedupeKey({ content, ...(normalized.title ? { title: normalized.title } : {}) });

      // Hardening: an identical body raised twice on one task with the same
      // flag is one item (idempotent re-raise). Only OPEN items dedupe — once a
      // reviewer has decided one, raising the same thing again is a new
      // question, not a repeat of an answered one. Cross-task near-duplicates
      // are a separate concern; the listing groups those into recurrences.
      const existing = items.find(
        (i) =>
          i.status === 'open'
          && i.blocking === input.blocking
          && raisedDedupeKey(i) === dedupeKey,
      );
      if (existing) return existing;

      const item: RaisedItem = {
        id: randomUUID(),
        task_id: fullId,
        content,
        blocking: input.blocking,
        created_at: Date.now(),
        status: 'open',
        ...(normalized.title ? { title: normalized.title } : {}),
        ...(normalized.explanation ? { explanation: normalized.explanation } : {}),
        ...(normalized.proposed_code ? { proposed_code: normalized.proposed_code } : {}),
        ...(normalized.proposed_prompt ? { proposed_prompt: normalized.proposed_prompt } : {}),
        ...(normalized.options?.length ? { options: normalized.options } : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
        ...(input.turn_sequence != null ? { turn_sequence: input.turn_sequence } : {}),
      };

      items.push(item);

      // INVARIANT: plain storage append — no comment, no status change, no signal.
      // Raised items must never trigger an auto-turn/auto-resume (that is why
      // they are not comments).
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });

      return item;
    });
  }

  async getTaskRaisedItems(taskId: string): Promise<RaisedItem[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const items = await this.readRaisedItems(this.taskDir(fullId));
    return repairRecordContents(items, 'raised-item', 'file-storage')
      .sort((a, b) => a.created_at - b.created_at);
  }

  async addRaisedItemComment(
    taskId: string,
    itemId: string,
    input: {
      content: string;
      actor: ActorInput;
      session_id?: string | null;
      turn_sequence?: number | null;
    },
  ): Promise<RaisedItem> {
    const content = normalizeRecordContent(
      input.content,
      'file-storage',
      'addRaisedItemComment',
      'RaisedItemComment.content',
    );
    if (!content.trim()) {
      throw new Error('Raised item comment must not be empty');
    }

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const idx = items.findIndex(
        (i) => i.id === itemId || i.id.startsWith(itemId),
      );
      if (idx < 0) {
        throw new Error(`Raised item not found: ${itemId}`);
      }

      const item = items[idx]!;
      const fields = actorFields(input.actor);
      const comment: RaisedItemComment = {
        id: randomUUID(),
        content,
        created_at: Date.now(),
        // input.actor is required; actorFields omits the key when the role
        // cannot be resolved, which would leave RaisedItemComment.actor unset.
        // The fallback takes only a bare role — an ActorInput that resolved to
        // no role is an object, and writing THAT here is the corruption the
        // person-attribution map exists to prevent.
        actor: fields.actor ?? (typeof input.actor === 'string' ? input.actor : 'human'),
        ...(fields.actor_email ? { actor_email: fields.actor_email } : {}),
        ...(fields.actor_name ? { actor_name: fields.actor_name } : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
        ...(input.turn_sequence != null ? { turn_sequence: input.turn_sequence } : {}),
      };

      const comments = [...(item.comments ?? []), comment];
      const updated: RaisedItem = { ...item, comments };
      items[idx] = updated;

      // INVARIANT: passive append — does not resolve, signal, or auto-turn.
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });
      return updated;
    });
  }

  async resolveRaisedItem(
    taskId: string,
    itemId: string,
    resolution: {
      action: RaisedItemResolveAction;
      actor: ActorInput;
      response?: string | null;
      pending_comment?: string | null;
    },
  ): Promise<RaisedItem> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const idx = items.findIndex(i => i.id === itemId || i.id.startsWith(itemId));
      if (idx < 0) {
        throw new Error(`Raised item not found: ${itemId}`);
      }

      const existing = items[idx]!;
      const targetStatus = raisedStatusForAction(resolution.action);

      if (existing.comment_delivered_at != null) {
        // Already delivered — idempotent if the same status, else refuse.
        if (existing.status === targetStatus) return existing;
        throw new Error(
          `Raised item ${itemId} was already delivered as ${existing.status}; cannot re-resolve as ${targetStatus}`,
        );
      }

      if (
        (resolution.action === 'respond' || resolution.action === 'dismiss' || resolution.action === 'answer')
        && !(resolution.response && resolution.response.trim())
      ) {
        throw new Error(
          `Raised item ${resolution.action} requires a response`,
        );
      }

      // Dropped rather than overwritten, so an unset key stays ABSENT (the
      // cross-backend row-shape rule). The `resolved_by_` person because a
      // re-decision by an unattributed caller must not inherit the previous
      // decider; the undo pair because "who reopened this" describes an OPEN
      // item, and this one is decided again.
      const base = { ...existing };
      delete base.resolved_by_email;
      delete base.resolved_by_name;
      delete base.unresolved_by;
      delete base.unresolved_by_email;
      delete base.unresolved_by_name;
      dropLegacyDecisionPerson(base);
      const resolvedEmail = actorEmail(resolution.actor);
      const resolvedName = actorName(resolution.actor);
      const updated: RaisedItem = {
        ...base,
        status: targetStatus,
        resolved_at: Date.now(),
        resolved_by: actorRole(resolution.actor) ?? 'human',
        ...(resolvedEmail ? { resolved_by_email: resolvedEmail } : {}),
        ...(resolvedName ? { resolved_by_name: resolvedName } : {}),
        ...(resolution.response != null && resolution.response !== ''
          ? { resolution: resolution.response }
          : { resolution: null }),
        ...(resolution.pending_comment != null && resolution.pending_comment !== ''
          ? { pending_comment: resolution.pending_comment }
          : {}),
        // Overwrite clears a previous peer-task stamp — materialize recreates.
        promoted_task_id: null,
      };
      items[idx] = updated;
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });
      return updated;
    });
  }

  async unresolveRaisedItem(taskId: string, itemId: string, actor?: ActorInput): Promise<RaisedItem> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const idx = items.findIndex(i => i.id === itemId || i.id.startsWith(itemId));
      if (idx < 0) {
        throw new Error(`Raised item not found: ${itemId}`);
      }

      const existing = items[idx]!;
      if (existing.status === 'open') return existing;
      if (existing.comment_delivered_at != null) {
        throw new Error(
          `Raised item ${itemId} was already delivered to the agent; it cannot be undone`,
        );
      }

      // Rebuilt field-by-field rather than spread-and-delete: undo must drop
      // every trace of the resolution, and a spread would silently carry a new
      // resolution field the day one is added. The undo's OWN actor is not such
      // a trace — the decision is gone, and who reopened the item is the only
      // attribution an open item can carry.
      const undoRole = actorRole(actor);
      const undoEmail = actorEmail(actor);
      const undoName = actorName(actor);
      const updated: RaisedItem = {
        id: existing.id,
        task_id: existing.task_id,
        content: existing.content,
        blocking: existing.blocking,
        created_at: existing.created_at,
        status: 'open',
        ...(existing.title ? { title: existing.title } : {}),
        ...(existing.explanation ? { explanation: existing.explanation } : {}),
        ...(existing.proposed_code ? { proposed_code: existing.proposed_code } : {}),
        ...(existing.proposed_prompt ? { proposed_prompt: existing.proposed_prompt } : {}),
        ...(existing.options ? { options: existing.options } : {}),
        ...(existing.session_id != null ? { session_id: existing.session_id } : {}),
        ...(existing.turn_sequence != null ? { turn_sequence: existing.turn_sequence } : {}),
        ...(existing.migrated_from ? { migrated_from: existing.migrated_from } : {}),
        ...(undoRole ? { unresolved_by: undoRole } : {}),
        ...(undoEmail ? { unresolved_by_email: undoEmail } : {}),
        ...(undoName ? { unresolved_by_name: undoName } : {}),
      };
      items[idx] = updated;
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });
      return updated;
    });
  }

  async markRaisedItemCommentDelivered(
    taskId: string,
    itemId: string,
    extras?: {
      promoted_task_id?: string | null;
      promoted_task_code?: string | null;
      pending_comment?: string | null;
      delivered_turn?: number | null;
    },
  ): Promise<RaisedItem> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const idx = items.findIndex(i => i.id === itemId || i.id.startsWith(itemId));
      if (idx < 0) {
        throw new Error(`Raised item not found: ${itemId}`);
      }

      const existing = items[idx]!;
      const updated: RaisedItem = {
        ...existing,
        comment_delivered_at: existing.comment_delivered_at ?? Date.now(),
        ...(extras?.promoted_task_id
          ? { promoted_task_id: extras.promoted_task_id }
          : {}),
        ...(extras?.promoted_task_code
          ? { promoted_task_code: extras.promoted_task_code }
          : {}),
        ...(extras?.pending_comment
          ? { pending_comment: extras.pending_comment }
          : {}),
        ...(extras?.delivered_turn != null
          ? { delivered_turn: extras.delivered_turn }
          : {}),
      };
      items[idx] = updated;
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });
      return updated;
    });
  }

  async setRaisedItemBlocking(
    taskId: string,
    itemId: string,
    blocking: boolean,
    actor: ActorInput,
  ): Promise<RaisedItem> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const idx = items.findIndex(i => i.id === itemId || i.id.startsWith(itemId));
      if (idx < 0) {
        throw new Error(`Raised item not found: ${itemId}`);
      }

      const existing = items[idx]!;
      if (existing.blocking === blocking) return existing;

      const flaggedEmail = actorEmail(actor);
      const flaggedName = actorName(actor);
      const updated: RaisedItem = { ...existing, blocking, flagged_by: actorRole(actor) ?? 'human' };
      // Same absent-not-undefined rule as the resolution: the previous
      // flagger's person must not survive a re-flag by an unattributed caller.
      delete updated.flagged_by_email;
      delete updated.flagged_by_name;
      // Same pre-identity key as the decision blocks, for the same reason —
      // see dropLegacyDecisionPerson.
      delete (updated as unknown as Record<string, unknown>).flagged_by_user_id;
      if (flaggedEmail) updated.flagged_by_email = flaggedEmail;
      if (flaggedName) updated.flagged_by_name = flaggedName;
      items[idx] = updated;
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });
      return updated;
    });
  }

  async promoteRaisedItem(
    taskId: string,
    itemId: string,
    options: {
      goal?: string;
      prompt?: string;
      code?: string;
      parent?: string;
      relation?: 'peer' | 'subtask';
      actor: ActorInput;
    },
  ): Promise<import('../types').PromoteRaisedItemResult> {
    const {
      createPromotedTask,
      defaultPromotedGoalFromRaised,
      defaultPromotedPromptFromRaised,
    } = await import('../raised/promote-task');

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const originatingTask = await this.getTask(fullId);
      if (!originatingTask) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const items = await this.readRaisedItems(this.taskDir(fullId));
      const idx = items.findIndex(i => i.id === itemId || i.id.startsWith(itemId));
      if (idx < 0) {
        throw new Error(`Raised item not found: ${itemId}`);
      }

      const existing = items[idx]!;
      if (existing.status === 'promoted_peer' || existing.status === 'promoted_subtask') {
        throw new Error(
          `Raised item ${itemId} is already promoted` +
          (existing.promoted_task_id ? ` to task ${existing.promoted_task_id.slice(0, 8)}` : ''),
        );
      }
      if (existing.status !== 'open') {
        throw new Error(
          `Raised item ${itemId} is already resolved as ${existing.status}; promote is not supported`,
        );
      }

      const relation = options.relation ?? 'peer';
      const goal = (options.goal?.trim() || defaultPromotedGoalFromRaised(existing)).trim();
      if (!goal) {
        throw new Error('Promoted task goal cannot be empty');
      }

      // Parentage, code allocation, prompt and inherited launch settings are
      // the SHARED seeding path (`createPromotedTask`) — the same one discussion
      // promotion uses. Only the text defaults are the raised item's own; the
      // proposed code, when the agent supplied one, still wins over a derived one.
      const created = await createPromotedTask(this, {
        originatingTask,
        relation,
        parent: options.parent,
        goal,
        prompt: (options.prompt?.trim() || defaultPromotedPromptFromRaised(existing, originatingTask)).trim(),
        code: options.code?.trim(),
        codeSuggestion: existing.proposed_code?.trim(),
        actor: options.actor,
      });

      const promoterEmail = actorEmail(options.actor);
      const promoterName = actorName(options.actor);
      // Same rule as resolveRaisedItem: the previous decider's person does not
      // survive a new decision made by an unattributed caller.
      const promoteBase = { ...existing };
      delete promoteBase.resolved_by_email;
      delete promoteBase.resolved_by_name;
      delete promoteBase.unresolved_by;
      delete promoteBase.unresolved_by_email;
      delete promoteBase.unresolved_by_name;
      dropLegacyDecisionPerson(promoteBase);
      const updated: RaisedItem = {
        ...promoteBase,
        status: relation === 'subtask' ? 'promoted_subtask' : 'promoted_peer',
        resolved_at: Date.now(),
        resolved_by: actorRole(options.actor) ?? 'human',
        ...(promoterEmail ? { resolved_by_email: promoterEmail } : {}),
        ...(promoterName ? { resolved_by_name: promoterName } : {}),
        promoted_task_id: created.id,
        ...(created.code ? { promoted_task_code: created.code } : {}),
      };
      items[idx] = updated;
      await this.atomicWriteTask(fullId, { 'raised-items.json': { raised_items: items } });

      return { raised_item: updated, task: created };
    });
  }

  async promoteConversation(
    sessionId: string,
    options: {
      from?: number;
      to?: number;
      goal?: string;
      prompt?: string;
      code?: string;
      parent?: string;
      actor: Actor;
    },
  ): Promise<import('../types').PromoteConversationResult> {
    const { createPromotedTask } = await import('../raised/promote-task');
    const {
      CONVERSATION_PROMOTION_METADATA_KEY,
      buildConversationTaskPrompt,
      conversationPromotions,
      defaultConversationGoal,
      encodeConversationPromotion,
      formatMessageRange,
      rangesOverlap,
      resolveMessageRange,
    } = await import('../conversation/promote');
    const { resolveStoredConversation } = await import('../conversation/ask');

    // Resolve and validate BEFORE the lock: a bad id or a range past the end of
    // the transcript is the caller's error, and other writers should not queue
    // behind it.
    const resolved = await resolveStoredConversation(this, sessionId);
    if (!resolved) {
      throw new Error(`No builder conversation matches '${sessionId}'.`);
    }
    if ('ambiguous' in resolved) {
      throw new Error(
        `'${sessionId}' matches ${resolved.ambiguous.length} conversations ` +
        `(${resolved.ambiguous.map(c => c.sessionId.slice(0, 8)).join(', ')}). Use a longer prefix.`,
      );
    }
    const conv = resolved.conversation;
    const range = resolveMessageRange(conv, { from: options.from, to: options.to });

    return this.lock.withLock(async () => {
      const tasks = await this.listTasks();
      const existing = conversationPromotions(tasks, conv.sessionId);

      // An EXACT repeat is the double-submit (a refreshed POST, a re-run
      // command) and is refused by naming the task it already made. An
      // overlapping-but-different range is a second decision from the same
      // exchange and is allowed — reported, not blocked.
      const duplicate = existing.find(p => p.range.from === range.from && p.range.to === range.to);
      if (duplicate) {
        throw new Error(
          `Message${range.from === range.to ? '' : 's'} ${formatMessageRange(range)} of conversation ` +
          `${conv.sessionId.slice(0, 8)} ${range.from === range.to ? 'was' : 'were'} already promoted to task ` +
          `${duplicate.task.code ?? duplicate.task.id.slice(0, 8)}.`,
        );
      }

      const goal = (options.goal?.trim() || defaultConversationGoal(conv, range)).trim();
      if (!goal) {
        throw new Error('Promoted task goal cannot be empty');
      }

      // No originating task: a builder conversation is project-scoped, so the
      // new task is parented by `parent` alone (or lands at top level). Same
      // shared seeding path as every other promotion.
      const created = await createPromotedTask(this, {
        parent: options.parent,
        goal,
        prompt: (options.prompt?.trim() || buildConversationTaskPrompt(conv, range)).trim(),
        code: options.code?.trim(),
        actor: options.actor,
      });

      await this.updateTaskMetadata(
        created.id,
        CONVERSATION_PROMOTION_METADATA_KEY,
        encodeConversationPromotion(conv.sessionId, range),
      );

      const task = await this.getTask(created.id);
      return {
        task: task ?? created,
        session_id: conv.sessionId,
        range,
        overlapping: existing
          .filter(p => rangesOverlap(p.range, range))
          .map(p => ({ task_id: p.task.id, task_code: p.task.code ?? null, range: p.range })),
      };
    });
  }

  /**
   * One-time conversion of pre-unification `follow-ups.json` records.
   *
   * Idempotent two ways: a task whose follow-up file is already retired is
   * skipped outright, and within a file a record whose id already exists in
   * `raised-items.json` is skipped — so a run interrupted halfway converges.
   *
   * Loud on failure: an unconvertible record is reported, its task's follow-up
   * file is left in place (NOT retired), and the converted records from that
   * same file are still written — losing an open follow-up is the failure this
   * exists to prevent, so partial progress beats an all-or-nothing rollback.
   * Nothing is ever deleted; the source file is renamed, not removed.
   */
  async migrateFollowUpsToRaisedItems(): Promise<FollowUpMigrationResult> {
    const { raisedItemFromFollowUp, FollowUpConversionError } = await import('../raised/migrate');
    const result: FollowUpMigrationResult = {
      tasks_scanned: 0,
      converted: 0,
      already_migrated: 0,
      tasks_retired: 0,
      failures: [],
    };

    return this.lock.withLock(async () => {
      const dirs = await this.listTaskDirNames('Follow-up migration');

      for (const dir of dirs) {
        const taskDir = join(this.tasksPath, dir);
        const legacyPath = join(taskDir, 'follow-ups.json');

        // Read the legacy file directly rather than through readJson(), which
        // maps every failure to null: a task with NO follow-ups (ENOENT) and a
        // task whose follow-ups are unreadable must not look the same here, or
        // a corrupt file would be skipped forever with nobody told.
        let file: LegacyFollowUpsFile | null;
        try {
          file = JSON.parse(await readFile(legacyPath, 'utf-8')) as LegacyFollowUpsFile;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          result.tasks_scanned++;
          result.failures.push({
            task_id: dir,
            reason: `could not read ${legacyPath}: ${(err as Error).message}`,
          });
          continue;
        }
        if (!file) continue;
        result.tasks_scanned++;

        const records = Array.isArray(file.follow_ups) ? file.follow_ups : null;
        if (!records) {
          result.failures.push({
            task_id: dir,
            reason: `${legacyPath} has no follow_ups array`,
          });
          continue;
        }

        const task = await this.readTask(join(taskDir, 'task.json'));
        if (!task) {
          result.failures.push({
            task_id: dir,
            reason: `task.json is missing or unreadable, so ${records.length} follow-up(s) cannot be attributed`,
          });
          continue;
        }

        const items = await this.readRaisedItems(taskDir);
        const existingIds = new Set(items.map((i) => i.id));
        const converted: RaisedItem[] = [];
        let failedHere = false;

        for (const record of records) {
          if (record && typeof record.id === 'string' && existingIds.has(record.id)) {
            result.already_migrated++;
            continue;
          }
          try {
            converted.push(raisedItemFromFollowUp(record, task.id));
          } catch (err) {
            failedHere = true;
            result.failures.push({
              task_id: task.id,
              ...(err instanceof FollowUpConversionError && err.followUpId
                ? { follow_up_id: err.followUpId }
                : {}),
              reason: (err as Error).message,
            });
          }
        }

        if (converted.length > 0) {
          // Converted items go AFTER existing raised items: the store is read
          // oldest-first by created_at anyway, and appending leaves already
          // stored records byte-identical.
          await this.atomicWriteTask(task.id, {
            'raised-items.json': { raised_items: [...items, ...converted] },
          });
          result.converted += converted.length;
        }

        if (failedHere) {
          logger.error(
            `Follow-up migration: task ${task.code ?? task.id.slice(0, 8)} has ` +
            `${result.failures.length} unconvertible record(s); ${legacyPath} left in place for retry`,
          );
          continue;
        }

        // Retire the source file by RENAME, never delete — it stays on disk as
        // the pre-migration record.
        try {
          await rename(legacyPath, join(taskDir, 'follow-ups.migrated.json'));
          result.tasks_retired++;
        } catch (err) {
          result.failures.push({
            task_id: task.id,
            reason: `converted ${converted.length} record(s) but could not retire ${legacyPath}: ${(err as Error).message}`,
          });
        }
      }

      return result;
    });
  }

  /**
   * One-time migration of stored attribution off the control plane's user id
   * and onto the email the store now names people by (§3.8 of
   * docs/design/actor-identity-and-remote-clients.md).
   *
   * Idempotent: a file is rewritten only when a legacy key was actually found,
   * so a migrated store is walked, changes nothing and reports zeroes — safe on
   * every daemon start, and a run interrupted half-way converges on the next.
   *
   * Loud, not silent: an id that is not an email cannot be carried into a field
   * that promises one, so it is DROPPED — and the count, plus the distinct ids
   * themselves, come back in the result for the daemon to report. A file that
   * cannot be read or written is a failure, not a skip: it is left exactly as
   * it was and retried on the next start.
   */
  async migrateActorIdentity(): Promise<ActorIdentityMigrationResult> {
    const { rewriteAttributedFile, emptyTally, ATTRIBUTED_TASK_FILES, CLEARED_ID_REPORT_CAP } =
      await import('./actor-identity-migration');

    const tally = emptyTally();
    const failures: ActorIdentityMigrationResult['failures'] = [];
    let tasksScanned = 0;
    let filesRewritten = 0;

    return this.lock.withLock(async () => {
      const dirs = await this.listTaskDirNames('Actor identity migration');

      for (const dir of dirs) {
        const taskDir = join(this.tasksPath, dir);
        tasksScanned++;

        for (const fileName of ATTRIBUTED_TASK_FILES) {
          const filePath = join(taskDir, fileName);
          // Read directly rather than through readJson(), which maps every
          // failure to null: a task that simply has no comments (ENOENT) and one
          // whose comments.json is corrupt must not look the same here, or a
          // file holding real attribution would be skipped forever in silence.
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(filePath, 'utf-8'));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            failures.push({
              task_id: dir,
              file: fileName,
              reason: `could not read ${filePath}: ${(err as Error).message}`,
            });
            continue;
          }

          if (!rewriteAttributedFile(fileName, parsed, tally)) continue;

          try {
            await this.atomicWriteTask(dir, { [fileName]: parsed });
            filesRewritten++;
          } catch (err) {
            failures.push({
              task_id: dir,
              file: fileName,
              reason: `rewrote ${fileName} in memory but could not persist it: ${(err as Error).message}`,
            });
          }
        }
      }

      const clearedIds = [...tally.clearedIds];
      return {
        tasks_scanned: tasksScanned,
        files_rewritten: filesRewritten,
        carried: tally.carried,
        cleared: tally.cleared,
        cleared_ids: clearedIds.slice(0, CLEARED_ID_REPORT_CAP),
        cleared_ids_truncated: clearedIds.length > CLEARED_ID_REPORT_CAP,
        failures,
      };
    });
  }
  // --- Turn reports (structured end-of-turn summaries) ---

  private async readTurnReports(taskDir: string): Promise<TurnReport[]> {
    const file = await this.readJson<TurnReportsFile>(join(taskDir, 'turn-reports.json'));
    return file?.turn_reports ?? [];
  }

  async upsertTurnReport(taskId: string, input: TurnReportInput): Promise<TurnReport> {
    const sections = normalizeTurnReportSections(input.sections);
    // `resolved: true` — this is the SAVE boundary, and what reaches it has
    // already been through the expansion boundary (src/daemon/presentation-expand.ts),
    // which re-derives `matched` for every pattern and strips it from every
    // literal path. Normalizing it away again would un-resolve the partition.
    const presentation = normalizeReviewPresentation(input.presentation, { resolved: true });
    if (presentation?.groups) {
      // INVARIANT (final-turn design §6.1): the presentation is the review
      // region partition, and its file items are claims of membership. Two
      // groups claiming the same file is refused here — at the one boundary
      // every writer funnels through — rather than at render time, where it
      // would quietly double-count a file.
      assertNoWholeFileClaimTwice(presentation.groups);
    }
    if (!input.session_id || typeof input.session_id !== 'string' || !input.session_id.trim()) {
      throw new Error('Turn report session_id must be a non-empty string');
    }
    const sessionId = input.session_id.trim();
    const raisedIds = input.raised_item_ids?.filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const reports = await this.readTurnReports(this.taskDir(fullId));
      const now = Date.now();
      const existingIdx = reports.findIndex((r) => r.session_id === sessionId);

      // INVARIANT (final-turn design §6.1): groups carry STABLE ids, minted
      // here — the one place every writer funnels through, with the task's
      // previous presentation in reach — so overlays and sign-offs survive a
      // re-sent report. The predecessor is the report being replaced when
      // this session already filed one, else the task's newest stored one.
      if (presentation?.groups) {
        const replaced = existingIdx >= 0 ? reports[existingIdx] : undefined;
        const previousPresentation =
          replaced?.presentation ??
          [...reports]
            .filter((r) => r.session_id !== sessionId && r.presentation)
            .sort((a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at))[0]
            ?.presentation;
        presentation.groups = assignPresentationGroupIds(
          presentation.groups,
          previousPresentation?.groups ?? [],
        );
      }

      // INVARIANT: latest-wins per session — replace in place, never append a
      // second report for the same session (review would otherwise see noise).
      // INVARIANT: passive write — no status change, no turn-end signal.
      // INVARIANT: a recorded cap refusal is HISTORY and survives the report
      // being replaced. The agent that hit a cap re-sends a walkthrough that
      // fits, and that smaller walkthrough is precisely what the record
      // explains — clearing it here would make the cap invisible again the
      // moment it had done its work.
      const capRefusal = input.presentation_cap_refusal
        ?? (existingIdx >= 0 ? reports[existingIdx]!.presentation_cap_refusal : undefined);

      // INVARIANT: recording a refusal NEVER deletes a stored walkthrough.
      // A report that omits `presentation` normally revokes it — latest-wins
      // per session is how an agent withdraws one — but a refusal write is
      // not the agent re-filing its report: it is lazy recording that the
      // walkthrough the agent sent was REFUSED, alongside the sections that
      // arrived with it. Taking the revocation path there would leave the
      // review with no partition at all whenever a cap-refused call was the
      // last one of a turn (the agent gave up, wrote prose, or was killed) —
      // the exact "the branch is unregioned" failure this feature exists to
      // prevent, arriving through the code that reports the cap.
      const storedPresentation = presentation
        ?? (input.presentation_cap_refusal && existingIdx >= 0
          ? reports[existingIdx]!.presentation
          : undefined);

      // The head stamp travels with the walkthrough it describes, so it
      // follows `storedPresentation` and not `presentation`. A NEW walkthrough
      // carries the caller's stamp; one KEPT across a cap refusal keeps its
      // own, because it still describes the head it was written against;
      // and a report that revokes its walkthrough drops both. A stale SHA
      // outliving its walkthrough would tell the supervisor a walkthrough
      // exists at this head when none does.
      const storedHeadSha = presentation
        ? input.presentation_head_sha
        : (storedPresentation && existingIdx >= 0
          ? reports[existingIdx]!.presentation_head_sha
          : undefined);

      if (existingIdx >= 0) {
        const prev = reports[existingIdx]!;
        const updated: TurnReport = {
          ...prev,
          sections,
          ...(capRefusal ? { presentation_cap_refusal: capRefusal } : {}),
          updated_at: now,
          ...(raisedIds && raisedIds.length > 0 ? { raised_item_ids: raisedIds } : { raised_item_ids: undefined }),
          ...(input.turn_sequence != null ? { turn_sequence: input.turn_sequence } : {}),
          ...(storedPresentation ? { presentation: storedPresentation } : { presentation: undefined }),
          ...(storedPresentation && storedHeadSha
            ? { presentation_head_sha: storedHeadSha }
            : { presentation_head_sha: undefined }),
        };
        if (!storedPresentation || !storedHeadSha) {
          delete updated.presentation_head_sha;
        }
        // Clear raised_item_ids when caller omits / passes empty
        if (!raisedIds || raisedIds.length === 0) {
          delete updated.raised_item_ids;
        }
        if (!storedPresentation) {
          delete updated.presentation;
        }
        reports[existingIdx] = updated;
        await this.atomicWriteTask(fullId, { 'turn-reports.json': { turn_reports: reports } });
        return updated;
      }

      const created: TurnReport = {
        id: randomUUID(),
        task_id: fullId,
        session_id: sessionId,
        sections,
        created_at: now,
        ...(raisedIds && raisedIds.length > 0 ? { raised_item_ids: raisedIds } : {}),
        ...(input.turn_sequence != null ? { turn_sequence: input.turn_sequence } : {}),
        ...(presentation ? { presentation } : {}),
        ...(presentation && storedHeadSha ? { presentation_head_sha: storedHeadSha } : {}),
        ...(capRefusal ? { presentation_cap_refusal: capRefusal } : {}),
      };
      reports.push(created);
      await this.atomicWriteTask(fullId, { 'turn-reports.json': { turn_reports: reports } });
      return created;
    });
  }

  async getTaskTurnReports(taskId: string): Promise<TurnReport[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];
    const reports = await this.readTurnReports(this.taskDir(fullId));
    return [...reports].sort((a, b) => a.created_at - b.created_at);
  }

  async getTurnReportBySession(taskId: string, sessionId: string): Promise<TurnReport | null> {
    const reports = await this.getTaskTurnReports(taskId);
    return reports.find((r) => r.session_id === sessionId) ?? null;
  }

  async stampTurnReportSequence(
    taskId: string,
    sessionId: string,
    turnSequence: number,
  ): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return; // best-effort no-op
      const reports = await this.readTurnReports(this.taskDir(fullId));
      const idx = reports.findIndex((r) => r.session_id === sessionId);
      if (idx < 0) return;
      const prev = reports[idx]!;
      if (prev.turn_sequence === turnSequence) return;
      reports[idx] = { ...prev, turn_sequence: turnSequence };
      await this.atomicWriteTask(fullId, { 'turn-reports.json': { turn_reports: reports } });
    });
  }

  // --- File decisions (protected/maintain keep justifications) ---

  private async readFileDecisions(taskDir: string): Promise<FileDecision[]> {
    const file = await this.readJson<FileDecisionsFile>(join(taskDir, 'file-decisions.json'));
    return file?.file_decisions ?? [];
  }

  async upsertFileDecision(taskId: string, input: FileDecisionInput): Promise<FileDecision> {
    const scope = normalizeFileDecisionScope(input.scope);
    const target = normalizeFileDecisionTarget(input.target);
    const reason = normalizeFileDecisionReason(input.reason);
    const sessionId = input.session_id?.trim() || null;

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const decisions = await this.readFileDecisions(this.taskDir(fullId));
      const now = Date.now();

      // Latest-wins: same session+scope+target, or (when no session) scope+target.
      const existingIdx = decisions.findIndex((d) => {
        if (d.scope !== scope || d.target !== target) return false;
        if (sessionId) return (d.session_id ?? null) === sessionId;
        return true;
      });

      if (existingIdx >= 0) {
        const updated: FileDecision = {
          ...decisions[existingIdx]!,
          reason,
          decision: 'keep',
          created_at: now,
          ...(sessionId ? { session_id: sessionId } : {}),
        };
        decisions[existingIdx] = updated;
        await this.atomicWriteTask(fullId, { 'file-decisions.json': { file_decisions: decisions } });
        return updated;
      }

      const created: FileDecision = {
        id: randomUUID(),
        task_id: fullId,
        scope,
        target,
        decision: 'keep',
        reason,
        created_at: now,
        ...(sessionId ? { session_id: sessionId } : {}),
      };
      decisions.push(created);
      await this.atomicWriteTask(fullId, { 'file-decisions.json': { file_decisions: decisions } });
      return created;
    });
  }

  async getTaskFileDecisions(taskId: string): Promise<FileDecision[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];
    const decisions = await this.readFileDecisions(this.taskDir(fullId));
    return [...decisions].sort((a, b) => a.created_at - b.created_at);
  }

  async listRaisedItems(options?: import('../raised').ListRaisedItemsOptions): Promise<import('../raised').ListRaisedItemsResult> {
    const { buildRaisedItemsListing } = await import('../raised');
    const rows: import('../raised').RawRaisedItemRow[] = [];

    let dirs: string[];
    try {
      dirs = await readdir(this.tasksPath);
    } catch (err) {
      // ENOENT means the store has no tasks directory yet — genuinely empty.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return buildRaisedItemsListing(rows, [], options);
      }
      throw new Error(
        `Failed to list raised items: could not read tasks directory ${this.tasksPath}: ${(err as Error).message}`,
      );
    }

    for (const dir of dirs) {
      if (dir.includes('.tmp') || dir.includes('.backup')) continue;
      const taskDir = join(this.tasksPath, dir);
      const items = await this.readRaisedItems(taskDir);
      if (!items.length) continue;

      const task = await this.readTask(join(taskDir, 'task.json'));
      if (!task) continue;

      for (const item of repairRecordContents(items, 'raised-item', 'file-storage')) {
        rows.push({ item, task });
      }
    }

    const allTasks = await this.listTasks();
    return buildRaisedItemsListing(rows, allTasks, options);
  }

  // --- Task artifacts ---
  //
  // Layout: metadata in `<taskDir>/artifacts.json`, one raw blob per artifact at
  // `<taskDir>/artifacts/<artifact-id>`. Keeping the bytes out of the index is
  // what makes `listTaskArtifacts` cheap on a task carrying a megabyte of files,
  // and keeps binary content out of a JSON document entirely.

  private artifactsDir(taskDir: string): string {
    return join(taskDir, 'artifacts');
  }

  private async readArtifacts(taskDir: string): Promise<TaskArtifact[]> {
    const file = await this.readJson<ArtifactsFile>(join(taskDir, 'artifacts.json'));
    return file?.artifacts ?? [];
  }

  async createTaskArtifact(taskId: string, input: TaskArtifactInput, actor?: Actor): Promise<TaskArtifact> {
    // Validate BEFORE taking the lock: a bad name or an oversized file is the
    // caller's error and should not make other writers queue behind it.
    const name = normalizeArtifactName(input.name);
    const bytes = Buffer.from(input.content_base64, 'base64');

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const taskDir = this.taskDir(fullId);
      const existing = await this.readArtifacts(taskDir);
      assertArtifactWithinLimits(name, bytes.length, existing);

      const binary = isBinaryContent(bytes);
      const artifact: TaskArtifact = {
        id: randomUUID(),
        task_id: fullId,
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mime_type: input.mime_type ?? guessMimeType(name, binary),
        binary,
        origin: input.origin ?? 'input',
        created_at: Date.now(),
        created_by: actor ?? 'human',
        ...(input.session_id ? { session_id: input.session_id } : {}),
      };

      // Blob first, index second. The index is the commit point: a crash between
      // the two leaves an unreferenced blob (harmless, cleaned by the next
      // replace/delete of that name), whereas the reverse order would leave an
      // index entry pointing at nothing — a read that fails instead of a byte
      // that is merely wasted.
      const dir = this.artifactsDir(taskDir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, artifact.id), bytes);

      const replaced = existing.find(a => a.name === name);
      const next = existing.filter(a => a.name !== name).concat(artifact);

      // INVARIANT: a plain storage write. No comment, no status change, no
      // signal — attaching an artifact never triggers a turn.
      await this.atomicWriteTask(fullId, { 'artifacts.json': { artifacts: next } satisfies ArtifactsFile });

      if (replaced) {
        // Only now that the new index is durable is the old blob unreachable.
        await rm(join(dir, replaced.id), { force: true });
      }

      return artifact;
    });
  }

  async listTaskArtifacts(taskId: string): Promise<TaskArtifact[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const artifacts = await this.readArtifacts(this.taskDir(fullId));
    return artifacts.sort((a, b) => a.created_at - b.created_at);
  }

  async getTaskArtifact(taskId: string, name: string): Promise<TaskArtifactContent | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;

    const normalized = normalizeArtifactName(name);
    const taskDir = this.taskDir(fullId);
    const artifact = (await this.readArtifacts(taskDir)).find(a => a.name === normalized);
    if (!artifact) return null;

    const blobPath = join(this.artifactsDir(taskDir), artifact.id);
    let bytes: Buffer;
    try {
      bytes = await readFile(blobPath);
    } catch (err) {
      // The index says this exists, so a missing blob is a corrupted store, not
      // a "not found" — say which file and which artifact rather than returning
      // null and letting the caller report a name that is demonstrably there.
      throw new Error(
        `Artifact '${normalized}' is indexed on task ${fullId} but its content is unreadable at ${blobPath}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }

    return { ...artifact, content_base64: bytes.toString('base64') };
  }

  async deleteTaskArtifact(taskId: string, name: string): Promise<boolean> {
    const normalized = normalizeArtifactName(name);

    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return false;

      const taskDir = this.taskDir(fullId);
      const existing = await this.readArtifacts(taskDir);
      const target = existing.find(a => a.name === normalized);
      if (!target) return false;

      await this.atomicWriteTask(fullId, {
        'artifacts.json': { artifacts: existing.filter(a => a.id !== target.id) } satisfies ArtifactsFile,
      });
      await rm(join(this.artifactsDir(taskDir), target.id), { force: true });
      return true;
    });
  }

  // --- Review regions ---
  //
  // Two files, deliberately: `regions.json` is the computed cover and is
  // replaced wholesale at the end of every turn; `region-overlays.json` is the
  // human layer and is never touched by a refresh. Merging them would mean the
  // next recompute silently discarded a reviewer's sign-off.

  async getRegionCover(taskId: string): Promise<RegionCover | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;
    const file = await this.readJson<RegionCoverFile>(
      join(this.taskDir(fullId), 'regions.json'),
    );
    return file?.cover ?? null;
  }

  async saveRegionCover(taskId: string, cover: RegionCover): Promise<void> {
    await this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }
      await this.atomicWriteTask(fullId, {
        'regions.json': { cover: { ...cover, task_id: fullId } } satisfies RegionCoverFile,
      });
    });
  }

  async getRegionOverlays(taskId: string): Promise<RegionOverlay[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];
    const file = await this.readJson<RegionOverlaysFile>(
      join(this.taskDir(fullId), 'region-overlays.json'),
    );
    return file?.overlays ?? [];
  }

  async setRegionOverlay(
    taskId: string,
    unitId: string,
    patch: {
      name?: string;
      owner?: string | null;
      signed_off_sha?: string | null;
      actor?: OverlayActor;
    },
  ): Promise<RegionOverlay> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const taskDir = this.taskDir(fullId);
      const file = await this.readJson<RegionOverlaysFile>(
        join(taskDir, 'region-overlays.json'),
      );
      const existing = file?.overlays ?? [];
      const prior = existing.find(o => o.unit_id === unitId);
      // Field-by-field merge: naming a region must not clear its sign-off, and
      // `signed_off_sha: null` is how a caller withdraws one (undefined means
      // "leave it alone", which is a different request).
      const next: RegionOverlay = {
        unit_id: unitId,
        ...(prior ?? {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        updated_at: Date.now(),
      };
      // `null` clears the owner, `undefined` leaves it alone — the same
      // three-state convention the sign-off below uses, so "unassign" is
      // expressible without a second verb.
      //
      // ATTRIBUTION FOLLOWS THE FIELD, and is REPLACED rather than merged: a
      // write that changes the owner records who changed it, and an
      // unattributable one removes the previous name instead of leaving it
      // standing over somebody else's edit. Whoever is named must be whoever
      // made the value that is there now.
      if (patch.owner === null) {
        delete next.owner;
        delete next.owner_set_by;
      } else if (patch.owner !== undefined) {
        next.owner = patch.owner;
        if (patch.actor) next.owner_set_by = patch.actor;
        else delete next.owner_set_by;
      }
      if (patch.signed_off_sha === null) {
        delete next.signed_off_sha;
        delete next.signed_off_at;
        delete next.signed_off_by;
      } else if (patch.signed_off_sha !== undefined) {
        next.signed_off_sha = patch.signed_off_sha;
        next.signed_off_at = Date.now();
        if (patch.actor) next.signed_off_by = patch.actor;
        else delete next.signed_off_by;
      }
      await this.atomicWriteTask(fullId, {
        'region-overlays.json': {
          overlays: existing.filter(o => o.unit_id !== unitId).concat(next),
        } satisfies RegionOverlaysFile,
      });
      return next;
    });
  }

  // --- Hunk Approvals ---

  async listHunkApprovals(taskId: string): Promise<HunkApproval[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];
    const file = await this.readJson<HunkApprovalsFile>(
      join(this.taskDir(fullId), 'hunk-approvals.json'),
    );
    return file?.approvals ?? [];
  }

  async createHunkApproval(
    taskId: string,
    hunkHash: string,
    actor?: Actor,
    lineage?: HunkApprovalLineage,
  ): Promise<HunkApproval> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const file = await this.readJson<HunkApprovalsFile>(
        join(this.taskDir(fullId), 'hunk-approvals.json'),
      );
      const approvals = file?.approvals ?? [];

      // Idempotent: a re-press of `o` on a hunk that's already approved
      // returns the existing record without duplicating a row.
      const existing = approvals.find(a => a.hunk_hash === hunkHash);
      if (existing) return existing;

      const approval: HunkApproval = {
        id: randomUUID(),
        task_id: fullId,
        hunk_hash: hunkHash,
        approved_at: Date.now(),
        ...(actor ? { approved_by: actor } : {}),
        ...(lineage ? {
          parent_file: lineage.parent_file,
          parent_lines: lineage.parent_lines,
          split_path: lineage.split_path,
        } : {}),
      };
      approvals.push(approval);

      await this.atomicWriteTask(fullId, { 'hunk-approvals.json': { approvals } });
      return approval;
    });
  }

  // --- Review Comments ---

  private reviewCommentsPath(fullId: string): string {
    return join(this.taskDir(fullId), 'review-comments.json');
  }

  async getTaskReviewComments(taskId: string): Promise<ReviewComment[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];
    const file = await this.readJson<ReviewCommentsFile>(this.reviewCommentsPath(fullId));
    return (file?.review_comments ?? []).sort((a, b) => a.created_at - b.created_at);
  }

  async createReviewComment(taskId: string, input: ReviewCommentInput): Promise<ReviewComment> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const file = await this.readJson<ReviewCommentsFile>(this.reviewCommentsPath(fullId));
      const comments = file?.review_comments ?? [];

      const id = randomUUID();
      const comment: ReviewComment = {
        id,
        task_id: fullId,
        // A root comment is its own thread; a reply carries the root's id.
        thread_id: input.threadId ?? id,
        file: input.file,
        line: input.line,
        side: input.side,
        role: input.role,
        content: input.content,
        created_at: Date.now(),
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.askState ? { ask_state: input.askState } : {}),
        ...(input.deliveryState ? { delivery_state: input.deliveryState } : {}),
        ...(input.turnNumber !== undefined ? { turn_number: input.turnNumber } : {}),
        ...(input.anchorSnippet ? { anchor_snippet: input.anchorSnippet } : {}),
      };
      comments.push(comment);

      await this.atomicWriteTask(fullId, { 'review-comments.json': { review_comments: comments } });
      return comment;
    });
  }

  async updateReviewComment(
    taskId: string,
    commentId: string,
    update: ReviewCommentUpdate,
  ): Promise<ReviewComment> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const file = await this.readJson<ReviewCommentsFile>(this.reviewCommentsPath(fullId));
      const comments = file?.review_comments ?? [];
      const existing = comments.find(c => c.id === commentId);
      if (!existing) {
        throw new Error(`Review comment not found: ${commentId} (task ${taskId})`);
      }

      // Only delivery bookkeeping and withdrawal are mutable — the human's
      // words, the anchor, and the intent are immutable once written.
      // Withdrawal is one-way: set, never cleared.
      if (update.withdrawnAt !== undefined) existing.withdrawn_at = update.withdrawnAt;
      // Filing is one-way and idempotent: the FIRST filing owns the timestamp,
      // so a later unblock cannot re-date a message that was already filed.
      if (update.filedAt !== undefined && existing.filed_at == null) existing.filed_at = update.filedAt;
      if (update.askState !== undefined) existing.ask_state = update.askState;
      if (update.deliveryState !== undefined) existing.delivery_state = update.deliveryState;
      if (update.deliveredTurn !== undefined) existing.delivered_turn = update.deliveredTurn;
      if (update.deliveredAt !== undefined) existing.delivered_at = update.deliveredAt;
      if (update.turnNumber !== undefined) existing.turn_number = update.turnNumber;
      // Promotion is one-way and idempotent, like filing: the FIRST promotion
      // owns the link, so a second reviewer pressing Promote cannot silently
      // repoint the thread at a different task.
      if (update.promotedTaskId !== undefined && existing.promoted_task_id == null) {
        existing.promoted_task_id = update.promotedTaskId;
        if (update.promotedTaskCode) existing.promoted_task_code = update.promotedTaskCode;
      }
      if (update.askError !== undefined) {
        if (update.askError === null) delete existing.ask_error;
        else existing.ask_error = update.askError;
      }

      await this.atomicWriteTask(fullId, { 'review-comments.json': { review_comments: comments } });
      return existing;
    });
  }

  // --- Review Drafts ---

  private reviewDraftsPath(fullId: string): string {
    return join(this.taskDir(fullId), 'review-drafts.json');
  }

  /**
   * Read the drafts file, telling "there is none" apart from "there is one and
   * it is broken".
   *
   * `readJson` collapses both into null, which is fine for a record that can be
   * regenerated — and wrong here. A draft is human feedback: a parse error
   * answered as "no drafts" makes the very next autosave overwrite the file
   * with a single draft, deleting every reviewer's unsent words on the task.
   * So ENOENT falls through to empty and anything else is surfaced, refusing
   * the write and leaving the file for a human to look at.
   */
  private async readReviewDrafts(fullId: string): Promise<ReviewDraftState[]> {
    const path = this.reviewDraftsPath(fullId);
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        `failed to read review drafts at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `review drafts at ${path} are not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to overwrite them — they hold unsent review feedback. Fix or move the file, then retry.`,
      );
    }

    const drafts = (parsed as ReviewDraftsFile | null)?.review_drafts;
    if (drafts === undefined || drafts === null) return [];
    if (!Array.isArray(drafts)) {
      throw new Error(
        `review drafts at ${path} have a "review_drafts" key that is not an array. ` +
          `Refusing to overwrite them — they hold unsent review feedback. Fix or move the file, then retry.`,
      );
    }
    return drafts as ReviewDraftState[];
  }

  async getReviewDraft(taskId: string, reviewer: string): Promise<ReviewDraftState | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;
    const drafts = await this.readReviewDrafts(fullId);
    return drafts.find(d => d.reviewer === reviewer) ?? null;
  }

  async saveReviewDraft(
    taskId: string,
    reviewer: string,
    patch: ReviewDraftPatch,
  ): Promise<ReviewDraftState> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const drafts = await this.readReviewDrafts(fullId);
      let draft = drafts.find(d => d.reviewer === reviewer);
      if (!draft) {
        draft = emptyReviewDraft(fullId, reviewer);
        drafts.push(draft);
      }

      // A PATCH: an omitted key keeps whatever is stored. Autosaving one box
      // must never blank another box the reviewer filled in elsewhere.
      if (patch.feedback !== undefined) draft.feedback = patch.feedback;
      if (patch.acceptReason !== undefined) draft.accept_reason = patch.acceptReason;
      if (patch.sessionMessage !== undefined) draft.session_message = patch.sessionMessage;
      // MERGED PER FILE, and an EMPTY STRING is how a tick is taken back.
      //
      // It used to be replaced wholesale, with an omitted key meaning "untick".
      // That made the map only as complete as the caller's knowledge of it: a
      // client that had not yet READ the draft — which on Lazy Teams is every
      // client for the length of one request, because the read rides the
      // member's own actor token and cannot be done at render time — destroyed
      // every tick it did not know about simply by ticking one file. Quiet loss
      // of a reviewer's own recorded state, and no ordering rule on any one
      // client can close it for the next caller. So the store refuses to be
      // clobberable instead: same shape as `line_drafts` below, for the same
      // reason.
      //
      // An untick is now SAID, not implied. Callers: the dashboard island
      // (src/server/viewed-cards.ts) and Lazy Teams' review-viewed controller.
      if (patch.viewedFiles !== undefined) {
        const merged = { ...(draft.viewed_files ?? {}) };
        for (const [file, hash] of Object.entries(patch.viewedFiles)) {
          if (hash === '') {
            delete merged[file];
            continue;
          }
          // The cap refuses ONE new file rather than the whole write, for the
          // same reason line drafts do: an autosave batches fields, and
          // throwing here would take an unrelated box's words with it.
          if (!(file in merged) && Object.keys(merged).length >= MAX_VIEWED_FILES) continue;
          merged[file] = hash;
        }
        draft.viewed_files = merged;
      }
      // MERGED PER ANCHOR, not replaced — as viewed ticks now are too. Two tabs
      // open on one review is ordinary use, and each holds the map it was
      // seeded with; a wholesale write from either erases every box the other
      // has opened since. So a patch names only the anchors it is changing, and
      // an EMPTY STRING is how a box that was sent or cancelled is removed (a
      // draft with no text is nothing anyway). The bound is re-checked on the
      // merged result: a per-patch limit alone is no limit at all once patches
      // accumulate.
      //
      // THE CAP REFUSES ONE ANCHOR, NEVER THE WHOLE WRITE. The autosave
      // debounce batches every field changed in its window into one patch, so
      // throwing here took the feedback box's words down with a limit the
      // reviewer cannot see and never asked about — a feedback-loss path hiding
      // inside a bound check. Instead: deletions always apply (they only
      // shrink), an anchor that is already stored always updates (the box the
      // reviewer is typing in), and only a NEW anchor past the cap is refused.
      // A refused anchor is visible to the caller without a side channel: the
      // saved draft comes back from this call, so a key the caller asked to
      // store and does not find in it was refused. The web route turns that
      // comparison into a message (src/server/index.ts), because failing mute
      // is the half of the old behaviour that was actually wrong.
      if (patch.lineDrafts !== undefined) {
        const merged = { ...(draft.line_drafts ?? {}) };
        for (const [anchor, text] of Object.entries(patch.lineDrafts)) {
          if (text === '') {
            delete merged[anchor];
            continue;
          }
          if (!(anchor in merged) && Object.keys(merged).length >= MAX_LINE_DRAFTS) continue;
          merged[anchor] = text;
        }
        draft.line_drafts = merged;
      }
      draft.updated_at = Date.now();

      await this.atomicWriteTask(fullId, { 'review-drafts.json': { review_drafts: drafts } });
      return draft;
    });
  }

  async deleteReviewDraft(taskId: string, reviewer: string): Promise<boolean> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return false;

      const drafts = await this.readReviewDrafts(fullId);
      const remaining = drafts.filter(d => d.reviewer !== reviewer);
      if (remaining.length === drafts.length) return false;

      await this.atomicWriteTask(fullId, { 'review-drafts.json': { review_drafts: remaining } });
      return true;
    });
  }

  // --- Review Sessions ---

  private reviewSessionPath(fullId: string): string {
    return join(this.taskDir(fullId), 'review-session.json');
  }

  /** Locate the task dir holding a session id (one session per task in v1). */
  private async findTaskIdByReviewSessionId(sessionId: string): Promise<string | null> {
    const tasksDir = join(this.basePath, 'tasks');
    let entries: string[];
    try {
      entries = await readdir(tasksDir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`failed to list tasks dir ${tasksDir}: ${err.message}`);
    }

    for (const entry of entries) {
      // atomicWriteTask stages under `<taskId>.tmp.<ts>/` beside the live task
      // dir. A poll that matched staging would read a path deleted milliseconds
      // later in the write's finally block — listReviewSessionMessages then
      // throws "Review session not found" and the poll endpoint 500'd.
      if (entry.includes('.tmp') || entry.includes('.backup')) continue;
      const fullId = entry;
      const file = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
      if (file?.review_session?.id === sessionId) {
        return fullId;
      }
    }
    return null;
  }

  private defaultReviewSessionMessageDelivery(
    role: ReviewSessionMessage['role'],
  ): ReviewSessionMessage['delivery'] {
    return role === 'human' ? 'pending' : 'launched';
  }

  async createReviewSession(taskId: string): Promise<ReviewSession> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const existing = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
      if (existing?.review_session) {
        throw new Error(`Review session already exists for task ${taskId}`);
      }

      const now = Date.now();
      const session: ReviewSession = {
        id: `rs_${randomUUID()}`,
        task_id: fullId,
        status: 'idle',
        resume_session_id: null,
        created_at: now,
        updated_at: now,
        messages: [],
      };

      await this.atomicWriteTask(fullId, { 'review-session.json': { review_session: session } });
      return session;
    });
  }

  async getReviewSessionByTaskId(taskId: string): Promise<ReviewSession | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;
    const file = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
    if (!file?.review_session) return null;
    const session = file.review_session;
    return {
      ...session,
      messages: [...(session.messages ?? [])].sort((a, b) => a.created_at - b.created_at),
    };
  }

  async updateReviewSession(sessionId: string, patch: ReviewSessionUpdate): Promise<ReviewSession> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByReviewSessionId(sessionId);
      if (!fullId) {
        throw new Error(`Review session not found: ${sessionId}`);
      }

      const file = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
      const session = file?.review_session;
      if (!session || session.id !== sessionId) {
        throw new Error(`Review session not found: ${sessionId}`);
      }

      if (patch.status !== undefined) session.status = patch.status;
      if (patch.resumeSessionId !== undefined) {
        session.resume_session_id = patch.resumeSessionId;
      }
      session.updated_at = Date.now();

      await this.atomicWriteTask(fullId, { 'review-session.json': { review_session: session } });
      return {
        ...session,
        messages: [...session.messages].sort((a, b) => a.created_at - b.created_at),
      };
    });
  }

  async appendReviewSessionMessage(
    sessionId: string,
    input: ReviewSessionMessageInput,
  ): Promise<ReviewSessionMessage> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByReviewSessionId(sessionId);
      if (!fullId) {
        throw new Error(`Review session not found: ${sessionId}`);
      }

      const file = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
      const session = file?.review_session;
      if (!session || session.id !== sessionId) {
        throw new Error(`Review session not found: ${sessionId}`);
      }

      const message: ReviewSessionMessage = {
        id: randomUUID(),
        role: input.role,
        content: input.content,
        created_at: Date.now(),
        delivery: input.delivery ?? this.defaultReviewSessionMessageDelivery(input.role),
      };
      session.messages.push(message);
      session.updated_at = Date.now();

      await this.atomicWriteTask(fullId, { 'review-session.json': { review_session: session } });
      return message;
    });
  }

  async updateReviewSessionMessage(
    sessionId: string,
    messageId: string,
    patch: ReviewSessionMessageUpdate,
  ): Promise<ReviewSessionMessage> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByReviewSessionId(sessionId);
      if (!fullId) {
        throw new Error(`Review session not found: ${sessionId}`);
      }

      const file = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
      const session = file?.review_session;
      if (!session || session.id !== sessionId) {
        throw new Error(`Review session not found: ${sessionId}`);
      }

      const existing = session.messages.find(m => m.id === messageId);
      if (!existing) {
        throw new Error(`Review session message not found: ${messageId} (session ${sessionId})`);
      }

      // Only delivery bookkeeping is mutable — the words are immutable once written.
      if (patch.delivery !== undefined) existing.delivery = patch.delivery;
      session.updated_at = Date.now();

      await this.atomicWriteTask(fullId, { 'review-session.json': { review_session: session } });
      return existing;
    });
  }

  async listReviewSessionMessages(sessionId: string): Promise<ReviewSessionMessage[]> {
    const fullId = await this.findTaskIdByReviewSessionId(sessionId);
    if (!fullId) {
      throw new Error(`Review session not found: ${sessionId}`);
    }
    const file = await this.readJson<ReviewSessionFile>(this.reviewSessionPath(fullId));
    const session = file?.review_session;
    if (!session || session.id !== sessionId) {
      throw new Error(`Review session not found: ${sessionId}`);
    }
    return [...session.messages].sort((a, b) => a.created_at - b.created_at);
  }

  // --- Conversations ---

  private get conversationsPath(): string {
    return join(this.basePath, 'conversations');
  }

  /**
   * Sidecar listing index. Lives NEXT TO `conversations/`, never inside it, so
   * a scan of transcript files cannot confuse the index for a conversation.
   * Derived: missing/stale/corrupt → rebuild from the transcript files. Never
   * a second source of truth, and a failed index write must not touch those
   * files (see saveConversation / deleteConversation).
   */
  private get conversationIndexPath(): string {
    return join(this.basePath, CONVERSATION_INDEX_FILENAME);
  }

  async saveConversation(conversation: StoredConversation): Promise<void> {
    await mkdir(this.conversationsPath, { recursive: true });
    const path = join(this.conversationsPath, `${conversation.sessionId}.json`);
    await writeFile(path, JSON.stringify(conversation, null, 2), 'utf-8');
    // Transcript is durable before the index is touched. A failed index update
    // is recovered on the next listConversationSummaries rebuild.
    await this.upsertConversationIndexEntry(conversation, path);
  }

  async loadConversation(sessionId: string): Promise<StoredConversation | null> {
    try {
      const content = await readFile(
        join(this.conversationsPath, `${sessionId}.json`),
        'utf-8'
      );
      return JSON.parse(content) as StoredConversation;
    } catch {
      return null;
    }
  }

  async listConversations(): Promise<StoredConversation[]> {
    const conversations: StoredConversation[] = [];

    for (const file of await this.listConversationTranscriptFiles()) {
      try {
        const content = await readFile(file.path, 'utf-8');
        conversations.push(JSON.parse(content) as StoredConversation);
      } catch {
        // Skip malformed files
      }
    }

    return sortByStartedAtDesc(conversations);
  }

  async listConversationSummaries(): Promise<ConversationSummary[]> {
    const files = await this.listConversationTranscriptFiles();
    const index = await this.readConversationIndex();
    if (index && conversationIndexMatches(index, files)) {
      return sortByStartedAtDesc(index.entries.map(indexEntryToSummary));
    }
    if (files.length === 0) {
      // Nothing to index — don't create an empty sidecar in a store that has
      // never captured a conversation. A leftover index from a full delete is
      // harmless: the next save/rebuild reconciles it.
      return [];
    }
    return this.rebuildConversationIndex(files);
  }

  async isConversationImported(sessionId: string): Promise<boolean> {
    try {
      await stat(join(this.conversationsPath, `${sessionId}.json`));
      return true;
    } catch {
      return false;
    }
  }

  async deleteConversation(sessionId: string): Promise<boolean> {
    try {
      await unlink(join(this.conversationsPath, `${sessionId}.json`));
    } catch (err) {
      // ENOENT is the idempotent case: nothing there, nothing deleted. Any
      // other failure (permissions, I/O) is a real problem the caller must see
      // — silently reporting "deleted" would let a purge claim success while
      // the store is untouched.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(
        `Failed to delete conversation ${sessionId} from ${this.conversationsPath}: ${(err as Error).message}`,
      );
    }
    await this.removeConversationIndexEntry(sessionId);
    return true;
  }

  private async listConversationTranscriptFiles(): Promise<ConversationTranscriptFile[]> {
    try {
      const names = await readdir(this.conversationsPath);
      const files: ConversationTranscriptFile[] = [];
      for (const name of names) {
        if (!isConversationTranscriptFilename(name)) continue;
        const path = join(this.conversationsPath, name);
        try {
          const st = await stat(path);
          if (!st.isFile()) continue;
          files.push({
            sessionId: name.slice(0, -'.json'.length),
            path,
            mtimeMs: Math.trunc(st.mtimeMs),
            size: st.size,
          });
        } catch {
          // File disappeared between readdir and stat — skip it.
        }
      }
      return files;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        `Failed to read conversations directory ${this.conversationsPath}: ${(err as Error).message}`,
      );
    }
  }

  private async readConversationIndex(): Promise<ConversationIndexFile | null> {
    try {
      const raw = await readFile(this.conversationIndexPath, 'utf-8');
      const parsed = JSON.parse(raw) as ConversationIndexFile;
      if (parsed?.version !== CONVERSATION_INDEX_VERSION || !Array.isArray(parsed.entries)) {
        return null;
      }
      return parsed;
    } catch (err) {
      // Missing, unreadable, or corrupt: the transcripts are the source of
      // truth, so we rebuild rather than error.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async writeConversationIndex(index: ConversationIndexFile): Promise<void> {
    await this.writeJson(this.conversationIndexPath, index);
  }

  private async rebuildConversationIndex(
    files: ConversationTranscriptFile[],
  ): Promise<ConversationSummary[]> {
    const entries: ConversationIndexEntry[] = [];
    for (const file of files) {
      try {
        const conv = JSON.parse(await readFile(file.path, 'utf-8')) as StoredConversation;
        if (!conv?.sessionId) continue;
        entries.push(toIndexEntry(conv, file));
      } catch {
        // Skip malformed files — same policy as listConversations.
      }
    }
    try {
      await this.writeConversationIndex({ version: CONVERSATION_INDEX_VERSION, entries });
    } catch (err) {
      // INVARIANT: never-corrupt-storage. The index is derived. Failing to
      // persist it must not fail the list, and must not touch transcript files.
      logger.warn(
        `Failed to write conversation index at ${this.conversationIndexPath}: ${(err as Error).message}`,
      );
    }
    return sortByStartedAtDesc(entries.map(indexEntryToSummary));
  }

  private async upsertConversationIndexEntry(
    conversation: StoredConversation,
    path: string,
  ): Promise<void> {
    try {
      const st = await stat(path);
      const file = {
        sessionId: conversation.sessionId,
        path,
        mtimeMs: Math.trunc(st.mtimeMs),
        size: st.size,
      };
      const index = (await this.readConversationIndex()) ?? {
        version: CONVERSATION_INDEX_VERSION,
        entries: [],
      };
      const entries = index.entries.filter((e) => e.sessionId !== conversation.sessionId);
      entries.push(toIndexEntry(conversation, file));
      await this.writeConversationIndex({ version: CONVERSATION_INDEX_VERSION, entries });
    } catch (err) {
      logger.warn(
        `Failed to update conversation index after saving ${conversation.sessionId}: ${(err as Error).message}`,
      );
    }
  }

  private async removeConversationIndexEntry(sessionId: string): Promise<void> {
    try {
      const index = await this.readConversationIndex();
      if (!index) return;
      const entries = index.entries.filter((e) => e.sessionId !== sessionId);
      await this.writeConversationIndex({ version: CONVERSATION_INDEX_VERSION, entries });
    } catch (err) {
      logger.warn(
        `Failed to update conversation index after deleting ${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  // --- Agent Session Logs (raw Claude Code JSONL) ---

  async saveAgentSessionLog(taskId: string, sessionId: string, content: string): Promise<void> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const taskDir = this.getTaskDir(fullId);
    await mkdir(taskDir, { recursive: true });
    // Store the JSONL byte-for-byte in its own file so resume gets an exact
    // copy; a sidecar holds the session id and capture timestamp.
    await writeFile(join(taskDir, 'agent-session.jsonl'), content, 'utf-8');
    await writeFile(
      join(taskDir, 'agent-session.json'),
      JSON.stringify({ sessionId, capturedAt: Date.now() }, null, 2),
      'utf-8',
    );
  }

  async getAgentSessionLog(taskId: string): Promise<AgentSessionLog | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;
    const taskDir = this.getTaskDir(fullId);
    let meta: { sessionId: string; capturedAt: number };
    try {
      meta = JSON.parse(await readFile(join(taskDir, 'agent-session.json'), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Failed to read agent session metadata for ${fullId}: ${(err as Error).message}`);
    }
    const content = await readFile(join(taskDir, 'agent-session.jsonl'), 'utf-8');
    return { taskId: fullId, sessionId: meta.sessionId, capturedAt: meta.capturedAt, content };
  }

  // NOTE: the proxy audit log used to live at `<store>/proxy-audit.jsonl`,
  // uncapped. It reached 677 MiB in a real store and broke a store push. It is
  // now a bounded, project-local file under `.lazy/` (src/proxy/audit-log.ts) —
  // storage is for permanent state, not telemetry. The daemon deletes any
  // leftover file at the old path on startup.

  // --- Builder Resume Intents (durable upgrade↔builder handshake) ---

  // --- Project settings overlay ---

  private get projectSettingsPath(): string {
    return join(this.basePath, 'project-settings.json');
  }

  async getProjectSettings(): Promise<ProjectSettings | null> {
    return (await this.readJson<ProjectSettings>(this.projectSettingsPath)) ?? null;
  }

  async saveProjectSettings(settings: ProjectSettings): Promise<void> {
    // Whole-record replace, so no read-modify-write and no lock needed beyond
    // writeJson's own atomic write.
    await this.writeJson(this.projectSettingsPath, settings);
  }

  private get builderResumeIntentsPath(): string {
    return join(this.basePath, 'builder-resume-intents.json');
  }

  private async readBuilderResumeIntents(): Promise<BuilderResumeIntent[]> {
    const file = await this.readJson<{ intents: BuilderResumeIntent[] }>(this.builderResumeIntentsPath);
    return file?.intents ?? [];
  }

  async saveBuilderResumeIntent(intent: BuilderResumeIntent): Promise<void> {
    // Lock so a concurrent save/take can't interleave a read-modify-write and
    // drop one of the changes.
    return this.lock.withLock(async () => {
      const intents = await this.readBuilderResumeIntents();
      const next = intents.filter(i => i.builderId !== intent.builderId);
      next.push(intent);
      await this.writeJson(this.builderResumeIntentsPath, { intents: next });
    });
  }

  async takeBuilderResumeIntent(builderId: string): Promise<BuilderResumeIntent | null> {
    // INVARIANT: take must consume+clear atomically so a given intent is acted
    // on at most once. The read, the match, and the rewrite-without-it all
    // happen under the storage lock.
    return this.lock.withLock(async () => {
      const intents = await this.readBuilderResumeIntents();
      const match = intents.find(i => i.builderId === builderId) ?? null;
      if (!match) return null;
      const remaining = intents.filter(i => i.builderId !== builderId);
      await this.writeJson(this.builderResumeIntentsPath, { intents: remaining });
      return match;
    });
  }

  async listBuilderResumeIntents(projectRoot?: string): Promise<BuilderResumeIntent[]> {
    const intents = await this.readBuilderResumeIntents();
    return projectRoot ? intents.filter(i => i.projectRoot === projectRoot) : intents;
  }

  // --- Builder Sessions (daemon-owned interactive builder registry) ---

  private get builderSessionsPath(): string {
    return join(this.basePath, 'builder-sessions.json');
  }

  private async readBuilderSessions(): Promise<BuilderSession[]> {
    const file = await this.readJson<{ sessions: BuilderSession[] }>(this.builderSessionsPath);
    return file?.sessions ?? [];
  }

  async createBuilderSession(session: BuilderSession): Promise<BuilderSession> {
    return this.lock.withLock(async () => {
      const sessions = await this.readBuilderSessions();
      if (sessions.some(s => s.id === session.id)) {
        throw new Error(`Builder session already exists: ${session.id}`);
      }
      // ONE SESSION PER MEMBER PER PROJECT (§5.7), enforced at write time.
      // This runs inside the SAME locked critical section as the insert above,
      // so the claim a start registers before launching is also the exclusion:
      // a rival start cannot slip a second active row in between the check and
      // the insert, through this method or through the raw storage proxy.
      // 'ended' rows do not count — starting again after an explicit end is
      // the normal flow. Rows from other members or other projects are theirs.
      const rival = sessions.find(s =>
        s.projectRoot === session.projectRoot &&
        s.memberEmail === session.memberEmail &&
        s.state !== 'ended');
      if (rival) {
        throw new BuilderSessionActiveError(rival.id, rival.state);
      }
      await this.writeJson(this.builderSessionsPath, { sessions: [...sessions, session] });
      return session;
    });
  }

  async getBuilderSession(id: string): Promise<BuilderSession | null> {
    const sessions = await this.readBuilderSessions();
    return sessions.find(s => s.id === id) ?? null;
  }

  async getActiveBuilderSessionForMember(
    projectRoot: string,
    memberEmail: string | null,
  ): Promise<BuilderSession | null> {
    const sessions = await this.readBuilderSessions();
    return sessions.find(s =>
      s.projectRoot === projectRoot &&
      s.memberEmail === memberEmail &&
      s.state !== 'ended',
    ) ?? null;
  }

  async listBuilderSessions(projectRoot?: string): Promise<BuilderSession[]> {
    const sessions = await this.readBuilderSessions();
    return projectRoot ? sessions.filter(s => s.projectRoot === projectRoot) : sessions;
  }

  async updateBuilderSession(
    id: string,
    patch: BuilderSessionUpdate,
    expectedState?: BuilderSession['state'],
    expectedBuilderId?: string,
  ): Promise<BuilderSession> {
    return this.lock.withLock(async () => {
      const sessions = await this.readBuilderSessions();
      const idx = sessions.findIndex(s => s.id === id);
      if (idx === -1) throw new Error(`Builder session not found: ${id}`);
      // The expected-state (CAS) guard decides HERE — inside the same locked
      // critical section as the write — so the refusal is the serialization
      // point, not an advisory check the patch can outrun (§5.7: the member's
      // explicit end outranks a launch already in flight).
      const row = sessions[idx]!;
      if (
        (expectedState !== undefined && row.state !== expectedState) ||
        (expectedBuilderId !== undefined && row.builderId !== expectedBuilderId)
      ) {
        throw new BuilderSessionStateConflictError(
          id, expectedState ?? row.state, row.state, expectedBuilderId, row.builderId,
        );
      }
      const updated: BuilderSession = {
        ...sessions[idx]!,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const next = [...sessions];
      next[idx] = updated;
      await this.writeJson(this.builderSessionsPath, { sessions: next });
      return updated;
    });
  }

  // --- Builder scratch sandbox ---

  private get scratchPath(): string {
    return join(this.basePath, 'scratch.json');
  }

  private async readScratchFiles(): Promise<ScratchFile[]> {
    const file = await this.readJson<ScratchFilesFile>(this.scratchPath);
    return file?.scratch_files ?? [];
  }

  async saveScratchFile(input: ScratchFileInput, actor: Actor): Promise<ScratchFile> {
    assertScratchFileWithinCap(input);
    // Locked: read-modify-write of scratch.json. Two builders of the same
    // project capture concurrently, and an unlocked write loses one of them.
    return this.lock.withLock(async () => {
      const files = await this.readScratchFiles();
      const now = Date.now();
      const existing = files.find(f => f.path === input.path);

      const record: ScratchFile = {
        path: input.path,
        content: input.content,
        size: input.size,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        updated_by: actor,
        ...(input.skipped ? { skipped: input.skipped } : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
      };

      const next = existing
        ? files.map(f => (f.path === input.path ? record : f))
        : [...files, record];
      await this.writeJson(this.scratchPath, { scratch_files: next } satisfies ScratchFilesFile);
      return record;
    });
  }

  async getScratchFile(path: string): Promise<ScratchFile | null> {
    const files = await this.readScratchFiles();
    return files.find(f => f.path === path) ?? null;
  }

  async listScratchFiles(): Promise<ScratchFile[]> {
    const files = await this.readScratchFiles();
    return files.sort((a, b) => b.updated_at - a.updated_at);
  }

  async deleteScratchFile(path: string): Promise<boolean> {
    return this.lock.withLock(async () => {
      const files = await this.readScratchFiles();
      const remaining = files.filter(f => f.path !== path);
      if (remaining.length === files.length) return false; // idempotent
      await this.writeJson(
        this.scratchPath,
        { scratch_files: remaining } satisfies ScratchFilesFile,
      );
      return true;
    });
  }

  // --- Memory (lazy-owned shared knowledge) ---

  private get memoriesPath(): string {
    return join(this.basePath, 'memories.json');
  }

  private get memoryHistoryPath(): string {
    return join(this.basePath, 'memory-history.json');
  }

  private async readMemories(): Promise<MemoryRecord[]> {
    const file = await this.readJson<MemoriesFile>(this.memoriesPath);
    return file?.memories ?? [];
  }

  private async readMemoryEvents(): Promise<MemoryEvent[]> {
    const file = await this.readJson<MemoryHistoryFile>(this.memoryHistoryPath);
    return file?.events ?? [];
  }

  async saveMemory(input: MemoryWriteInput, actorInput: ActorInput): Promise<MemoryRecord> {
    // Role in the role column, person (when the write named one) beside it —
    // an absent key, never present-and-undefined (storage-contract row shape).
    const actor = actorRole(actorInput) ?? 'human';
    const email = actorEmail(actorInput);
    const name = actorName(actorInput);
    // Locked: the read-modify-write of memories.json plus the history append
    // must not interleave with a concurrent save/delete, or one write is lost
    // and the history stops matching the records.
    return this.lock.withLock(async () => {
      const memories = await this.readMemories();
      const now = Date.now();
      const existing = memories.find(m => m.name === input.name);

      const record: MemoryRecord = existing
        ? {
            ...existing,
            description: input.description,
            type: input.type,
            body: input.body,
            updated_at: now,
            updated_by: actor,
            // The previous writer's person must not survive a write that
            // names nobody — cleared, then set from THIS write when it has one.
            updated_by_email: undefined,
            updated_by_name: undefined,
            ...personFieldsAs('updated_by', email, name),
            revision: existing.revision + 1,
            // Saving a tombstoned name revives it; history keeps the delete.
            deleted_at: undefined,
            deleted_by: undefined,
            deleted_by_email: undefined,
            deleted_by_name: undefined,
          }
        : {
            name: input.name,
            description: input.description,
            type: input.type,
            body: input.body,
            created_at: now,
            updated_at: now,
            created_by: actor,
            ...personFieldsAs('created_by', email, name),
            updated_by: actor,
            ...personFieldsAs('updated_by', email, name),
            revision: 1,
          };

      const next = existing
        ? memories.map(m => (m.name === record.name ? record : m))
        : [...memories, record];
      await this.writeJson(this.memoriesPath, { memories: next } satisfies MemoriesFile);

      // INVARIANT: append-only. Never rewrite or prune prior events.
      const events = await this.readMemoryEvents();
      events.push({
        id: randomUUID(),
        name: record.name,
        action: existing ? 'update' : 'create',
        actor,
        ...personFieldsAs('actor', email, name),
        timestamp: now,
        revision: record.revision,
        description: record.description,
        type: record.type,
        body: record.body,
      });
      await this.writeJson(this.memoryHistoryPath, { events } satisfies MemoryHistoryFile);

      return record;
    });
  }

  async getMemory(name: string): Promise<MemoryRecord | null> {
    const memories = await this.readMemories();
    const match = memories.find(m => m.name === name);
    if (!match || match.deleted_at) return null;
    return match;
  }

  async listMemories(options?: { includeDeleted?: boolean }): Promise<MemoryRecord[]> {
    const memories = await this.readMemories();
    const filtered = options?.includeDeleted ? memories : memories.filter(m => !m.deleted_at);
    return filtered.sort((a, b) => b.updated_at - a.updated_at);
  }

  async deleteMemory(name: string, actorInput: ActorInput): Promise<MemoryRecord | null> {
    const actor = actorRole(actorInput) ?? 'human';
    const email = actorEmail(actorInput);
    const personName = actorName(actorInput);
    return this.lock.withLock(async () => {
      const memories = await this.readMemories();
      const existing = memories.find(m => m.name === name);
      if (!existing || existing.deleted_at) return null; // idempotent

      const now = Date.now();
      const tombstoned: MemoryRecord = {
        ...existing,
        deleted_at: now,
        deleted_by: actor,
        ...personFieldsAs('deleted_by', email, personName),
      };
      await this.writeJson(
        this.memoriesPath,
        { memories: memories.map(m => (m.name === name ? tombstoned : m)) } satisfies MemoriesFile,
      );

      const events = await this.readMemoryEvents();
      events.push({
        id: randomUUID(),
        name,
        action: 'delete',
        actor,
        ...personFieldsAs('actor', email, personName),
        timestamp: now,
        revision: existing.revision,
      });
      await this.writeJson(this.memoryHistoryPath, { events } satisfies MemoryHistoryFile);

      return tombstoned;
    });
  }

  async getMemoryHistory(name?: string): Promise<MemoryEvent[]> {
    const events = await this.readMemoryEvents();
    const filtered = name ? events.filter(e => e.name === name) : events;
    return filtered.sort((a, b) => a.timestamp - b.timestamp);
  }

  // --- Memory compact (derived; single overwritable slot, no history) ---

  private get memoryCompactPath(): string {
    return join(this.basePath, 'memory-compact.json');
  }

  async saveMemoryCompact(input: MemoryCompactInput, actorInput: ActorInput): Promise<MemoryCompact> {
    const compact: MemoryCompact = {
      content: input.content,
      generated_at: Date.now(),
      generated_by: actorRole(actorInput) ?? 'human',
      ...personFieldsAs('generated_by', actorEmail(actorInput), actorName(actorInput)),
      method: input.method,
      ...(input.model ? { model: input.model } : {}),
      covered: input.covered,
    };
    // No lock and no read-modify-write: the compact is a whole-value overwrite
    // of derived state. Two concurrent compactions both regenerate from the same
    // records, so last-writer-wins loses nothing.
    await this.writeJson(this.memoryCompactPath, { compact } satisfies MemoryCompactFile);
    return compact;
  }

  async getMemoryCompact(): Promise<MemoryCompact | null> {
    const file = await this.readJson<MemoryCompactFile>(this.memoryCompactPath);
    return file?.compact ?? null;
  }

  async clearMemoryCompact(): Promise<boolean> {
    const existing = await this.readJson<MemoryCompactFile>(this.memoryCompactPath);
    if (!existing) return false;
    await rm(this.memoryCompactPath, { force: true });
    return true;
  }

  // --- System messages (proactive system-to-human reports) ---

  private get systemMessagesPath(): string {
    return join(this.basePath, 'system-messages.json');
  }

  private async readSystemMessages(): Promise<SystemMessage[]> {
    const file = await this.readJson<SystemMessagesFile>(this.systemMessagesPath);
    return file?.system_messages ?? [];
  }

  /**
   * Resolve an id or unique id prefix against the given messages. Returns null
   * when nothing matches; throws on an ambiguous prefix — silently picking one
   * would mark/dismiss a message the caller never named.
   */
  private resolveSystemMessageId(messages: SystemMessage[], id: string): SystemMessage | null {
    const exact = messages.find(m => m.id === id);
    if (exact) return exact;
    const matches = messages.filter(m => m.id.startsWith(id));
    if (matches.length > 1) {
      throw new Error(`Ambiguous system message id prefix: ${id} (${matches.length} matches)`);
    }
    return matches[0] ?? null;
  }

  async createSystemMessage(input: SystemMessageInput): Promise<SystemMessage> {
    return this.lock.withLock(async () => {
      const messages = await this.readSystemMessages();
      const message: SystemMessage = {
        id: randomUUID(),
        created_at: Date.now(),
        source: input.source,
        title: input.title,
        body: input.body,
        kind: input.kind,
      };
      // INVARIANT: append-only. Never rewrite or prune prior messages.
      messages.push(message);
      await this.writeJson(
        this.systemMessagesPath,
        { system_messages: messages } satisfies SystemMessagesFile,
      );
      return message;
    });
  }

  async listSystemMessages(options?: { includeDismissed?: boolean }): Promise<SystemMessage[]> {
    const messages = await this.readSystemMessages();
    const filtered = options?.includeDismissed
      ? messages
      : messages.filter(m => !m.dismissed_at);
    return filtered.sort((a, b) => b.created_at - a.created_at);
  }

  async getSystemMessage(id: string): Promise<SystemMessage | null> {
    return this.resolveSystemMessageId(await this.readSystemMessages(), id);
  }

  async markSystemMessageRead(id: string): Promise<SystemMessage> {
    return this.lock.withLock(async () => {
      const messages = await this.readSystemMessages();
      const existing = this.resolveSystemMessageId(messages, id);
      if (!existing) throw new Error(`System message not found: ${id}`);
      if (existing.read_at) return existing; // idempotent: first read wins
      const updated: SystemMessage = { ...existing, read_at: Date.now() };
      await this.writeJson(
        this.systemMessagesPath,
        {
          system_messages: messages.map(m => (m.id === updated.id ? updated : m)),
        } satisfies SystemMessagesFile,
      );
      return updated;
    });
  }

  async dismissSystemMessage(id: string, actor: Actor): Promise<SystemMessage> {
    return this.lock.withLock(async () => {
      const messages = await this.readSystemMessages();
      const existing = this.resolveSystemMessageId(messages, id);
      if (!existing) throw new Error(`System message not found: ${id}`);
      if (existing.dismissed_at) return existing; // idempotent
      const updated: SystemMessage = {
        ...existing,
        dismissed_at: Date.now(),
        dismissed_by: actor,
      };
      await this.writeJson(
        this.systemMessagesPath,
        {
          system_messages: messages.map(m => (m.id === updated.id ? updated : m)),
        } satisfies SystemMessagesFile,
      );
      return updated;
    });
  }

  // --- Tags ---

  /**
   * Append a tag-history event to a task's tag-history.json.
   * Returns the updated file object for inclusion in an atomic multi-file write
   * (mirrors readAndAppendStatusChange).
   */
  private async readAndAppendTagEvent(
    taskId: string,
    event: TagEvent,
  ): Promise<TagHistoryFile> {
    const historyPath = join(this.taskDir(taskId), 'tag-history.json');
    const file = await this.readJson<TagHistoryFile>(historyPath);
    const events = file?.events ?? [];
    events.push(event);
    return { events };
  }

  async addTaskTag(taskId: string, tag: string, actor?: ActorInput): Promise<Task> {
    const normalized = normalizeTagOrThrow(tag);
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) throw new Error(`Task not found: ${taskId}`);

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Idempotent: already tagged → no state change, no history event.
      if (task.tags.includes(normalized)) {
        return task;
      }

      task.tags = [...task.tags, normalized];
      const now = Date.now();
      const history = await this.readAndAppendTagEvent(fullId, {
        tag: normalized,
        action: 'tag',
        timestamp: now,
        ...actorFields(actor),
      });
      await this.atomicWriteTask(fullId, { 'task.json': task, 'tag-history.json': history });
      return task;
    });
  }

  async removeTaskTag(taskId: string, tag: string, actor?: ActorInput): Promise<Task> {
    const normalized = normalizeTagOrThrow(tag);
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) throw new Error(`Task not found: ${taskId}`);

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Idempotent: not tagged → no state change, no history event.
      if (!task.tags.includes(normalized)) {
        return task;
      }

      task.tags = task.tags.filter(t => t !== normalized);
      const now = Date.now();
      // History is append-only: untagging appends an 'untag' event — it never
      // erases the earlier 'tag' event.
      const history = await this.readAndAppendTagEvent(fullId, {
        tag: normalized,
        action: 'untag',
        timestamp: now,
        ...actorFields(actor),
      });
      await this.atomicWriteTask(fullId, { 'task.json': task, 'tag-history.json': history });
      return task;
    });
  }

  async getTagHistory(taskId: string): Promise<TagEvent[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const historyPath = join(this.taskDir(fullId), 'tag-history.json');
    const file = await this.readJson<TagHistoryFile>(historyPath);
    return file?.events ?? [];
  }

  // --- Status History ---

  async getStatusHistory(taskId: string): Promise<StatusChange[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const changelogPath = join(this.taskDir(fullId), 'status-changelog.json');
    const file = await this.readJson<StatusChangelogFile>(changelogPath);

    if (file?.changes && file.changes.length > 0) {
      return file.changes;
    }

    // Lazy migration: reconstruct from task + session data
    const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
    if (!task) return [];

    const changes: StatusChange[] = [];

    // Initial creation -> backlog
    changes.push({ status: 'backlog', timestamp: task.created_at });

    // If there's a session, the task transitioned to working when it started
    const session = await this.readSession(join(this.taskDir(fullId), 'session.json'));
    if (session) {
      changes.push({ status: 'working', timestamp: session.started_at });
    }

    // If the task is in a terminal state, record the completion
    if (task.completed_at && isTerminalStatus(task.status)) {
      changes.push({ status: task.status, timestamp: task.completed_at });
    } else if (task.status !== 'backlog' && task.status !== 'working') {
      // Task is in some non-terminal state that isn't the default progression.
      // Use last_interaction_at or a best-guess timestamp.
      const ts = session?.last_interaction_at ?? task.created_at;
      changes.push({ status: task.status, timestamp: ts });
    }

    // Persist the reconstructed changelog so future reads are fast (best-effort)
    try {
      await this.writeJson(changelogPath, { changes });
    } catch {
      // Best-effort: in-memory result still works
    }

    return changes;
  }

  // --- Per-task tool stats ---

  async getToolStats(taskId: string): Promise<TaskToolStatsRecord | null> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return null;
    return this.readJson<TaskToolStatsRecord>(join(this.taskDir(fullId), TOOL_STATS_FILENAME));
  }

  async saveToolStats(record: TaskToolStatsRecord): Promise<void> {
    // The id on the record comes from a proxy credential grant, which carries
    // whatever id the launch had — possibly a prefix. Resolve it, and store the
    // FULL id: a record filed under a prefix would be a second task directory,
    // not a second file in the right one.
    const fullId = await this.findTaskIdByPrefix(record.task_id);
    if (!fullId) {
      throw new Error(`Cannot save tool stats: no task matches id "${record.task_id}"`);
    }
    // Through atomicWriteTask like every other per-task file: it takes the same
    // per-task mutex, so a fold landing while the task itself is being written
    // cannot interleave two stage→rename sequences in one directory.
    await this.atomicWriteTask(fullId, { [TOOL_STATS_FILENAME]: { ...record, task_id: fullId } });
  }

  // --- Usage-limit readings ([usage_pause]) ---

  private get usageLimitReadingsPath(): string {
    return join(this.basePath, 'usage-limit-readings.json');
  }

  /**
   * The raw entries of the readings file. `[]` only when the file does not
   * exist; a file that exists but does not parse, or is not `{ readings: [] }`,
   * THROWS with its path.
   *
   * INVARIANT: a corrupt readings file is never read as "no readings". That
   * answer let turns start on a paused credential, and the next save then
   * overwrote the file with one record, destroying whatever the rest held.
   */
  private async readUsageLimitReadingsFile(): Promise<unknown[]> {
    const path = this.usageLimitReadingsPath;
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new UsageLimitReadingsUnreadableError(path, `Could not read the usage-limit readings at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new UsageLimitReadingsUnreadableError(
        path,
        `The usage-limit readings at ${path} are not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
          `Fix or remove the file; lazy will not overwrite it.`,
      );
    }
    const readings = (parsed as { readings?: unknown } | null)?.readings;
    if (!Array.isArray(readings)) {
      throw new UsageLimitReadingsUnreadableError(
        path,
        `The usage-limit readings at ${path} are not in the expected { "readings": [...] } shape. ` +
          `Fix or remove the file; lazy will not overwrite it.`,
      );
    }
    return readings;
  }

  /** Future-dated records already warned about, this process (see readUsageLimitRecords). */
  private readonly clampedUsageReadingsLogged = new Set<string>();

  /**
   * Every stored record, read back (src/storage/usage-limit-readings.ts,
   * `readStoredUsageLimitReading`), beside the raw entries they came from.
   * A record dated in the future is CLAMPED to now and warned about once; a
   * record that fails validation for any other reason makes the whole file
   * unreadable — never skipped, since a skipped reading is a pause that
   * silently stops (the gate fails closed on this error instead).
   */
  private async readUsageLimitRecords(): Promise<{
    raw: unknown[];
    records: Array<{ record: StoredUsageLimitReading; clamped: boolean }>;
  }> {
    const path = this.usageLimitReadingsPath;
    const raw = await this.readUsageLimitReadingsFile();
    const now = Date.now();
    const records = raw.map((entry, i) => {
      let read: { record: StoredUsageLimitReading; clamped: boolean };
      try {
        read = readStoredUsageLimitReading(entry, now);
      } catch (err) {
        throw new UsageLimitReadingsUnreadableError(
          path,
          `The usage-limit readings at ${path} hold a record lazy cannot use (entry ${i + 1}: ` +
            `${err instanceof Error ? err.message : String(err)}). Fix or remove the file; lazy will not overwrite it.`,
        );
      }
      const key = `${read.record.credential}|${JSON.stringify(entry)}`;
      if (read.clamped && !this.clampedUsageReadingsLogged.has(key)) {
        this.clampedUsageReadingsLogged.add(key);
        logger.warn(
          `The saved usage reading for ${read.record.credential} in ${path} is dated in the future ` +
            `(the clock moved?); it is read as taken now, and the next reading for it replaces it.`,
        );
      }
      return read;
    });
    return { raw, records };
  }

  async getUsageLimitReadings(): Promise<StoredUsageLimitReading[]> {
    return (await this.readUsageLimitRecords()).records.map((r) => r.record);
  }

  async saveUsageLimitReading(reading: StoredUsageLimitReading): Promise<void> {
    // Under the storage lock: a read-modify-write of one small file holding a
    // record per credential, so two credentials' writes cannot drop each other.
    await this.lock.withLock(async () => {
      const valid = validateStoredUsageLimitReading(reading);
      // Throws on a file it cannot read, or one holding a record it cannot
      // use — either way it is never overwritten blind.
      const { raw, records } = await this.readUsageLimitRecords();
      const index = records.findIndex((r) => r.record.credential === valid.credential);
      const stored = index >= 0 ? records[index] : undefined;
      // A record read back from the future (clamped to now) is dated no later
      // than the incoming one for the merge: clamped to "now" it would beat
      // every real reading taken a moment earlier, and pin the credential to
      // the stale record — the very thing the future check exists to stop.
      const existing = stored?.clamped
        ? {
          ...stored.record,
          ts: Math.min(stored.record.ts, valid.ts),
          ...(stored.record.spentAt !== undefined ? { spentAt: Math.min(stored.record.spentAt, valid.ts) } : {}),
        }
        : stored?.record;
      // A spend mark never replaces a reading; a late write never rolls a
      // credential back (src/storage/usage-limit-readings.ts). Every OTHER
      // entry is kept exactly as it was.
      const merged = mergeUsageLimitReading(existing, valid);
      if (!merged) return;
      const next = [...raw];
      if (index >= 0) next[index] = merged;
      else next.push(merged);
      await this.writeJson(this.usageLimitReadingsPath, { readings: next });
    });
  }

  // --- Search ---

  /**
   * Plain-text (regex) search across the whole store.
   *
   * The query is a user-supplied case-insensitive regex, so matching never runs
   * on this thread: every candidate haystack goes through {@link BoundedTextMatcher},
   * which evaluates it in a Worker under a deadline. A catastrophically
   * backtracking pattern is refused (`Invalid search pattern … took too long`)
   * instead of wedging the daemon's event loop for every other caller.
   */
  async search(query: string): Promise<SearchResult[]> {
    const matcher = new BoundedTextMatcher<SearchResult>(query);

    // Only the directory listing is optional (a store with no tasks yet). The
    // per-entity reads below are already null-tolerant, and a refused pattern
    // must reach the caller rather than be mistaken for a missing store.
    let dirs: string[] = [];
    try {
      dirs = await readdir(this.tasksPath);
    } catch {
      // Tasks dir doesn't exist — nothing to search here.
    }

    for (const dir of dirs) {
      if (dir.includes('.tmp') || dir.includes('.backup')) continue;

      const taskDir = join(this.tasksPath, dir);

      const task = await this.readTask(join(taskDir, 'task.json'));
      if (!task) continue;

      const taskGoal = task.goal;
      const taskCode = task.code ?? null;
      // The task's own "last change", the way the `updated:` filter reads it
      // (evaluator.ts) — completed_at when there is one, created_at otherwise.
      // Carried on every task-level row as the recency signal ranking sorts by.
      const taskTime = task.completed_at ?? task.created_at;

      // Search task code
      if (taskCode) {
        await matcher.add(taskCode, () => ({
          entity_type: 'task',
          entity_id: task.id,
          task_id: task.id,
          task_code: taskCode,
          task_goal: taskGoal,
          content: `code: ${taskCode}`,
          match_context: taskCode,
          entity_time: taskTime,
        }));
      }

      // Search task goal
      await matcher.add(task.goal, () => ({
        entity_type: 'task',
        entity_id: task.id,
        task_id: task.id,
        task_code: taskCode,
        task_goal: taskGoal,
        content: task.goal,
        match_context: task.goal,
        entity_time: taskTime,
      }));

      // Search prompt separately
      if (task.prompt) {
        const prompt = task.prompt;
        await matcher.add(prompt, context => ({
          entity_type: 'prompt',
          entity_id: task.id,
          task_id: task.id,
          task_code: taskCode,
          task_goal: taskGoal,
          content: prompt,
          match_context: context,
          entity_time: taskTime,
        }));
      }

      // Search turns
      const turnsFile = await this.readJson<TurnsFile>(join(taskDir, 'turns.json'));
      if (turnsFile) {
        // The array index is the locator: turns.json is the same list, in the
        // same order, that getSessionTurns() returns and `show` pages over,
        // so the index doubles as a ready-made `offset`.
        for (const [index, turn] of turnsFile.turns.entries()) {
          await matcher.add(turn.content, context => ({
            entity_type: 'turn',
            entity_id: turn.id,
            task_id: dir,
            task_code: taskCode,
            task_goal: taskGoal,
            content: turn.content,
            match_context: context,
            entity_index: index,
            turn_sequence: turn.sequence,
            entity_time: turn.timestamp,
          }));
        }
      }

      // Search commits
      const commitsFile = await this.readJson<CommitsFile>(join(taskDir, 'commits.json'));
      if (commitsFile) {
        for (const [index, commit] of commitsFile.commits.entries()) {
          await matcher.add(commit.message, () => ({
            entity_type: 'commit',
            entity_id: commit.id,
            task_id: dir,
            task_code: taskCode,
            task_goal: taskGoal,
            content: commit.message,
            match_context: commit.message,
            entity_index: index,
            entity_time: commit.timestamp,
          }));
        }
      }

      // Search comments
      const comments = await this.readComments(taskDir);
      for (const [index, comment] of comments.entries()) {
        await matcher.add(comment.content, context => ({
          entity_type: 'comment',
          entity_id: comment.id,
          task_id: dir,
          task_code: taskCode,
          task_goal: taskGoal,
          content: comment.content,
          match_context: context,
          entity_index: index,
          entity_time: comment.created_at,
        }));
      }

      // Search raised items — blocking and non-blocking alike, one entity.
      const raisedItems = await this.readRaisedItems(taskDir);
      for (const [index, item] of raisedItems.entries()) {
        // Context comes from the same haystack that matched. The haystack
        // starts with `content`, so a match there snippets exactly as before;
        // a match in the title or explanation shows that text instead of an
        // unrelated head of `content`.
        await matcher.add(raisedSearchText(item), context => ({
          entity_type: 'raised',
          entity_id: item.id,
          task_id: dir,
          task_code: taskCode,
          task_goal: taskGoal,
          content: item.content,
          match_context: context,
          entity_index: index,
          entity_time: item.created_at,
        }));
      }

    }

    // Search conversations
    let convFiles: string[] = [];
    const convDir = join(this.basePath, 'conversations');
    try {
      convFiles = await readdir(convDir);
    } catch {
      // Conversations directory doesn't exist — nothing to search here.
    }

    for (const file of convFiles) {
      if (!file.endsWith('.json')) continue;

      // Read and parse under the tolerant catch; matching stays outside it so
      // a refused pattern is never mistaken for a malformed file.
      let parsed: SearchableConversationFile | null = null;
      try {
        const content = await readFile(join(convDir, file), 'utf-8');
        parsed = JSON.parse(content) as SearchableConversationFile;
      } catch {
        // Skip malformed conversation files
      }
      if (!parsed) continue;
      const conversation = parsed;

      // Search conversation summary
      if (conversation.summary) {
        // A summary row speaks for the whole conversation; its recency is the
        // conversation's end, falling back to import time when the transcript
        // never recorded one. Message rows use their own timestamps below.
        const summaryTime = entityTimeFromIso(conversation.endedAt) ?? conversation.importedAt;
        await matcher.add(conversation.summary, () => ({
          entity_type: 'conversation',
          entity_id: conversation.sessionId,
          task_id: conversation.sessionId,
          task_code: null,
          task_goal: conversation.summary,
          content: conversation.summary,
          match_context: conversation.summary,
          ...(summaryTime !== undefined ? { entity_time: summaryTime } : {}),
        }));
      }

      // Search conversation messages
      if (conversation.messages) {
        for (const msg of conversation.messages) {
          if (!msg.text) continue;
          const messageTime = entityTimeFromIso(msg.timestamp);
          await matcher.add(msg.text, context => ({
            entity_type: 'conversation',
            entity_id: conversation.sessionId,
            task_id: conversation.sessionId,
            task_code: null,
            task_goal: conversation.summary || '(conversation)',
            content: msg.text,
            match_context: context,
            ...(messageTime !== undefined ? { entity_time: messageTime } : {}),
          }));
        }
      }
    }

    // Search live memory records (name, description, body). Tombstoned records
    // are excluded: they are no longer part of the project's knowledge.
    for (const memory of await this.listMemories()) {
      const haystack = `${memory.name}\n${memory.description}\n${memory.body}`;
      await matcher.add(haystack, context => ({
        entity_type: 'memory',
        entity_id: memory.name,
        task_id: memory.name,
        task_code: null,
        task_goal: `memory: ${memory.name}`,
        content: memory.body,
        match_context: context,
        entity_time: memory.updated_at,
      }));
    }

    // Search captured builder scratch files (path + content). Skipped files
    // still match on their path, so `lazy search` can find a dump the engineer
    // knows by name even when only its metadata was persisted.
    for (const file of await this.listScratchFiles()) {
      const haystack = `${file.path}\n${file.content}`;
      await matcher.add(haystack, context => ({
        entity_type: 'scratch',
        entity_id: file.path,
        task_id: file.path,
        task_code: null,
        task_goal: `scratch: ${file.path}`,
        content: file.content,
        match_context: context,
        entity_time: file.updated_at,
      }));
    }

    return await matcher.finish();
  }

  // --- Tracing ---

  async appendTraceSpans(spans: SpanRecord[]): Promise<void> {
    await appendSpansJsonl(this.basePath, spans);
  }

  async readTraceSpans(sinceMs?: number): Promise<SpanRecord[]> {
    return readSpansJsonl(this.basePath, sinceMs);
  }

  // --- Wait intervals ---

  async recordWaitStart(start: WaitIntervalStart): Promise<void> {
    await appendWaitStartJsonl(this.basePath, start);
  }

  async recordWaitEnd(id: string, endedAt: string, outcome: WaitOutcome): Promise<void> {
    await appendWaitEndJsonl(this.basePath, id, endedAt, outcome);
  }

  async readWaitIntervals(filter?: WaitIntervalFilter): Promise<WaitInterval[]> {
    return readWaitIntervalsJsonl(this.basePath, filter);
  }
}
