/**
 * PostgreSQL-backed storage implementation
 *
 * Uses PostgreSQL for shared, concurrent access to task data.
 * Ideal for team collaboration and server/daemon mode.
 */

import postgres from 'postgres';
import { randomUUID } from 'crypto';
import type { Storage, CreateTurnOptions } from './interface';
import type {
  Task,
  TaskTarget,
  Session,
  Turn,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TokenUsage,
  WorktreeSnapshot,
  TaskTreeNode,
  ListTasksOptions,
  SearchResult,
  StoredConversation,
  AgentSessionLog,
  StatusChange,
  Actor,
  FileViolation,
  CommentSource,
  HunkApproval,
  HunkApprovalLineage,
} from './types';
import { isTerminalStatus, DEFAULT_TASK_TYPE, type TaskType } from '../types';
import { targetFromLegacy, targetToLegacy } from '../task-target';
import { assertValidTransition } from '../task-state-machine';

export interface PostgresStorageOptions {
  /** PostgreSQL connection URL (from LAZY_POSTGRES_URL env var) */
  url?: string;
  /** Database host (from PGHOST env var) */
  host?: string;
  /** Database port (from PGPORT env var) */
  port?: number;
  /** Database name (from PGDATABASE env var) */
  database?: string;
  /** Database user (from PGUSER env var) */
  user?: string;
  /** Database password (from PGPASSWORD env var) */
  password?: string;
  /** Enable SSL/TLS (from postgres_ssl in lazy.toml) */
  ssl?: boolean;
  /** Connection pool size (default: 10) */
  max?: number;
}

export class PostgresStorage implements Storage {
  private sql: ReturnType<typeof postgres>;
  private basePath: string;

  constructor(lazyRoot: string, options: PostgresStorageOptions) {
    // BIGINT type parser: PostgreSQL returns BIGINT as strings in JavaScript.
    // Parse to Number (not BigInt) for JSON compatibility and type consistency.
    // JavaScript Number safely handles all integers up to 2^53 (timestamps included).
    const types = {
      bigint: {
        to: 20,
        from: [20],
        parse: (x: string) => Number(x),
        serialize: (x: number) => x.toString(),
      },
    };

    // SSL configuration for cloud databases (Neon, Supabase, etc.)
    const ssl = options.ssl ? { rejectUnauthorized: true } : undefined;

    // Connection parameters to suppress NOTICE spam (CREATE TABLE IF NOT EXISTS, etc.)
    const connection = {
      options: '-c client_min_messages=warning',
    };

    // Initialize connection.
    // Cast: passing a custom `types` map makes postgres.js infer a narrowed
    // Sql<{ bigint: number }>, which is not assignable to the field's
    // Sql<{}> because Sql.begin's callback parameter is contravariant. The
    // narrowing is irrelevant to us (it only affects BIGINT parsing), so we
    // normalize to the base Sql type — mirroring the same escape hatch used
    // for txSql in migrateToV1().
    if (options.url) {
      this.sql = postgres(options.url, {
        max: options.max ?? 10,
        types,
        ssl,
        connection,
      }) as unknown as ReturnType<typeof postgres>;
    } else {
      this.sql = postgres({
        host: options.host ?? 'localhost',
        port: options.port ?? 5432,
        database: options.database ?? 'lazy',
        user: options.user ?? 'postgres',
        password: options.password ?? '',
        max: options.max ?? 10,
        types,
        ssl,
        connection,
      }) as unknown as ReturnType<typeof postgres>;
    }

    // PostgreSQL storage doesn't use local paths, but we need to provide
    // something for compatibility. Use a virtual path.
    this.basePath = `/virtual/postgres/${options.database ?? 'lazy'}`;
  }

