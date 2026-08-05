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
 */

import { randomUUID } from 'crypto';
import { cp, mkdir, readdir, readFile, writeFile, rename, rm, stat, unlink } from 'fs/promises';
import { join } from 'path';
import type { Storage, CreateTurnOptions } from './interface';
import { normalizeTurnContent } from '../utils/turn-content';
import type { SpanRecord } from '../tracing/types';
import { appendSpansJsonl, readSpansJsonl } from './trace-spans';
import { getDataDir } from '../cli/init';
import type {
  Task,
  Session,
  Turn,
  MergeConflict,
  FileViolation,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  FollowUp,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnRole,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  StorageVersion,
  SearchResult,
  StoredConversation,
  AgentSessionLog,
  BuilderResumeIntent,
  TurnsFile,
  CommitsFile,
  PromptHistoryFile,
  SnapshotsFile,
  ReviewsFile,
  CommentsFile,
  JournalEntry,
  JournalFile,
  FollowUpsFile,
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
  MemoryCompact,
  MemoryCompactInput,
  MemoryCompactFile,
  CommentSource,
  HunkApproval,
  HunkApprovalLineage,
} from './types';
import { isTerminalStatus, isBlockedStatus } from '../types';
import { normalizeTagOrThrow } from '../utils/tags';
import { targetFromLegacy, parentTaskIdOf } from '../task-target';
import type { TaskTarget } from '../types';
import type { RunnerType } from '../config/types';
import { assertValidTransition } from '../task-state-machine';
import { StorageLock } from '../utils/storage-lock';
import { TaskMutex } from '../utils/task-mutex';

const STORAGE_VERSION = 1;

/** Legacy model aliases → current names (removed in remove-model-aliases) */
const LEGACY_MODEL_MAP: Record<string, string> = {
  apprentice: 'haiku',
  journeyman: 'sonnet',
  master: 'opus',
};

export interface FileStorageOptions {
  /** Override the base path instead of computing from lazyRoot + dataDir */
  basePath?: string;
}

export class FileStorage implements Storage {
  private readonly basePath: string;
  private readonly tasksPath: string;
  private readonly lock: StorageLock;
  private readonly taskMutex = new TaskMutex();

  constructor(lazyRoot: string, options?: FileStorageOptions) {
    this.basePath = options?.basePath ?? join(lazyRoot, getDataDir(lazyRoot));
    this.tasksPath = join(this.basePath, 'tasks');
    this.lock = new StorageLock(lazyRoot, options?.basePath);
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

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
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

    // Ensure priority field exists (defaults to 'normal' for tasks predating it)
    if (raw.priority === undefined) {
      raw.priority = 'normal';
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

    // Migrate pending_sync: boolean→number (false→0, true→1, undefined→0)
    if (raw.pending_sync === undefined || raw.pending_sync === false) {
      raw.pending_sync = 0;
      needsWrite = true;
    } else if (raw.pending_sync === true) {
      raw.pending_sync = 1;
      needsWrite = true;
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
   * Atomic write for a task directory
   *
   * Creates a temp directory, writes all files, then atomically renames.
   */
  private async atomicWriteTask(taskId: string, files: Record<string, unknown>): Promise<void> {
    // Serialize concurrent async operations on the same task directory.
    // The StorageLock (file-based) handles inter-process exclusion but is
    // re-entrant within the same process, so two concurrent async operations
    // (e.g. RPC handler + reconcile loop) can interleave at await points and
    // corrupt each other's temp→real rename sequence.
    return this.taskMutex.withLock(taskId, async () => {
      const taskDir = this.taskDir(taskId);
      const tmpDir = `${taskDir}.tmp.${Date.now()}`;

      try {
        // Create temp directory
        await mkdir(tmpDir, { recursive: true });

        // If updating, copy existing files first
        if (await this.exists(taskDir)) {
          const entries = await readdir(taskDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.includes('.tmp') || entry.name.includes('.backup')) continue;
            if (entry.isFile()) {
              const content = await readFile(join(taskDir, entry.name), 'utf-8');
              await writeFile(join(tmpDir, entry.name), content, 'utf-8');
            } else if (entry.isDirectory()) {
              await cp(join(taskDir, entry.name), join(tmpDir, entry.name), { recursive: true });
            }
          }
        }

        // Write new/updated files
        for (const [filename, data] of Object.entries(files)) {
          await this.writeJson(join(tmpDir, filename), data);
        }

        // Atomic swap
        if (await this.exists(taskDir)) {
          const backupDir = `${taskDir}.backup.${Date.now()}`;
          await rename(taskDir, backupDir);
          await rename(tmpDir, taskDir);
          await rm(backupDir, { recursive: true, force: true });
        } else {
          await rename(tmpDir, taskDir);
        }
      } catch (err) {
        // Cleanup temp on failure
        await rm(tmpDir, { recursive: true, force: true });
        throw err;
      }
    });
  }

  /**
   * Find task ID by prefix match or code lookup.
   *
   * Resolution order:
   * 1. Full UUID (36 chars) -> exact match
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
    if (input.length === 36) {
      return { id: input }; // Full UUID
    }

    try {
      const dirs = await readdir(this.tasksPath);
      const cleanDirs = dirs.filter(d => !d.includes('.tmp') && !d.includes('.backup'));

      // Try hex prefix match first
      const prefixMatches = cleanDirs.filter(d => d.startsWith(input));
      if (prefixMatches.length === 1) {
        return { id: prefixMatches[0] };
      }

      // If input looks like a hex prefix (even if ambiguous), don't fall through to code
      if (/^[a-f0-9]+$/.test(input) && prefixMatches.length > 0) {
        return { id: null }; // Ambiguous hex prefix
      }

      // Try code lookup: scan all tasks for matching code
      const codeTasks: Task[] = [];
      for (const dir of cleanDirs) {
        const task = await this.readTask(join(this.tasksPath, dir, 'task.json'));
        if (task && task.code === input) {
          codeTasks.push(task);
        }
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

  /**
   * Get task ID from a session by reading its session.json
   */
  private async findTaskIdBySessionPrefix(sessionPrefix: string): Promise<string | null> {
    try {
      const dirs = await readdir(this.tasksPath);
      for (const dir of dirs) {
        if (dir.includes('.tmp') || dir.includes('.backup')) continue;

        const sessionPath = join(this.tasksPath, dir, 'session.json');
        const session = await this.readSession(sessionPath);
        if (session && session.id.startsWith(sessionPrefix)) {
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
    actor?: Actor,
  ): Promise<StatusChangelogFile> {
    const changelogPath = join(this.taskDir(taskId), 'status-changelog.json');
    const file = await this.readJson<StatusChangelogFile>(changelogPath);
    const changes = file?.changes ?? [];
    changes.push({ status, timestamp, ...(actor ? { actor } : {}) });
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

  async createTask(goal: string, parentTaskId?: string, branchedFromSha?: string, code?: string, type?: string, agentId?: string): Promise<Task> {
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
        priority: 'normal',
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
      };

      await this.atomicWriteTask(id, {
        'task.json': task,
        'turns.json': { turns: [] },
        'commits.json': { commits: [] },
        'prompt-history.json': { versions: [] },
        'snapshots.json': { snapshots: [] },
        'reviews.json': { reviews: [] },
        'comments.json': { comments: [] },
        'follow-ups.json': { follow_ups: [] },
        'status-changelog.json': { changes: [{ status: 'backlog', timestamp: now }] },
        'tag-history.json': { events: [] },
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
          // Persist the fix (best-effort, self-healing) — lock only for the write
          try {
            await this.lock.withLock(async () => {
              const changelog = await this.readAndAppendStatusChange(task.id, newStatus, now);
              await this.atomicWriteTask(task.id, { 'task.json': task, 'status-changelog.json': changelog });
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
      if (options.queuedOnly && task.status !== 'queued') {
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
      if (options.nonTerminalOnly && isTerminalStatus(task.status)) {
        return false;
      }
      return true;
    });
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, actor?: Actor): Promise<void> {
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
      assertValidTransition(task.status, status, actor);

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

  async updateTaskPriority(taskId: string, priority: string): Promise<void> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) return;

      const task = await this.readTask(join(this.taskDir(fullId), 'task.json'));
      if (!task) return;

      this.assertNotTerminal(task, 'update priority');

      task.priority = priority as Task['priority'];

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

  async abandonTask(taskId: string, reason: string, actor?: Actor): Promise<void> {
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

  async reopenTask(taskId: string, actor?: Actor): Promise<void> {
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
        interrupt_reason: null,
        interrupt_exit_code: null,
        interrupt_at: null,
        interrupt_logs: null,
        consecutive_interruptions: 0,
        auto_resumed: false,
        user_stopped: false,
        upstream_merge_sha: null,
        runner_type: null,
      };

      await this.atomicWriteTask(fullId, { 'session.json': session });

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

  async updateSessionContainerName(sessionId: string, containerName: string | null): Promise<void> {
    return this.lock.withLock(async () => {
      const taskId = await this.findTaskIdBySessionPrefix(sessionId);
      if (!taskId) return;

      const session = await this.readSession(join(this.taskDir(taskId), 'session.json'));
      if (!session) return;

      session.container_name = containerName;

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
        model,
        prompt,
        actor,
        checkExitCode,
        checkOutput,
        autoTriggered,
        turnType,
        carriesFeedback,
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
        ...(violations && violations.length > 0 ? { violations } : {}),
        ...(model ? { model } : {}),
        ...(prompt ? { prompt } : {}),
        ...(actor ? { actor } : {}),
        ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
        ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
        ...(autoTriggered ? { auto_triggered: true } : {}),
        // Only persist non-default turn types — missing field implies 'work'.
        ...(turnType && turnType !== 'work' ? { turn_type: turnType } : {}),
        // Feedback starts life unconsumed; absent means "carries no feedback".
        ...(carriesFeedback ? { feedback_delivery: 'pending' as const } : {}),
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
    return maxSeq + 1;
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
    const allTasks = await this.listTasks();
    return allTasks.filter((t) => parentTaskIdOf(t) === parentTaskId);
  }

  async getRootTask(taskId: string): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const parentId = parentTaskIdOf(task);
    if (!parentId) return task;
    return this.getRootTask(parentId);
  }

  async getTaskAncestry(taskId: string): Promise<Task[]> {
    const ancestry: Task[] = [];
    let currentId: string | null = taskId;

    while (currentId) {
      const task = await this.getTask(currentId);
      if (!task) break;
      ancestry.unshift(task); // Add to front (root first)
      currentId = parentTaskIdOf(task);
    }

    return ancestry;
  }

  async getTaskTree(rootTaskId: string): Promise<TaskTreeNode | null> {
    const rootTask = await this.getTask(rootTaskId);
    if (!rootTask) return null;

    const buildNode = async (task: Task, depth: number): Promise<TaskTreeNode> => {
      const session = await this.getSessionByTaskId(task.id);
      const children = await this.getChildTasks(task.id);
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

  async createComment(taskId: string, content: string, actor?: Actor, source?: CommentSource): Promise<Comment> {
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
        content,
        created_at: Date.now(),
        ...(actor ? { actor } : {}),
        ...(source ? { source } : {}),
      };

      comments.push(comment);

      await this.atomicWriteTask(fullId, { 'comments.json': { comments } });

      return comment;
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

    return comments.sort((a, b) => a.created_at - b.created_at);
  }

  // --- Journal ---
  //
  // Stored in journal.json (deliberately distinct from comments.json and the
  // legacy notes.json so the two can never collide). Journal entries are
  // prompt-immune: nothing in the prompt-assembly path reads journal.json.

  private async readJournal(taskDir: string): Promise<JournalEntry[]> {
    const journalPath = join(taskDir, 'journal.json');
    const journalFile = await this.readJson<JournalFile>(journalPath);
    return journalFile?.journal ?? [];
  }

  async appendJournalEntry(taskId: string, content: string, actor?: Actor): Promise<JournalEntry> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const journal = await this.readJournal(this.taskDir(fullId));

      const entry: JournalEntry = {
        id: randomUUID(),
        task_id: fullId,
        content,
        created_at: Date.now(),
        ...(actor ? { actor } : {}),
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
    return journal.sort((a, b) => a.created_at - b.created_at);
  }

  // --- Follow-ups (task-level orthogonal-work discoveries) ---

  private async readFollowUps(taskDir: string): Promise<FollowUp[]> {
    const file = await this.readJson<FollowUpsFile>(join(taskDir, 'follow-ups.json'));
    return file?.follow_ups ?? [];
  }

  async createFollowUp(taskId: string, content: string, sessionId?: string | null): Promise<FollowUp> {
    return this.lock.withLock(async () => {
      const fullId = await this.findTaskIdByPrefix(taskId);
      if (!fullId) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const followUps = await this.readFollowUps(this.taskDir(fullId));

      const followUp: FollowUp = {
        id: randomUUID(),
        task_id: fullId,
        content,
        created_at: Date.now(),
        ...(sessionId ? { session_id: sessionId } : {}),
      };

      followUps.push(followUp);

      // INVARIANT: this is a plain storage append — it does NOT create a comment,
      // change task status, or write any protocol/signal. Follow-ups must never
      // trigger an auto-turn/auto-resume (that's why they aren't comments).
      await this.atomicWriteTask(fullId, { 'follow-ups.json': { follow_ups: followUps } });

      return followUp;
    });
  }

  async getTaskFollowUps(taskId: string): Promise<FollowUp[]> {
    const fullId = await this.findTaskIdByPrefix(taskId);
    if (!fullId) return [];

    const followUps = await this.readFollowUps(this.taskDir(fullId));
    return followUps.sort((a, b) => a.created_at - b.created_at);
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

  // --- Conversations ---

  private get conversationsPath(): string {
    return join(this.basePath, 'conversations');
  }

  async saveConversation(conversation: StoredConversation): Promise<void> {
    await mkdir(this.conversationsPath, { recursive: true });
    await writeFile(
      join(this.conversationsPath, `${conversation.sessionId}.json`),
      JSON.stringify(conversation, null, 2),
      'utf-8'
    );
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

    try {
      const files = await readdir(this.conversationsPath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await readFile(join(this.conversationsPath, file), 'utf-8');
          conversations.push(JSON.parse(content) as StoredConversation);
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return conversations.sort((a, b) => {
      const aTime = a.startedAt ?? '';
      const bTime = b.startedAt ?? '';
      return bTime.localeCompare(aTime);
    });
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
      return true;
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

  async saveMemory(input: MemoryWriteInput, actor: Actor): Promise<MemoryRecord> {
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
            revision: existing.revision + 1,
            // Saving a tombstoned name revives it; history keeps the delete.
            deleted_at: undefined,
            deleted_by: undefined,
          }
        : {
            name: input.name,
            description: input.description,
            type: input.type,
            body: input.body,
            created_at: now,
            updated_at: now,
            created_by: actor,
            updated_by: actor,
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

  async deleteMemory(name: string, actor: Actor): Promise<MemoryRecord | null> {
    return this.lock.withLock(async () => {
      const memories = await this.readMemories();
      const existing = memories.find(m => m.name === name);
      if (!existing || existing.deleted_at) return null; // idempotent

      const now = Date.now();
      const tombstoned: MemoryRecord = { ...existing, deleted_at: now, deleted_by: actor };
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

  async saveMemoryCompact(input: MemoryCompactInput, actor: Actor): Promise<MemoryCompact> {
    const compact: MemoryCompact = {
      content: input.content,
      generated_at: Date.now(),
      generated_by: actor,
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

  async addTaskTag(taskId: string, tag: string, actor?: Actor): Promise<Task> {
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
        ...(actor ? { actor } : {}),
      });
      await this.atomicWriteTask(fullId, { 'task.json': task, 'tag-history.json': history });
      return task;
    });
  }

  async removeTaskTag(taskId: string, tag: string, actor?: Actor): Promise<Task> {
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
        ...(actor ? { actor } : {}),
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

  // --- Search ---

  async search(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    try {
      const dirs = await readdir(this.tasksPath);

      for (const dir of dirs) {
        if (dir.includes('.tmp') || dir.includes('.backup')) continue;

        const taskDir = join(this.tasksPath, dir);

        const task = await this.readTask(join(taskDir, 'task.json'));
        if (!task) continue;

        const taskGoal = task.goal;
        const taskCode = task.code ?? null;

        // Search task code
        if (taskCode && this.textMatches(taskCode, query)) {
          results.push({
            entity_type: 'task',
            entity_id: task.id,
            task_id: task.id,
            task_code: taskCode,
            task_goal: taskGoal,
            content: `code: ${taskCode}`,
            match_context: taskCode,
          });
        }

        // Search task goal
        if (this.textMatches(task.goal, query)) {
          results.push({
            entity_type: 'task',
            entity_id: task.id,
            task_id: task.id,
            task_code: taskCode,
            task_goal: taskGoal,
            content: task.goal,
            match_context: task.goal,
          });
        }

        // Search prompt separately
        if (task.prompt && this.textMatches(task.prompt, query)) {
          results.push({
            entity_type: 'prompt',
            entity_id: task.id,
            task_id: task.id,
            task_code: taskCode,
            task_goal: taskGoal,
            content: task.prompt,
            match_context: this.extractContext(task.prompt, query),
          });
        }

        // Search turns
        const turnsFile = await this.readJson<TurnsFile>(join(taskDir, 'turns.json'));
        if (turnsFile) {
          for (const turn of turnsFile.turns) {
            if (this.textMatches(turn.content, query)) {
              results.push({
                entity_type: 'turn',
                entity_id: turn.id,
                task_id: dir,
                task_code: taskCode,
                task_goal: taskGoal,
                content: turn.content,
                match_context: this.extractContext(turn.content, query),
              });
            }
          }
        }

        // Search commits
        const commitsFile = await this.readJson<CommitsFile>(join(taskDir, 'commits.json'));
        if (commitsFile) {
          for (const commit of commitsFile.commits) {
            if (this.textMatches(commit.message, query)) {
              results.push({
                entity_type: 'commit',
                entity_id: commit.id,
                task_id: dir,
                task_code: taskCode,
                task_goal: taskGoal,
                content: commit.message,
                match_context: commit.message,
              });
            }
          }
        }

        // Search comments
        const comments = await this.readComments(taskDir);
        for (const comment of comments) {
          if (this.textMatches(comment.content, query)) {
            results.push({
              entity_type: 'comment',
              entity_id: comment.id,
              task_id: dir,
              task_code: taskCode,
              task_goal: taskGoal,
              content: comment.content,
              match_context: this.extractContext(comment.content, query),
            });
          }
        }

        // Search follow-ups
        const followUps = await this.readFollowUps(taskDir);
        for (const followUp of followUps) {
          if (this.textMatches(followUp.content, query)) {
            results.push({
              entity_type: 'followup',
              entity_id: followUp.id,
              task_id: dir,
              task_code: taskCode,
              task_goal: taskGoal,
              content: followUp.content,
              match_context: this.extractContext(followUp.content, query),
            });
          }
        }

      }
    } catch {
      // If tasks dir doesn't exist, return empty results
    }

    // Search conversations
    try {
      const convDir = join(this.basePath, 'conversations');
      const convFiles = await readdir(convDir);

      for (const file of convFiles) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await readFile(join(convDir, file), 'utf-8');
          const conv = JSON.parse(content) as {
            sessionId: string;
            summary: string;
            messages: Array<{ text: string; role: string }>;
          };

          // Search conversation summary
          if (conv.summary && this.textMatches(conv.summary, query)) {
            results.push({
              entity_type: 'conversation',
              entity_id: conv.sessionId,
              task_id: conv.sessionId,
              task_code: null,
              task_goal: conv.summary,
              content: conv.summary,
              match_context: conv.summary,
            });
          }

          // Search conversation messages
          if (conv.messages) {
            for (const msg of conv.messages) {
              if (msg.text && this.textMatches(msg.text, query)) {
                results.push({
                  entity_type: 'conversation',
                  entity_id: conv.sessionId,
                  task_id: conv.sessionId,
                  task_code: null,
                  task_goal: conv.summary || '(conversation)',
                  content: msg.text,
                  match_context: this.extractContext(msg.text, query),
                });
              }
            }
          }
        } catch {
          // Skip malformed conversation files
        }
      }
    } catch {
      // Conversations directory doesn't exist
    }

    // Search live memory records (name, description, body). Tombstoned records
    // are excluded: they are no longer part of the project's knowledge.
    for (const memory of await this.listMemories()) {
      const haystack = `${memory.name}\n${memory.description}\n${memory.body}`;
      if (this.textMatches(haystack, query)) {
        results.push({
          entity_type: 'memory',
          entity_id: memory.name,
          task_id: memory.name,
          task_code: null,
          task_goal: `memory: ${memory.name}`,
          content: memory.body,
          match_context: this.extractContext(haystack, query),
        });
      }
    }

    return results;
  }

  /**
   * Case-insensitive text match using regex (falls back to literal if invalid regex)
   */
  private textMatches(text: unknown, pattern: string): boolean {
    // Tolerate a missing haystack: a stored record can lack the field the type
    // declares (e.g. a crash turn persisted without `content`). Without this,
    // `regex.test(undefined)` silently tests the literal string "undefined".
    if (typeof text !== 'string') return false;
    try {
      const regex = new RegExp(pattern, 'i');
      return regex.test(text);
    } catch {
      return text.toLowerCase().includes(pattern.toLowerCase());
    }
  }

  /**
   * Extract context around a match
   */
  private extractContext(text: string, pattern: string, contextChars: number = 40): string {
    let matchStart = 0;
    let matchLength = pattern.length;

    try {
      const regex = new RegExp(pattern, 'i');
      const match = text.match(regex);
      if (match && match.index !== undefined) {
        matchStart = match.index;
        matchLength = match[0].length;
      }
    } catch {
      const idx = text.toLowerCase().indexOf(pattern.toLowerCase());
      if (idx !== -1) matchStart = idx;
    }

    const start = Math.max(0, matchStart - contextChars);
    const end = Math.min(text.length, matchStart + matchLength + contextChars);

    let result = text.substring(start, end).replace(/\s+/g, ' ').trim();

    if (start > 0) result = '...' + result;
    if (end < text.length) result = result + '...';

    return result;
  }

  // --- Tracing ---

  async appendTraceSpans(spans: SpanRecord[]): Promise<void> {
    await appendSpansJsonl(this.basePath, spans);
  }

  async readTraceSpans(sinceMs?: number): Promise<SpanRecord[]> {
    return readSpansJsonl(this.basePath, sinceMs);
  }
}