  async initialize(): Promise<void> {
    await this.runMigrations();
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  getStoragePath(): string {
    return this.basePath;
  }

  getTaskDir(taskId: string): string {
    return `${this.basePath}/tasks/${taskId}`;
  }

  private async runMigrations(): Promise<void> {
    // Create schema_version table
    await this.sql`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        migrated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        migrated_from TEXT
      )
    `;

    // Check current version
    const [currentVersion] = await this.sql<{ version: number }[]>`
      SELECT version FROM schema_version ORDER BY version DESC LIMIT 1
    `;

    const version = currentVersion?.version ?? 0;

    if (version < 1) {
      await this.migrateToV1();
    }
    if (version < 2) {
      await this.migrateToV2();
    }
    if (version < 3) {
      await this.migrateToV3();
    }
    if (version < 4) {
      await this.migrateToV4();
    }
    if (version < 5) {
      await this.migrateToV5();
    }
    if (version < 6) {
      await this.migrateToV6();
    }
  }

  private async migrateToV1(): Promise<void> {
    // Wrap all schema changes in a transaction for atomicity.
    // Cast: TransactionSql is callable as a tagged template at runtime,
    // but the postgres.js type definitions don't expose call signatures.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      // Tasks table
      await sql`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          code TEXT,
          type TEXT NOT NULL DEFAULT 'task',
          status TEXT NOT NULL,
          model TEXT,
          agent_id TEXT NOT NULL DEFAULT 'claude-code',
          parent_task_id TEXT,
          target JSONB,
          branched_from_sha TEXT,
          close_reason TEXT,
          metadata JSONB,
          created_at BIGINT NOT NULL,
          completed_at BIGINT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_tasks_code ON tasks(code) WHERE code IS NOT NULL`;

      // Sessions table
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          git_branch TEXT NOT NULL,
          git_start_sha TEXT NOT NULL,
          upstream_merge_sha TEXT,
          claude_session_id TEXT,
          container_name TEXT,
          outcome TEXT,
          total_duration_ms BIGINT NOT NULL DEFAULT 0,
          total_usage JSONB,
          last_interaction_at BIGINT,
          interrupt_reason TEXT,
          interrupt_exit_code INTEGER,
          interrupt_at BIGINT,
          interrupt_logs TEXT,
          consecutive_interruptions INTEGER NOT NULL DEFAULT 0,
          auto_resumed BOOLEAN NOT NULL DEFAULT FALSE,
          user_stopped BOOLEAN NOT NULL DEFAULT FALSE,
          started_at BIGINT NOT NULL,
          ended_at BIGINT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id)`;

      // Migration: add user_stopped column if missing (for existing databases)
      await sql`
        DO $$ BEGIN
          ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_stopped BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Turns table
      await sql`
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          model TEXT,
          prompt TEXT,
          start_sha TEXT,
          end_sha TEXT,
          start_sha_work TEXT,
          end_sha_work TEXT,
          merge_conflicts JSONB,
          violations JSONB,
          usage JSONB,
          timestamp BIGINT NOT NULL,
          check_exit_code INTEGER,
          check_output TEXT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id)`;

      // Migration: add violations column if missing (for existing databases)
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS violations JSONB;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Migration: add check columns if missing (for existing databases)
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS check_exit_code INTEGER;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS check_output TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Migration: add auto_triggered column if missing (for existing databases)
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS auto_triggered BOOLEAN DEFAULT FALSE;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Migration: add turn_type column if missing (for existing databases).
      // NULL/missing rows are treated as 'work' (the default) — no backfill
      // needed; callers read with COALESCE when they need an explicit value.
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS turn_type TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Commits table
      await sql`
        CREATE TABLE IF NOT EXISTS commits (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sha TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending_review',
          timestamp BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_commits_session_id ON commits(session_id)`;

      // Reviews table
      await sql`
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          commit_id TEXT NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
          verdict TEXT NOT NULL,
          rationale TEXT NOT NULL,
          reviewer TEXT NOT NULL,
          timestamp BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_reviews_commit_id ON reviews(commit_id)`;

      // Comments table
      await sql`
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          actor TEXT,
          source TEXT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id)`;

      // Migration: add source column if missing (for existing databases)
      await sql`
        DO $$ BEGIN
          ALTER TABLE comments ADD COLUMN IF NOT EXISTS source TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Prompt history table
      await sql`
        CREATE TABLE IF NOT EXISTS prompt_history (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          session_id TEXT,
          created_at BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_prompt_history_task_id ON prompt_history(task_id)`;

      // Worktree snapshots table
      await sql`
        CREATE TABLE IF NOT EXISTS worktree_snapshots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          turn_sequence INTEGER NOT NULL,
          uncommitted_diff TEXT NOT NULL,
          git_status TEXT NOT NULL,
          timestamp BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_session_id ON worktree_snapshots(session_id)`;

      // Status changelog table
      await sql`
        CREATE TABLE IF NOT EXISTS status_changelog (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          actor TEXT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_status_changelog_task_id ON status_changelog(task_id)`;

      // Conversations table
      await sql`
        CREATE TABLE IF NOT EXISTS conversations (
          session_id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          cwd TEXT,
          version TEXT,
          git_branch TEXT,
          started_at TEXT,
          ended_at TEXT,
          imported_at BIGINT NOT NULL,
          summary TEXT NOT NULL,
          stats JSONB NOT NULL,
          total_usage JSONB NOT NULL,
          messages JSONB NOT NULL,
          subagents JSONB NOT NULL
        )
      `;

      // Record migration
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (1, '0')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV2(): Promise<void> {
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;

      // Rewrite legacy model aliases (apprentice/journeyman/master) to current names
      await sql`UPDATE tasks SET model = 'haiku' WHERE model = 'apprentice'`;
      await sql`UPDATE tasks SET model = 'sonnet' WHERE model = 'journeyman'`;
      await sql`UPDATE tasks SET model = 'opus' WHERE model = 'master'`;
      await sql`UPDATE turns SET model = 'haiku' WHERE model = 'apprentice'`;
      await sql`UPDATE turns SET model = 'sonnet' WHERE model = 'journeyman'`;
      await sql`UPDATE turns SET model = 'opus' WHERE model = 'master'`;

      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (2, '1')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV3(): Promise<void> {
    // Per-hunk approval state for `lazy review -i`. CASCADE on task_id
    // auto-purges approvals when a task is deleted; UNIQUE(task_id, hunk_hash)
    // enforces idempotent upserts.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;

      await sql`
        CREATE TABLE IF NOT EXISTS hunk_approvals (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          hunk_hash   TEXT NOT NULL,
          approved_by TEXT,
          approved_at BIGINT NOT NULL,
          UNIQUE(task_id, hunk_hash)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_hunk_approvals_task_id
          ON hunk_approvals(task_id)
      `;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (3, '2')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV4(): Promise<void> {
    // Add split-lineage anchor columns to hunk_approvals so split-hunk
    // approvals can survive re-runs. Existing rows (if any) had no
    // lineage data — leaving these columns NULL on those rows is fine;
    // they'll behave as before (whole-hunk approvals matched by hash).
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE hunk_approvals ADD COLUMN IF NOT EXISTS parent_file TEXT`;
      await sql`ALTER TABLE hunk_approvals ADD COLUMN IF NOT EXISTS parent_lines TEXT`;
      await sql`ALTER TABLE hunk_approvals ADD COLUMN IF NOT EXISTS split_path TEXT`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (4, '3')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV5(): Promise<void> {
    // Raw Claude Code session JSONL, keyed by task. One row per task (1:1 with
    // the latest captured session). CASCADE purges the log when a task is
    // deleted. Distinct from the `conversations` table, which holds the parsed,
    // searchable representation — this preserves the byte-for-byte transcript.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`
        CREATE TABLE IF NOT EXISTS agent_session_logs (
          task_id     TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          session_id  TEXT NOT NULL,
          captured_at BIGINT NOT NULL,
          content     TEXT NOT NULL
        )
      `;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (5, '4')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV6(): Promise<void> {
    // Add the canonical `target` JSONB column (TaskTarget discriminated union).
    // Backfill existing rows from the legacy (parent_task_id,
    // metadata->>'remote_target_branch') pair — the same mapping targetFromLegacy
    // applies in code. parent_task_id stays as the denormalized task↔task edge
    // used by the ancestry CTE and child lookups.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target JSONB`;
      // Backfill: stacked-on-a-task rows → {kind:'task'}; everything else →
      // {kind:'branch'} carrying the legacy remote_target_branch (or '' sentinel).
      await sql`
        UPDATE tasks SET target = jsonb_build_object('kind', 'task', 'parentTaskId', parent_task_id)
        WHERE target IS NULL AND parent_task_id IS NOT NULL
      `;
      await sql`
        UPDATE tasks SET target = jsonb_build_object('kind', 'branch', 'branch', COALESCE(metadata->>'remote_target_branch', ''))
        WHERE target IS NULL AND parent_task_id IS NULL
      `;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (6, '5')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  async createTask(
    goal: string,
    parentTaskId?: string,
    branchedFromSha?: string,
    code?: string,
    type?: string,
    agentId?: string
  ): Promise<Task> {
    // Reject duplicate codes against non-terminal tasks
    if (code) {
      const conflicts = await this.sql`
        SELECT id, status FROM tasks
        WHERE code = ${code} AND status NOT IN ('complete', 'abandoned')
        LIMIT 1
      `;
      if (conflicts.length > 0) {
        const c = conflicts[0];
        throw new Error(`A task with code '${code}' already exists (${(c.id as string).slice(0, 8)}, status: ${c.status}). Choose a different code or abandon the existing task first.`);
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const taskType = (type ?? DEFAULT_TASK_TYPE) as TaskType;
    const resolvedAgentId = agentId ?? 'claude-code';

    const target = targetFromLegacy(parentTaskId ?? null, null);
    // INVARIANT: the parent_task_id column is a pure projection of `target`
    // (targetToLegacy), never set independently — so the denormalized edge
    // used by the ancestry CTE / child lookups can never drift from the
    // canonical union.
    const parentColumn = targetToLegacy(target).parent_task_id;
    await this.sql`
      INSERT INTO tasks (
        id, goal, prompt, code, type, status, parent_task_id, target, branched_from_sha,
        created_at, metadata, agent_id
      )
      VALUES (
        ${id}, ${goal}, '', ${code ?? null}, ${taskType}, 'backlog',
        ${parentColumn}, ${this.sql.json(target)}, ${branchedFromSha ?? null}, ${now}, ${null},
        ${resolvedAgentId}
      )
    `;

    await this.recordStatusChange(id, 'backlog', now);

    return {
      id,
      goal,
      prompt: '',
      code: code ?? null,
      type: taskType,
      status: 'backlog',
      model: null,
      agent_id: resolvedAgentId,
      target,
      branched_from_sha: branchedFromSha ?? null,
      close_reason: null,
      metadata: null,
      created_at: now,
      completed_at: null,
      pending_sync: 0,
    };
  }

  /**
   * Map a raw `tasks` row into the domain Task. The canonical `target` column
   * (TaskTarget) is authoritative; rows predating the column (target IS NULL)
   * are normalized from the legacy (parent_task_id, metadata.remote_target_branch)
   * pair via the single targetFromLegacy mapping. The legacy parent_task_id
   * column survives only as the denormalized task↔task edge for ancestry/child
   * queries; consumers only ever see `target`.
   */
  private rowToTask(row: Record<string, unknown>): Task {
    const parentTaskId = (row.parent_task_id as string | null | undefined) ?? null;
    const metadata = (row.metadata as Record<string, string> | null | undefined) ?? null;
    const rawTarget = row.target as TaskTarget | null | undefined;
    const target = rawTarget ?? targetFromLegacy(parentTaskId, metadata?.remote_target_branch ?? null);
    const { parent_task_id: _parent, ...rest } = row as Record<string, unknown>;
    return { ...rest, metadata, target } as unknown as Task;
  }

  private rowsToTasks(rows: Record<string, unknown>[]): Task[] {
    return rows.map(r => this.rowToTask(r));
  }

  async getTask(taskId: string): Promise<Task | null> {
    const { task } = await this.resolveTask(taskId);
    return task;
  }

  async resolveTask(input: string): Promise<{ task: Task | null; ambiguousMatches?: Task[] }> {
    const [exact] = this.rowsToTasks(await this.sql`SELECT * FROM tasks WHERE id = ${input}`);
    if (exact) return { task: exact };

    if (input.match(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)) {
      const codeMatches = this.rowsToTasks(await this.sql`SELECT * FROM tasks WHERE code = ${input}`);
      if (codeMatches.length === 0) {
        // Fall through to prefix matching
      } else if (codeMatches.length === 1) {
        return { task: codeMatches[0] };
      } else {
        // Multiple matches: apply disambiguation logic
        // 1. Prefer non-terminal tasks over terminal tasks
        const nonTerminal = codeMatches.filter(t => !isTerminalStatus(t.status));
        const terminal = codeMatches.filter(t => isTerminalStatus(t.status));

        if (nonTerminal.length === 1) {
          // Single non-terminal task - use it even if there are terminal tasks
          return { task: nonTerminal[0] };
        }

        if (nonTerminal.length > 1) {
          // Multiple non-terminal tasks - genuinely ambiguous, error
          return { task: null, ambiguousMatches: nonTerminal };
        }

        // All matches are terminal (closed, abandoned, complete)
        if (terminal.length === 1) {
          return { task: terminal[0] };
        }

        // Multiple terminal tasks - prefer most recent (all inactive, so not genuinely ambiguous)
        const sorted = terminal.sort((a, b) => b.created_at - a.created_at);
        return { task: sorted[0] };
      }
    }

    const prefixMatches = this.rowsToTasks(await this.sql`SELECT * FROM tasks WHERE id LIKE ${input + '%'}`);
    if (prefixMatches.length === 1) return { task: prefixMatches[0] };
    if (prefixMatches.length > 1) return { task: null, ambiguousMatches: prefixMatches };

    return { task: null };
  }

  async listTasks(): Promise<Task[]> {
    return this.rowsToTasks(await this.sql`SELECT * FROM tasks ORDER BY created_at DESC`);
  }

  async listTasksWithOptions(options: ListTasksOptions): Promise<Task[]> {
    // Use parameterized queries with conditional fragments instead of sql.unsafe()
    const rows = await this.sql`
      SELECT * FROM tasks
      WHERE 1=1
      ${options.rootsOnly ? this.sql`AND parent_task_id IS NULL` : this.sql``}
      ${options.blockedOnly ? this.sql`AND status IN ('blocked', 'conflict', 'submitted')` : this.sql``}
      ${options.backlogOnly ? this.sql`AND status = 'backlog'` : this.sql``}
      ${options.workingOnly ? this.sql`AND status = 'working'` : this.sql``}
      ${options.interruptedOnly ? this.sql`AND status = 'interrupted'` : this.sql``}
      ${options.pairingOnly ? this.sql`AND status = 'pairing'` : this.sql``}
      ${options.mergingOnly ? this.sql`AND status = 'merging'` : this.sql``}
      ${options.withSessionsOnly ? this.sql`AND EXISTS (SELECT 1 FROM sessions WHERE sessions.task_id = tasks.id)` : this.sql``}
      ${options.nonTerminalOnly ? this.sql`AND status NOT IN ('complete', 'abandoned')` : this.sql``}
      ORDER BY created_at DESC
    `;
    return this.rowsToTasks(rows);
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, actor?: Actor): Promise<void> {
    // Read current status to validate transition
    const [task] = await this.sql<{ status: TaskStatus }[]>`
      SELECT status FROM tasks WHERE id = ${taskId}
    `;
    if (!task) return;
    if (task.status === status) return; // idempotent

    assertValidTransition(task.status, status, actor);

    const now = Date.now();
    const completedAt = isTerminalStatus(status) ? now : null;

    await this.sql`
      UPDATE tasks
      SET status = ${status}, completed_at = ${completedAt}
      WHERE id = ${taskId}
    `;

    await this.recordStatusChange(taskId, status, now, actor);
  }

  async updateTaskGoal(taskId: string, goal: string): Promise<void> {
    await this.sql`UPDATE tasks SET goal = ${goal} WHERE id = ${taskId}`;
  }

  async updateTaskCode(taskId: string, code: string | null): Promise<void> {
    await this.sql`UPDATE tasks SET code = ${code} WHERE id = ${taskId}`;
  }

  async updateTaskTarget(taskId: string, target: TaskTarget): Promise<void> {
    // `target` (JSONB) is authoritative. INVARIANT: the parent_task_id column is
    // a pure projection of `target` (targetToLegacy), never set independently —
    // it's the denormalized task↔task edge for the ancestry CTE / child lookups
    // (NULL for branch targets). We no longer write metadata.remote_target_branch.
    const parentTaskId = targetToLegacy(target).parent_task_id;
    await this.sql`
      UPDATE tasks SET target = ${this.sql.json(target)}, parent_task_id = ${parentTaskId}
      WHERE id = ${taskId}
    `;
  }

  async updateTaskBranchedFromSha(taskId: string, sha: string): Promise<void> {
    await this.sql`UPDATE tasks SET branched_from_sha = ${sha} WHERE id = ${taskId}`;
  }

  async updateTaskModel(taskId: string, model: string): Promise<void> {
    await this.sql`UPDATE tasks SET model = ${model} WHERE id = ${taskId}`;
  }

  async updateTaskType(taskId: string, type: string): Promise<void> {
    await this.sql`UPDATE tasks SET type = ${type} WHERE id = ${taskId}`;
  }

  async resetTaskPendingSync(taskId: string): Promise<void> {
    await this.sql`UPDATE tasks SET pending_sync = 0 WHERE id = ${taskId}`;
  }

  async incrementTaskPendingSync(taskId: string): Promise<void> {
    await this.sql`UPDATE tasks SET pending_sync = pending_sync + 1 WHERE id = ${taskId}`;
  }

  async abandonTask(taskId: string, reason: string, actor?: Actor): Promise<void> {
    const [task] = await this.sql<{ status: TaskStatus }[]>`
      SELECT status FROM tasks WHERE id = ${taskId}
    `;
    if (task) assertValidTransition(task.status, 'abandoned');

    const now = Date.now();

    await this.sql`
      UPDATE tasks
      SET status = 'abandoned', close_reason = ${reason}, completed_at = ${now}
      WHERE id = ${taskId}
    `;

    await this.recordStatusChange(taskId, 'abandoned', now, actor);
  }

  async reopenTask(taskId: string, actor?: Actor): Promise<void> {
    const [task] = await this.sql<{ status: TaskStatus }[]>`
      SELECT status FROM tasks WHERE id = ${taskId}
    `;
    if (!task) return;

    // Determine target: 'blocked' if task had sessions, 'backlog' otherwise
    const [sessionRow] = await this.sql<{ id: string }[]>`
      SELECT id FROM sessions WHERE task_id = ${taskId} LIMIT 1
    `;
    const newStatus: TaskStatus = sessionRow ? 'blocked' : 'backlog';
    assertValidTransition(task.status, newStatus);

    const now = Date.now();
    await this.sql`UPDATE tasks SET status = ${newStatus}, completed_at = NULL WHERE id = ${taskId}`;
    await this.recordStatusChange(taskId, newStatus, now, actor);
  }

  async updateTaskMetadata(taskId: string, key: string, value: string): Promise<void> {
    // Atomic JSONB merge to prevent race conditions from concurrent updates
    await this.sql`
      UPDATE tasks
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)
      WHERE id = ${taskId}
    `;
  }

  async getTaskMetadata(taskId: string, key: string): Promise<string | null> {
    const [task] = await this.sql<{ metadata: Record<string, string> | null }[]>`
      SELECT metadata FROM tasks WHERE id = ${taskId}
    `;

    return task?.metadata?.[key] ?? null;
  }

  async updateTaskPrompt(taskId: string, content: string, sessionId?: string): Promise<TaskPromptVersion> {
    const [result] = await this.sql<{ max: number | null }[]>`
      SELECT MAX(version) as max FROM prompt_history WHERE task_id = ${taskId}
    `;

    const nextVersion = (result?.max ?? 0) + 1;
    const id = randomUUID();
    const now = Date.now();

    await this.sql`
      INSERT INTO prompt_history (id, task_id, version, content, session_id, created_at)
      VALUES (${id}, ${taskId}, ${nextVersion}, ${content}, ${sessionId ?? null}, ${now})
    `;

    // Also update task.prompt to latest
    await this.sql`UPDATE tasks SET prompt = ${content} WHERE id = ${taskId}`;

    return {
      id,
      task_id: taskId,
      version: nextVersion,
      content,
      session_id: sessionId ?? null,
      created_at: now,
    };
  }

  async getPromptHistory(taskId: string): Promise<TaskPromptVersion[]> {
    return this.sql<TaskPromptVersion[]>`
      SELECT * FROM prompt_history WHERE task_id = ${taskId} ORDER BY version ASC
    `;
  }

  async getPromptVersion(taskId: string, version: number): Promise<TaskPromptVersion | null> {
    const [result] = await this.sql<TaskPromptVersion[]>`
      SELECT * FROM prompt_history WHERE task_id = ${taskId} AND version = ${version}
    `;
    return result ?? null;
  }

  async createSession(
    taskId: string,
    agentId: string,
    gitBranch: string,
    gitStartSha: string,
    claudeSessionId?: string
  ): Promise<Session> {
    const id = randomUUID();
    const now = Date.now();

    await this.sql`
      INSERT INTO sessions (
        id, task_id, agent_id, git_branch, git_start_sha, claude_session_id, started_at
      )
      VALUES (${id}, ${taskId}, ${agentId}, ${gitBranch}, ${gitStartSha}, ${claudeSessionId ?? null}, ${now})
    `;

    return {
      id,
      task_id: taskId,
      agent_id: agentId,
      git_branch: gitBranch,
      git_start_sha: gitStartSha,
      upstream_merge_sha: null,
      agent_session_id: claudeSessionId ?? null,
      container_name: null,
      outcome: null,
      total_duration_ms: 0,
      total_usage: null,
      last_interaction_at: null,
      interrupt_reason: null,
      interrupt_exit_code: null,
      interrupt_at: null,
      interrupt_logs: null,
      consecutive_interruptions: 0,
      auto_resumed: false,
      user_stopped: false,
      started_at: now,
      ended_at: null,
    };
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const [exact] = await this.sql<Session[]>`SELECT * FROM sessions WHERE id = ${sessionId}`;
    if (exact) return exact;

    const prefixMatches = await this.sql<Session[]>`SELECT * FROM sessions WHERE id LIKE ${sessionId + '%'}`;
    return prefixMatches.length === 1 ? prefixMatches[0] : null;
  }

  async getSessionByTaskId(taskId: string): Promise<Session | null> {
    const [session] = await this.sql<Session[]>`SELECT * FROM sessions WHERE task_id = ${taskId}`;
    return session ?? null;
  }

  async listSessions(taskId?: string, activeOnly?: boolean): Promise<Session[]> {
    if (taskId && activeOnly) {
      return this.sql<Session[]>`SELECT * FROM sessions WHERE task_id = ${taskId} AND ended_at IS NULL`;
    } else if (taskId) {
      return this.sql<Session[]>`SELECT * FROM sessions WHERE task_id = ${taskId} ORDER BY started_at DESC`;
    } else if (activeOnly) {
      return this.sql<Session[]>`SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`;
    } else {
      return this.sql<Session[]>`SELECT * FROM sessions ORDER BY started_at DESC`;
    }
  }

  async endSession(sessionId: string, outcome: SessionOutcome): Promise<void> {
    await this.sql`
      UPDATE sessions SET outcome = ${outcome}, ended_at = ${Date.now()} WHERE id = ${sessionId}
    `;
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.sql`UPDATE sessions SET ended_at = NULL, outcome = NULL WHERE id = ${sessionId}`;
  }

  async updateSessionClaudeId(sessionId: string, claudeSessionId: string): Promise<void> {
    await this.sql`UPDATE sessions SET claude_session_id = ${claudeSessionId} WHERE id = ${sessionId}`;
  }

  async updateSessionContainerName(sessionId: string, containerName: string | null): Promise<void> {
    await this.sql`UPDATE sessions SET container_name = ${containerName} WHERE id = ${sessionId}`;
  }

  async updateSessionInteraction(sessionId: string, durationMs: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE sessions
      SET total_duration_ms = total_duration_ms + ${durationMs}, last_interaction_at = ${now}
      WHERE id = ${sessionId}
    `;
  }

  async updateSessionUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    // Atomic JSONB accumulation to prevent race conditions from concurrent updates
    await this.sql`
      UPDATE sessions SET total_usage = jsonb_build_object(
        'inputTokens', COALESCE((total_usage->>'inputTokens')::bigint, 0) + ${usage.inputTokens},
        'outputTokens', COALESCE((total_usage->>'outputTokens')::bigint, 0) + ${usage.outputTokens},
        'cacheCreationTokens', COALESCE((total_usage->>'cacheCreationTokens')::bigint, 0) + ${usage.cacheCreationTokens},
        'cacheReadTokens', COALESCE((total_usage->>'cacheReadTokens')::bigint, 0) + ${usage.cacheReadTokens}
      )
      WHERE id = ${sessionId}
    `;
  }

  async updateSessionUpstreamMergeSha(sessionId: string, sha: string): Promise<void> {
    await this.sql`UPDATE sessions SET upstream_merge_sha = ${sha} WHERE id = ${sessionId}`;
  }

  async recordInterrupt(
    sessionId: string,
    diagnostics: {
      reason: string;
      exit_code: number | null;
      logs: string | null;
    }
  ): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE sessions
      SET
        consecutive_interruptions = consecutive_interruptions + 1,
        interrupt_reason = ${diagnostics.reason},
        interrupt_exit_code = ${diagnostics.exit_code},
        interrupt_at = ${now},
        interrupt_logs = ${diagnostics.logs}
      WHERE id = ${sessionId}
    `;
  }

  async resetConsecutiveInterruptions(sessionId: string): Promise<void> {
    // Manual resume/unblock re-arms auto-resume: clear the user-stop gate
    // and auto_resumed flag alongside the counter (mirrors FileStorage).
    await this.sql`UPDATE sessions SET consecutive_interruptions = 0, auto_resumed = FALSE, user_stopped = FALSE WHERE id = ${sessionId}`;
  }

  async setAutoResumed(sessionId: string, autoResumed: boolean): Promise<void> {
    await this.sql`UPDATE sessions SET auto_resumed = ${autoResumed} WHERE id = ${sessionId}`;
  }

  async setUserStopped(sessionId: string, userStopped: boolean): Promise<void> {
    await this.sql`UPDATE sessions SET user_stopped = ${userStopped} WHERE id = ${sessionId}`;
  }

  async createTurn(options: CreateTurnOptions): Promise<Turn> {
    const id = randomUUID();
    const now = Date.now();

    // Store NULL for the default 'work' so the column stays sparse — a
    // future 'comment' or 'hook' variant gets its own string value.
    const storedTurnType = options.turnType && options.turnType !== 'work' ? options.turnType : null;
    await this.sql`
      INSERT INTO turns (
        id, session_id, sequence, role, content, model, prompt,
        start_sha, end_sha, start_sha_work, end_sha_work,
        merge_conflicts, violations, usage, timestamp,
        check_exit_code, check_output, auto_triggered, turn_type
      )
      VALUES (
        ${id}, ${options.sessionId}, ${options.sequence}, ${options.role}, ${options.content},
        ${options.model ?? null}, ${options.prompt ?? null}, ${options.startSha ?? null}, ${options.endSha ?? null},
        ${options.startShaWork ?? null}, ${options.endShaWork ?? null},
        ${options.mergeConflicts ? JSON.stringify(options.mergeConflicts) : null},
        ${options.violations ? JSON.stringify(options.violations) : null},
        ${options.usage ? JSON.stringify(options.usage) : null}, ${now},
        ${options.checkExitCode ?? null}, ${options.checkOutput ?? null},
        ${options.autoTriggered ?? false}, ${storedTurnType}
      )
    `;

    return {
      id,
      session_id: options.sessionId,
      sequence: options.sequence,
      role: options.role,
      content: options.content,
      model: options.model,
      prompt: options.prompt,
      start_sha: options.startSha ?? null,
      end_sha: options.endSha ?? null,
      start_sha_work: options.startShaWork ?? null,
      end_sha_work: options.endShaWork ?? null,
      merge_conflicts: options.mergeConflicts,
      violations: options.violations,
      usage: options.usage ?? null,
      timestamp: now,
      ...(options.checkExitCode !== undefined ? { check_exit_code: options.checkExitCode } : {}),
      ...(options.checkOutput !== undefined ? { check_output: options.checkOutput } : {}),
      ...(options.autoTriggered ? { auto_triggered: true } : {}),
      ...(storedTurnType ? { turn_type: storedTurnType } : {}),
    };
  }

  async getSessionTurns(sessionId: string): Promise<Turn[]> {
    return this.sql<Turn[]>`SELECT * FROM turns WHERE session_id = ${sessionId} ORDER BY sequence ASC`;
  }

  async getNextTurnSequence(sessionId: string): Promise<number> {
    const [result] = await this.sql<{ max: number | null }[]>`
      SELECT MAX(sequence) as max FROM turns WHERE session_id = ${sessionId}
    `;
    return (result?.max ?? -1) + 1;
  }

  async getTurnCountByTaskId(taskId: string): Promise<number> {
    const [result] = await this.sql<{ count: number }[]>`
      SELECT COUNT(*) as count FROM turns
      INNER JOIN sessions ON turns.session_id = sessions.id
      WHERE sessions.task_id = ${taskId}
    `;
    return result?.count ?? 0;
  }

  async updateTurnViolations(_taskId: string, turnId: string, violations: FileViolation[]): Promise<void> {
    await this.sql`
      UPDATE turns SET violations = ${JSON.stringify(violations)}
      WHERE id = ${turnId}
    `;
  }

  async createCommit(sessionId: string, sha: string, message: string): Promise<Commit> {
    const id = randomUUID();
    const now = Date.now();

    await this.sql`
      INSERT INTO commits (id, session_id, sha, message, status, timestamp)
      VALUES (${id}, ${sessionId}, ${sha}, ${message}, 'pending_review', ${now})
    `;

    return {
      id,
      session_id: sessionId,
      sha,
      message,
      status: 'pending_review',
      timestamp: now,
    };
  }

  async getSessionCommits(sessionId: string): Promise<Commit[]> {
    return this.sql<Commit[]>`SELECT * FROM commits WHERE session_id = ${sessionId} ORDER BY timestamp ASC`;
  }

  async createReview(
    commitId: string,
    verdict: ReviewVerdict,
    rationale: string,
    reviewer: string
  ): Promise<Review> {
    const id = randomUUID();
    const now = Date.now();

    await this.sql`
      INSERT INTO reviews (id, commit_id, verdict, rationale, reviewer, timestamp)
      VALUES (${id}, ${commitId}, ${verdict}, ${rationale}, ${reviewer}, ${now})
    `;

    return { id, commit_id: commitId, verdict, rationale, reviewer, timestamp: now };
  }

  async getCommitReviews(commitId: string): Promise<Review[]> {
    return this.sql<Review[]>`SELECT * FROM reviews WHERE commit_id = ${commitId} ORDER BY timestamp ASC`;
  }

  async createWorktreeSnapshot(
    sessionId: string,
    turnSequence: number,
    uncommittedDiff: string,
    gitStatus: string
  ): Promise<WorktreeSnapshot> {
    const id = randomUUID();
    const now = Date.now();

    await this.sql`
      INSERT INTO worktree_snapshots (id, session_id, turn_sequence, uncommitted_diff, git_status, timestamp)
      VALUES (${id}, ${sessionId}, ${turnSequence}, ${uncommittedDiff}, ${gitStatus}, ${now})
    `;

    return { id, session_id: sessionId, turn_sequence: turnSequence, uncommitted_diff: uncommittedDiff, git_status: gitStatus, timestamp: now };
  }

  async getLatestWorktreeSnapshot(sessionId: string): Promise<WorktreeSnapshot | null> {
    const [snapshot] = await this.sql<WorktreeSnapshot[]>`
      SELECT * FROM worktree_snapshots WHERE session_id = ${sessionId} ORDER BY turn_sequence DESC LIMIT 1
    `;
    return snapshot ?? null;
  }

  async getWorktreeSnapshotForTurn(sessionId: string, turnSequence: number): Promise<WorktreeSnapshot | null> {
    const [snapshot] = await this.sql<WorktreeSnapshot[]>`
      SELECT * FROM worktree_snapshots WHERE session_id = ${sessionId} AND turn_sequence = ${turnSequence}
    `;
    return snapshot ?? null;
  }

  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    return this.rowsToTasks(await this.sql`SELECT * FROM tasks WHERE parent_task_id = ${parentTaskId} ORDER BY created_at ASC`);
  }

  async getRootTask(taskId: string): Promise<Task | null> {
    const ancestry = await this.getTaskAncestry(taskId);
    return ancestry.length > 0 ? ancestry[0] : null;
  }

  async getTaskAncestry(taskId: string): Promise<Task[]> {
    const results = this.rowsToTasks(await this.sql`
      WITH RECURSIVE ancestors AS (
        SELECT * FROM tasks WHERE id = ${taskId}
        UNION ALL
        SELECT t.* FROM tasks t INNER JOIN ancestors a ON t.id = a.parent_task_id
      )
      SELECT * FROM ancestors
    `);
    return results.reverse();
  }

  async getTaskTree(rootTaskId: string, depth: number = 0): Promise<TaskTreeNode | null> {
    const task = await this.getTask(rootTaskId);
    if (!task) return null;

    const session = await this.getSessionByTaskId(rootTaskId);
    const children = await this.getChildTasks(rootTaskId);

    const childNodes = await Promise.all(
      children.map(async child => {
        const subtree = await this.getTaskTree(child.id, depth + 1);
        return subtree!;
      })
    );

    return { task, session, children: childNodes, depth };
  }

  async createComment(taskId: string, content: string, actor?: Actor, source?: CommentSource): Promise<Comment> {
    const id = randomUUID();
    const now = Date.now();

    await this.sql`
      INSERT INTO comments (id, task_id, content, created_at, actor, source)
      VALUES (${id}, ${taskId}, ${content}, ${now}, ${actor ?? null}, ${source ?? null})
    `;

    return { id, task_id: taskId, content, created_at: now, actor, source };
  }

  async getTaskComments(taskId: string): Promise<Comment[]> {
    return this.sql<Comment[]>`SELECT * FROM comments WHERE task_id = ${taskId} ORDER BY created_at ASC`;
  }

  async listHunkApprovals(taskId: string): Promise<HunkApproval[]> {
    return this.sql<HunkApproval[]>`
      SELECT * FROM hunk_approvals WHERE task_id = ${taskId} ORDER BY approved_at ASC
    `;
  }

  async createHunkApproval(
    taskId: string,
    hunkHash: string,
    actor?: Actor,
    lineage?: HunkApprovalLineage,
  ): Promise<HunkApproval> {
    const id = randomUUID();
    const now = Date.now();
    // Upsert without races: ON CONFLICT DO NOTHING returns the new row, or
    // nothing when an existing row already covers (task_id, hunk_hash). In
    // the latter case we SELECT the existing row.
    const inserted = await this.sql<HunkApproval[]>`
      INSERT INTO hunk_approvals (
        id, task_id, hunk_hash, approved_by, approved_at,
        parent_file, parent_lines, split_path
      )
      VALUES (
        ${id}, ${taskId}, ${hunkHash}, ${actor ?? null}, ${now},
        ${lineage?.parent_file ?? null}, ${lineage?.parent_lines ?? null}, ${lineage?.split_path ?? null}
      )
      ON CONFLICT (task_id, hunk_hash) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return inserted[0];
    const [existing] = await this.sql<HunkApproval[]>`
      SELECT * FROM hunk_approvals WHERE task_id = ${taskId} AND hunk_hash = ${hunkHash}
    `;
    return existing;
  }

  async saveConversation(conversation: StoredConversation): Promise<void> {
    // postgres.js handles object→JSONB natively; do not JSON.stringify or it double-serializes
    await this.sql`
      INSERT INTO conversations (
        session_id, project_path, cwd, version, git_branch,
        started_at, ended_at, imported_at, summary, stats,
        total_usage, messages, subagents
      )
      VALUES (
        ${conversation.sessionId}, ${conversation.projectPath}, ${conversation.cwd},
        ${conversation.version}, ${conversation.gitBranch}, ${conversation.startedAt},
        ${conversation.endedAt}, ${conversation.importedAt}, ${conversation.summary},
        ${this.sql.json(conversation.stats as any)},
        ${this.sql.json(conversation.totalUsage as any)},
        ${this.sql.json(conversation.messages as any)},
        ${this.sql.json(conversation.subagents as any)}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        project_path = EXCLUDED.project_path,
        cwd = EXCLUDED.cwd,
        version = EXCLUDED.version,
        git_branch = EXCLUDED.git_branch,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        imported_at = EXCLUDED.imported_at,
        summary = EXCLUDED.summary,
        stats = EXCLUDED.stats,
        total_usage = EXCLUDED.total_usage,
        messages = EXCLUDED.messages,
        subagents = EXCLUDED.subagents
    `;
  }

  async loadConversation(sessionId: string): Promise<StoredConversation | null> {
    const [conv] = await this.sql<StoredConversation[]>`
      SELECT
        session_id AS "sessionId",
        project_path AS "projectPath",
        cwd,
        version,
        git_branch AS "gitBranch",
        started_at AS "startedAt",
        ended_at AS "endedAt",
        imported_at AS "importedAt",
        summary,
        stats,
        total_usage AS "totalUsage",
        messages,
        subagents
      FROM conversations WHERE session_id = ${sessionId}
    `;
    return conv ?? null;
  }

  async listConversations(): Promise<StoredConversation[]> {
    return this.sql<StoredConversation[]>`
      SELECT
        session_id AS "sessionId",
        project_path AS "projectPath",
        cwd,
        version,
        git_branch AS "gitBranch",
        started_at AS "startedAt",
        ended_at AS "endedAt",
        imported_at AS "importedAt",
        summary,
        stats,
        total_usage AS "totalUsage",
        messages,
        subagents
      FROM conversations ORDER BY imported_at DESC
    `;
  }

  async isConversationImported(sessionId: string): Promise<boolean> {
    const [result] = await this.sql<{ count: number }[]>`
      SELECT COUNT(*) as count FROM conversations WHERE session_id = ${sessionId}
    `;
    return (result?.count ?? 0) > 0;
  }

  // --- Agent Session Logs (raw Claude Code JSONL) ---

  async saveAgentSessionLog(taskId: string, sessionId: string, content: string): Promise<void> {
    const { task } = await this.resolveTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.sql`
      INSERT INTO agent_session_logs (task_id, session_id, captured_at, content)
      VALUES (${task.id}, ${sessionId}, ${Date.now()}, ${content})
      ON CONFLICT (task_id) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        captured_at = EXCLUDED.captured_at,
        content = EXCLUDED.content
    `;
  }

  async getAgentSessionLog(taskId: string): Promise<AgentSessionLog | null> {
    const { task } = await this.resolveTask(taskId);
    if (!task) return null;
    const [row] = await this.sql<AgentSessionLog[]>`
      SELECT
        task_id AS "taskId",
        session_id AS "sessionId",
        captured_at AS "capturedAt",
        content
      FROM agent_session_logs WHERE task_id = ${task.id}
    `;
    return row ?? null;
  }

  private async recordStatusChange(taskId: string, status: string, timestamp: number, actor?: Actor): Promise<void> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO status_changelog (id, task_id, status, timestamp, actor)
      VALUES (${id}, ${taskId}, ${status}, ${timestamp}, ${actor ?? null})
    `;
  }

  async getStatusHistory(taskId: string): Promise<StatusChange[]> {
    return this.sql<StatusChange[]>`
      SELECT status, timestamp, actor FROM status_changelog WHERE task_id = ${taskId} ORDER BY timestamp ASC
    `;
  }

  async search(query: string): Promise<SearchResult[]> {
    const pattern = `%${query}%`;

    // Run all 6 queries in parallel since they're independent
    const [taskRows, prompts, turns, commits, comments, conversations] = await Promise.all([
      this.sql`SELECT * FROM tasks WHERE goal ILIKE ${pattern}`,

      this.sql<(TaskPromptVersion & { task_goal: string; task_code: string | null })[]>`
        SELECT ph.*, t.goal as task_goal, t.code as task_code
        FROM prompt_history ph
        INNER JOIN tasks t ON ph.task_id = t.id
        WHERE ph.content ILIKE ${pattern}
      `,

      this.sql<(Turn & { task_id: string; task_goal: string; task_code: string | null })[]>`
        SELECT t.*, s.task_id, tasks.goal as task_goal, tasks.code as task_code
        FROM turns t
        INNER JOIN sessions s ON t.session_id = s.id
        INNER JOIN tasks ON s.task_id = tasks.id
        WHERE t.content ILIKE ${pattern}
      `,

      this.sql<(Commit & { task_id: string; task_goal: string; task_code: string | null })[]>`
        SELECT c.*, s.task_id, tasks.goal as task_goal, tasks.code as task_code
        FROM commits c
        INNER JOIN sessions s ON c.session_id = s.id
        INNER JOIN tasks ON s.task_id = tasks.id
        WHERE c.message ILIKE ${pattern}
      `,

      this.sql<(Comment & { task_goal: string; task_code: string | null })[]>`
        SELECT c.*, t.goal as task_goal, t.code as task_code
        FROM comments c
        INNER JOIN tasks t ON c.task_id = t.id
        WHERE c.content ILIKE ${pattern}
      `,

      this.sql<StoredConversation[]>`
        SELECT
          session_id AS "sessionId",
          project_path AS "projectPath",
          cwd,
          version,
          git_branch AS "gitBranch",
          started_at AS "startedAt",
          ended_at AS "endedAt",
          imported_at AS "importedAt",
          summary,
          stats,
          total_usage AS "totalUsage",
          messages,
          subagents
        FROM conversations WHERE summary ILIKE ${pattern}
      `,
    ]);

    const results: SearchResult[] = [];

    const tasks = this.rowsToTasks(taskRows);
    for (const task of tasks) {
      results.push({
        entity_type: 'task',
        entity_id: task.id,
        task_id: task.id,
        task_code: task.code,
        task_goal: task.goal,
        content: task.goal,
        match_context: task.goal,
      });
    }

    for (const prompt of prompts) {
      results.push({
        entity_type: 'prompt',
        entity_id: `${prompt.task_id}-v${prompt.version}`,
        task_id: prompt.task_id,
        task_code: prompt.task_code,
        task_goal: prompt.task_goal,
        content: prompt.content,
        match_context: prompt.content.slice(0, 200),
      });
    }

    for (const turn of turns) {
      results.push({
        entity_type: 'turn',
        entity_id: turn.id,
        task_id: turn.task_id,
        task_code: turn.task_code,
        task_goal: turn.task_goal,
        content: turn.content,
        match_context: turn.content.slice(0, 200),
      });
    }

    for (const commit of commits) {
      results.push({
        entity_type: 'commit',
        entity_id: commit.id,
        task_id: commit.task_id,
        task_code: commit.task_code,
        task_goal: commit.task_goal,
        content: commit.message,
        match_context: commit.message,
      });
    }

    for (const comment of comments) {
      results.push({
        entity_type: 'comment',
        entity_id: comment.id,
        task_id: comment.task_id,
        task_code: comment.task_code,
        task_goal: comment.task_goal,
        content: comment.content,
        match_context: comment.content.slice(0, 200),
      });
    }

    for (const conv of conversations) {
      results.push({
        entity_type: 'conversation',
        entity_id: conv.sessionId,
        task_id: '',
        task_code: null,
        task_goal: '',
        content: conv.summary,
        match_context: conv.summary,
      });
    }

    return results;
  }
}
