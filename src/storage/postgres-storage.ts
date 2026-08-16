/**
 * PostgreSQL-backed storage implementation
 *
 * Uses PostgreSQL for shared, concurrent access to task data.
 * Ideal for team collaboration and server/daemon mode.
 */

import postgres from 'postgres';
import { randomUUID } from 'crypto';
import type { Storage, CreateTurnOptions } from './interface';
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
import type { WaitInterval, WaitOutcome } from '../types';
import type {
  Task,
  TaskTarget,
  Session,
  Turn,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  JournalEntry,
  FollowUp,
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
  BuilderResumeIntent,
  StatusChange,
  Actor,
  TagEvent,
  MemoryRecord,
  MemoryEvent,
  MemoryWriteInput,
  MemoryCompact,
  MemoryCompactInput,
  FileViolation,
  CommentSource,
  HunkApproval,
  HunkApprovalLineage,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  FeedbackDelivery,
} from './types';
import { isTerminalStatus, DEFAULT_TASK_TYPE, DEFAULT_TASK_PRIORITY, type TaskType } from '../types';
import { normalizeTag } from '../utils/tags';
import { targetFromLegacy, targetToLegacy } from '../task-target';
import { assertValidTransition } from '../task-state-machine';
import type { RunnerType } from '../config/types';
import { turnText } from '../utils/turn-content';

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

/**
 * INVARIANT (cross-backend row contract): an OPTIONAL (`?`) field on a domain
 * type means "the key is absent when unset". FileStorage writes JSON that
 * simply omits the key, and RemoteStorage forwards whatever the daemon's
 * backend produced. A Postgres `SELECT *` instead hands back SQL NULL for
 * every unset nullable column, so a consumer doing `'model' in turn` or
 * `turn.model === undefined` would behave differently depending on which
 * backend it happens to be talking to.
 *
 * Every Postgres reader therefore maps its rows through one of the
 * `rowTo*`/`*_OPTIONAL_COLUMNS` pairs below, which delete the optional keys
 * that came back NULL. Fields typed `| null` (start_sha, usage, outcome,
 * session.ended_at, …) KEEP their null — null IS their unset value on every
 * backend, and dropping it would be the same divergence in the other
 * direction. `test/e2e/storage-contract.test.ts` pins both halves.
 */
function dropNullOptionals<T>(row: Record<string, unknown>, optionalColumns: readonly string[]): T {
  for (const key of optionalColumns) {
    if (row[key] === null) delete row[key];
  }
  return row as T;
}

/** Optional (`?`) fields of `Turn` — see `dropNullOptionals`. */
const TURN_OPTIONAL_COLUMNS = [
  'merge_conflicts',
  'violations',
  'model',
  'model_id',
  'effort',
  'mcp_tools',
  'prompt',
  'actor',
  'check_exit_code',
  'check_output',
  'auto_triggered',
  'turn_type',
  'feedback_delivery',
] as const;

/** JSONB columns on `turns` that must come back as structured values. */
const TURN_JSON_COLUMNS = ['merge_conflicts', 'violations', 'usage'] as const;

/** Optional (`?`) fields of `Comment`. */
const COMMENT_OPTIONAL_COLUMNS = ['actor', 'source'] as const;

/** Optional (`?`) fields of `JournalEntry`. */
const JOURNAL_OPTIONAL_COLUMNS = ['actor'] as const;

/** Optional (`?`) fields of `FollowUp`. */
const FOLLOW_UP_OPTIONAL_COLUMNS = ['session_id'] as const;

/** Optional (`?`) fields of `HunkApproval`. */
const HUNK_APPROVAL_OPTIONAL_COLUMNS = [
  'approved_by',
  'parent_file',
  'parent_lines',
  'split_path',
] as const;

/** Optional (`?`) fields of `StatusChange` and `TagEvent`. */
const ACTOR_ONLY_OPTIONAL_COLUMNS = ['actor'] as const;

/** Optional (`?`) fields of `BuilderResumeIntent` (camelCase — see loadBuilderResumeIntent). */
const BUILDER_RESUME_INTENT_OPTIONAL_COLUMNS = ['sessionId', 'upgradePid', 'upgradeHost', 'reason'] as const;

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
    if (version < 7) {
      await this.migrateToV7();
    }
    if (version < 8) {
      await this.migrateToV8();
    }
    if (version < 9) {
      await this.migrateToV9();
    }
    if (version < 10) {
      await this.migrateToV10();
    }
    if (version < 11) {
      await this.migrateToV11();
    }
    if (version < 12) {
      await this.migrateToV12();
    }
    if (version < 13) {
      await this.migrateToV13();
    }
    if (version < 14) {
      await this.migrateToV14();
    }
    if (version < 15) {
      await this.migrateToV15();
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
          tags JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at BIGINT NOT NULL,
          completed_at BIGINT
        )
      `;

      // Backfill the tags column on databases created before tagging existed.
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb`;

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
          check_output TEXT,
          model_id TEXT,
          effort TEXT,
          mcp_tools TEXT
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

      // Migration: add feedback_delivery column if missing (for existing
      // databases). NULL means "this turn carries no redeliverable feedback",
      // which is the correct reading for every pre-existing row — turns written
      // before this column existed were already delivered or already crashed,
      // and resurrecting them now would be a stale redelivery.
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS feedback_delivery TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;

      // Migration: add model_id/effort columns if missing (for existing
      // databases). NULL is the honest reading for every pre-existing row —
      // those turns were written before the launch settings were captured, and
      // backfilling them from today's task-level model/effort would invent
      // history that never happened. Old turns stay readable with both NULL.
      await sql`
        DO $$ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS model_id TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$
      `;
      await sql`
        DO $ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS effort TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $
      `;

      // Migration: add mcp_tools — what the agent reported about its own lazy
      // MCP tools at session start. NULL on every pre-existing row is the
      // honest reading: those turns were never observed, which is not the same
      // as having had no tools.
      await sql`
        DO $ BEGIN
          ALTER TABLE turns ADD COLUMN IF NOT EXISTS mcp_tools TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $
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

      // Journal table — append-only, prompt-immune side channel. A separate
      // table (not a flag on comments) so there is structurally no code path
      // from a journal entry into the agent prompt.
      await sql`
        CREATE TABLE IF NOT EXISTS journal_entries (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          actor TEXT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_task_id ON journal_entries(task_id)`;

      // Follow-ups table (task-level orthogonal-work discoveries). Kept separate
      // from comments precisely because follow-ups must never feed the comment
      // auto-react loop — see FollowUp invariant in src/types/index.ts.
      await sql`
        CREATE TABLE IF NOT EXISTS follow_ups (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          session_id TEXT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_follow_ups_task_id ON follow_ups(task_id)`;

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

      // Tag history table (append-only audit trail of every tag/untag)
      await sql`
        CREATE TABLE IF NOT EXISTS tag_history (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          action TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          actor TEXT
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_tag_history_task_id ON tag_history(task_id)`;

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

      // Builder resume intents (durable upgrade↔builder handshake)
      await sql`
        CREATE TABLE IF NOT EXISTS builder_resume_intents (
          builder_id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          session_id TEXT,
          created_at TEXT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_builder_resume_intents_project_root ON builder_resume_intents(project_root)`;

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

  private async migrateToV7(): Promise<void> {
    // Per-task runner override. NULL = inherit the global `[runner] type`.
    // tasks.runner_type is the persisted override; sessions.runner_type is the
    // runner the session actually launched on (the monitoring source of truth).
    //
    // Also add the `priority` column (queue ordering for concurrency-limited
    // starts). NOT NULL DEFAULT 'normal' backfills every existing row in one
    // statement.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS runner_type TEXT`;
      await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runner_type TEXT`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (7, '6')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV8(): Promise<void> {
    // Lazy-owned shared memory: named records + an append-only, actor-attributed
    // write history. `memories.name` is the primary key — an update supersedes
    // by name; `memory_history` is never rewritten (no UPDATE/DELETE on it).
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`
        CREATE TABLE IF NOT EXISTS memories (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          type TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          revision INTEGER NOT NULL,
          deleted_at BIGINT,
          deleted_by TEXT
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS memory_history (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          revision INTEGER NOT NULL,
          description TEXT,
          type TEXT,
          body TEXT
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_memory_history_name ON memory_history(name)`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (8, '7')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV9(): Promise<void> {
    // Builder resume intents gain the upgrade process's identity (pid + host).
    // The builder wrapper now waits indefinitely for an upgrade to finish, and
    // uses these to detect a DEAD upgrade instead of giving up on a timer.
    // Nullable: intents written by an older lazy simply keep waiting.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE builder_resume_intents ADD COLUMN IF NOT EXISTS upgrade_pid INTEGER`;
      await sql`ALTER TABLE builder_resume_intents ADD COLUMN IF NOT EXISTS upgrade_host TEXT`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (9, '8')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV10(): Promise<void> {
    // The DERIVED memory compact: at most one per project, hence the
    // single-row guard (`id` pinned to TRUE). No history table — a compact is
    // regenerated from the live records, so a superseded one carries no
    // information, and losing it only means injection falls back to the full
    // index.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`
        CREATE TABLE IF NOT EXISTS memory_compact (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
          content TEXT NOT NULL,
          generated_at BIGINT NOT NULL,
          generated_by TEXT NOT NULL,
          method TEXT NOT NULL,
          model TEXT,
          covered JSONB NOT NULL
        )
      `;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (10, '9')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  /**
   * Repair double-encoded JSONB on `turns`. createTurn/updateTurnViolations used to pass
   * a JSON.stringify'd value into these JSONB columns, so postgres.js serialized it a
   * second time: the column held a jsonb *string* scalar and read back as raw text
   * instead of an object, silently corrupting violations, merge conflicts and usage.
   * `#>> '{}'` extracts the inner text of such a scalar, which re-casts to real JSONB.
   * Rows written correctly have jsonb_typeof <> 'string' and are left untouched.
   */
  private async migrateToV11(): Promise<void> {
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      for (const column of ['violations', 'merge_conflicts', 'usage'] as const) {
        await sql`
          UPDATE turns
          SET ${sql(column)} = (${sql(column)} #>> '{}')::jsonb
          WHERE ${sql(column)} IS NOT NULL AND jsonb_typeof(${sql(column)}) = 'string'
        `;
      }
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (11, '10')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV12(): Promise<void> {
    // Two columns the domain types have always required but the Postgres
    // schema never had:
    //   - tasks.pending_sync — a required field of Task, and the target of
    //     clearTaskPendingSync/incrementTaskPendingSync, which until now threw
    //     `column "pending_sync" does not exist` on every call.
    //   - turns.actor — CreateTurnOptions.actor was silently dropped, so
    //     `turn.actor` (read by turn chunking, sync-turn detection, review,
    //     report and show) was always undefined on this backend.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_sync INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS actor TEXT`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (12, '11')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV13(): Promise<void> {
    // Anchored, threaded review comments made against a task's diff in the web
    // review surface, plus the agent's replies.
    //
    // INVARIANT: this is a SEPARATE table from `comments`. Comments feed the
    // daemon's comment auto-react loop (which starts a work turn); a review
    // comment must only ever reach the agent through an explicit, read-only
    // `ask`, or batched into an unblock work turn. Sharing the table would
    // silently kick the agent into coding, once per commented line.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`
        CREATE TABLE IF NOT EXISTS review_comments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          file TEXT NOT NULL,
          line INTEGER NOT NULL,
          side TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          actor TEXT,
          intent TEXT,
          ask_state TEXT,
          ask_error TEXT,
          delivery_state TEXT,
          delivered_turn INTEGER,
          turn_number INTEGER,
          anchor_snippet TEXT,
          withdrawn_at BIGINT
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_review_comments_task ON review_comments(task_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_review_comments_thread ON review_comments(thread_id)`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (13, '12')
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
    agentId?: string,
    actor?: Actor
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

    await this.recordStatusChange(id, 'backlog', now, actor);

    return {
      id,
      goal,
      prompt: '',
      code: code ?? null,
      type: taskType,
      status: 'backlog',
      priority: DEFAULT_TASK_PRIORITY,
      model: null,
      agent_id: resolvedAgentId,
      runner_type: null,
      target,
      branched_from_sha: branchedFromSha ?? null,
      close_reason: null,
      metadata: null,
      tags: [],
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
    // tags is a JSONB array; default to [] for rows predating the column.
    const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
    // pending_sync is required on Task; rows predating the column read as
    // undefined, which would make `task.pending_sync > 0` silently false.
    const pendingSync = typeof row.pending_sync === 'number' ? row.pending_sync : 0;
    return { ...rest, metadata, target, tags, pending_sync: pendingSync } as unknown as Task;
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

    // Same shape validateCode() accepts — dots included, or codes like
    // 'release-v0.5' would skip code lookup entirely and fall to prefix matching.
    if (input.match(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)) {
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
      ${options.queuedOnly ? this.sql`AND status = 'queued'` : this.sql``}
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

  async updateTaskRunnerType(taskId: string, runnerType: RunnerType | null): Promise<void> {
    await this.sql`UPDATE tasks SET runner_type = ${runnerType} WHERE id = ${taskId}`;
  }

  async updateTaskType(taskId: string, type: string): Promise<void> {
    await this.sql`UPDATE tasks SET type = ${type} WHERE id = ${taskId}`;
  }

  async updateTaskPriority(taskId: string, priority: string): Promise<void> {
    await this.sql`UPDATE tasks SET priority = ${priority} WHERE id = ${taskId}`;
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
      runner_type: null,
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

  /**
   * Map a raw `sessions` row into the domain Session. The column is still
   * named `claude_session_id` (renaming it would need a migration on every
   * deployment), but the domain field has been `agent_session_id` since the
   * agent-agnostic rename — FileStorage rewrites the key on read, and this is
   * the Postgres equivalent. Every `Session` field is required and nullable
   * (`| null`), so there are no optional keys to drop here.
   */
  private rowToSession(row: Record<string, unknown>): Session {
    const { claude_session_id: legacyId, ...rest } = row;
    return {
      ...rest,
      agent_session_id: (rest.agent_session_id as string | null | undefined) ?? (legacyId as string | null | undefined) ?? null,
    } as unknown as Session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const [exact] = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions WHERE id = ${sessionId}`;
    if (exact) return this.rowToSession(exact);

    const prefixMatches = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions WHERE id LIKE ${sessionId + '%'}`;
    return prefixMatches.length === 1 ? this.rowToSession(prefixMatches[0]!) : null;
  }

  async getSessionByTaskId(taskId: string): Promise<Session | null> {
    const [session] = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions WHERE task_id = ${taskId}`;
    return session ? this.rowToSession(session) : null;
  }

  async listSessions(taskId?: string, activeOnly?: boolean): Promise<Session[]> {
    let rows: Record<string, unknown>[];
    if (taskId && activeOnly) {
      rows = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions WHERE task_id = ${taskId} AND ended_at IS NULL`;
    } else if (taskId) {
      rows = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions WHERE task_id = ${taskId} ORDER BY started_at DESC`;
    } else if (activeOnly) {
      rows = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`;
    } else {
      rows = await this.sql<Record<string, unknown>[]>`SELECT * FROM sessions ORDER BY started_at DESC`;
    }
    return rows.map(row => this.rowToSession(row));
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

  async updateSessionRunnerType(sessionId: string, runnerType: RunnerType | null): Promise<void> {
    await this.sql`UPDATE sessions SET runner_type = ${runnerType} WHERE id = ${sessionId}`;
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

    // INVARIANT: a persisted turn ALWAYS has string content. `content` is a NOT
    // NULL column here, so an undefined would fail the insert outright and lose
    // the turn — coerce and warn instead. See src/utils/turn-content.ts.
    const content = normalizeTurnContent(options.content, 'postgres-storage');

    // Store NULL for the default 'work' so the column stays sparse — a
    // future 'comment' or 'hook' variant gets its own string value.
    const storedTurnType = options.turnType && options.turnType !== 'work' ? options.turnType : null;
    // Feedback starts life unconsumed; NULL means "carries no feedback".
    const storedFeedbackDelivery: FeedbackDelivery | null = options.carriesFeedback ? 'pending' : null;
    // merge_conflicts/violations/usage are JSONB: pass the value through sql.json so
    // postgres.js serializes it once. JSON.stringify here would double-serialize — the
    // column ends up holding a jsonb *string* scalar and reads back as raw text, not an
    // object (same trap documented on createConversation below).
    await this.sql`
      INSERT INTO turns (
        id, session_id, sequence, role, content, model, prompt, actor,
        start_sha, end_sha, start_sha_work, end_sha_work,
        merge_conflicts, violations, usage, timestamp,
        check_exit_code, check_output, auto_triggered, turn_type,
        feedback_delivery, model_id, effort, mcp_tools
      )
      VALUES (
        ${id}, ${options.sessionId}, ${options.sequence}, ${options.role}, ${content},
        ${options.model ?? null}, ${options.prompt ?? null}, ${options.actor ?? null},
        ${options.startSha ?? null}, ${options.endSha ?? null},
        ${options.startShaWork ?? null}, ${options.endShaWork ?? null},
        ${options.mergeConflicts ? this.sql.json(options.mergeConflicts as any) : null},
        ${options.violations ? this.sql.json(options.violations as any) : null},
        ${options.usage ? this.sql.json(options.usage as any) : null}, ${now},
        ${options.checkExitCode ?? null}, ${options.checkOutput ?? null},
        ${options.autoTriggered ?? false}, ${storedTurnType},
        ${storedFeedbackDelivery}, ${options.modelId ?? null}, ${options.effort ?? null},
        ${options.mcpTools ?? null}
      )
    `;

    // Shape-identical to what getSessionTurns() returns for this row (and to
    // FileStorage.createTurn): optional fields are omitted, not set to
    // undefined — `'model' in turn` must agree with the reader.
    return {
      id,
      session_id: options.sessionId,
      sequence: options.sequence,
      role: options.role,
      content,
      start_sha: options.startSha ?? null,
      end_sha: options.endSha ?? null,
      start_sha_work: options.startShaWork ?? null,
      end_sha_work: options.endShaWork ?? null,
      usage: options.usage ?? null,
      timestamp: now,
      ...(options.mergeConflicts ? { merge_conflicts: options.mergeConflicts } : {}),
      ...(options.violations ? { violations: options.violations } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.checkExitCode !== undefined ? { check_exit_code: options.checkExitCode } : {}),
      ...(options.checkOutput !== undefined ? { check_output: options.checkOutput } : {}),
      ...(options.autoTriggered ? { auto_triggered: true } : {}),
      ...(storedTurnType ? { turn_type: storedTurnType } : {}),
      ...(storedFeedbackDelivery ? { feedback_delivery: storedFeedbackDelivery } : {}),
      ...(options.modelId ? { model_id: options.modelId } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.mcpTools ? { mcp_tools: options.mcpTools } : {}),
    };
  }

  /**
   * Map a raw `turns` row into the domain Turn: SQL NULLs on optional columns
   * become absent keys (see `dropNullOptionals`), and the JSONB columns come
   * back as structured values rather than JSON text.
   */
  private rowToTurn(row: Record<string, unknown>): Turn {
    // Legacy rows: merge_conflicts/violations/usage used to be written with
    // JSON.stringify() into a JSONB column, which postgres.js stores as a JSON
    // *string* — so the reader got '[{"file":…}]' where every other backend
    // returns an array. New writes use sql.json (see createTurn); parse the
    // old rows on read so both shapes converge.
    for (const key of TURN_JSON_COLUMNS) {
      if (typeof row[key] === 'string') {
        try {
          row[key] = JSON.parse(row[key] as string);
        } catch (err) {
          throw new Error(
            `turn ${String(row.id)}: column "${key}" holds text that is not valid JSON: ${(err as Error).message}`
          );
        }
      }
    }
    // auto_triggered is only meaningful when true. The column defaults to
    // FALSE (and is NULL on rows predating it), where FileStorage omits the
    // key entirely — consumers read it as a truthy flag.
    if (row.auto_triggered !== true) delete row.auto_triggered;
    return dropNullOptionals<Turn>(row, TURN_OPTIONAL_COLUMNS);
  }

  async getSessionTurns(sessionId: string): Promise<Turn[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM turns WHERE session_id = ${sessionId} ORDER BY sequence ASC
    `;
    return rows.map(row => this.rowToTurn(row));
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
      UPDATE turns SET violations = ${this.sql.json(violations as any)}
      WHERE id = ${turnId}
    `;
  }

  async markFeedbackConsumed(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE turns SET feedback_delivery = 'consumed'
      WHERE session_id = ${sessionId} AND feedback_delivery = 'pending'
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
    content = normalizeRecordContent(content, 'postgres-storage', 'createComment', 'Comment.content');

    await this.sql`
      INSERT INTO comments (id, task_id, content, created_at, actor, source)
      VALUES (${id}, ${taskId}, ${content}, ${now}, ${actor ?? null}, ${source ?? null})
    `;

    return {
      id, task_id: taskId, content, created_at: now,
      ...(actor ? { actor } : {}),
      ...(source ? { source } : {}),
    };
  }

  async getTaskComments(taskId: string): Promise<Comment[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM comments WHERE task_id = ${taskId} ORDER BY created_at ASC
    `;
    // Legacy rows can carry a NULL/absent content (see repairRecordContents).
    return repairRecordContents(
      rows.map(row => dropNullOptionals<Comment>(row, COMMENT_OPTIONAL_COLUMNS)),
      'comment',
      'postgres-storage',
    );
  }

  async appendJournalEntry(taskId: string, content: string, actor?: Actor): Promise<JournalEntry> {
    const id = randomUUID();
    const now = Date.now();
    content = normalizeRecordContent(content, 'postgres-storage', 'appendJournalEntry', 'JournalEntry.content');

    await this.sql`
      INSERT INTO journal_entries (id, task_id, content, created_at, actor)
      VALUES (${id}, ${taskId}, ${content}, ${now}, ${actor ?? null})
    `;

    return { id, task_id: taskId, content, created_at: now, ...(actor ? { actor } : {}) };
  }

  async getTaskJournal(taskId: string): Promise<JournalEntry[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM journal_entries WHERE task_id = ${taskId} ORDER BY created_at ASC
    `;
    return repairRecordContents(
      rows.map(row => dropNullOptionals<JournalEntry>(row, JOURNAL_OPTIONAL_COLUMNS)),
      'journal',
      'postgres-storage',
    );
  }

  async createFollowUp(taskId: string, content: string, sessionId?: string | null): Promise<FollowUp> {
    const id = randomUUID();
    const now = Date.now();
    content = normalizeRecordContent(content, 'postgres-storage', 'createFollowUp', 'FollowUp.content');

    // INVARIANT: a plain INSERT — no status change, no signal, no auto-react.
    await this.sql`
      INSERT INTO follow_ups (id, task_id, content, created_at, session_id)
      VALUES (${id}, ${taskId}, ${content}, ${now}, ${sessionId ?? null})
    `;

    return { id, task_id: taskId, content, created_at: now, ...(sessionId ? { session_id: sessionId } : {}) };
  }

  async getTaskFollowUps(taskId: string): Promise<FollowUp[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM follow_ups WHERE task_id = ${taskId} ORDER BY created_at ASC
    `;
    return repairRecordContents(
      rows.map(row => dropNullOptionals<FollowUp>(row, FOLLOW_UP_OPTIONAL_COLUMNS)),
      'follow-up',
      'postgres-storage',
    );
  }

  async listHunkApprovals(taskId: string): Promise<HunkApproval[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM hunk_approvals WHERE task_id = ${taskId} ORDER BY approved_at ASC
    `;
    return rows.map(row => dropNullOptionals<HunkApproval>(row, HUNK_APPROVAL_OPTIONAL_COLUMNS));
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
    const inserted = await this.sql<Record<string, unknown>[]>`
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
    if (inserted.length > 0) return dropNullOptionals<HunkApproval>(inserted[0]!, HUNK_APPROVAL_OPTIONAL_COLUMNS);
    const [existing] = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM hunk_approvals WHERE task_id = ${taskId} AND hunk_hash = ${hunkHash}
    `;
    return dropNullOptionals<HunkApproval>(existing!, HUNK_APPROVAL_OPTIONAL_COLUMNS);
  }

  // --- Review Comments ---

  async createReviewComment(taskId: string, input: ReviewCommentInput): Promise<ReviewComment> {
    const id = randomUUID();
    // A root comment is its own thread; a reply carries the root's id.
    const threadId = input.threadId ?? id;
    const now = Date.now();
    const [row] = await this.sql<ReviewComment[]>`
      INSERT INTO review_comments (
        id, task_id, thread_id, file, line, side, role, content, created_at,
        actor, intent, ask_state, ask_error, delivery_state, delivered_turn,
        turn_number, anchor_snippet
      )
      VALUES (
        ${id}, ${taskId}, ${threadId}, ${input.file}, ${input.line}, ${input.side},
        ${input.role}, ${input.content}, ${now},
        ${input.actor ?? null}, ${input.intent ?? null}, ${input.askState ?? null}, ${null},
        ${input.deliveryState ?? null}, ${null},
        ${input.turnNumber ?? null}, ${input.anchorSnippet ?? null}
      )
      RETURNING *
    `;
    return row;
  }

  async getTaskReviewComments(taskId: string): Promise<ReviewComment[]> {
    return this.sql<ReviewComment[]>`
      SELECT * FROM review_comments WHERE task_id = ${taskId} ORDER BY created_at ASC
    `;
  }

  async updateReviewComment(
    taskId: string,
    commentId: string,
    update: ReviewCommentUpdate,
  ): Promise<ReviewComment> {
    // Only delivery bookkeeping and withdrawal are mutable — the human's words,
    // the anchor, and the intent are immutable once written. COALESCE leaves
    // untouched fields alone; ask_error is explicitly clearable by passing null.
    // withdrawn_at is COALESCEd like the rest, which also makes it one-way.
    const [row] = await this.sql<ReviewComment[]>`
      UPDATE review_comments SET
        withdrawn_at = COALESCE(${update.withdrawnAt ?? null}, withdrawn_at),
        ask_state = COALESCE(${update.askState ?? null}, ask_state),
        delivery_state = COALESCE(${update.deliveryState ?? null}, delivery_state),
        delivered_turn = COALESCE(${update.deliveredTurn ?? null}, delivered_turn),
        turn_number = COALESCE(${update.turnNumber ?? null}, turn_number),
        ask_error = ${update.askError === undefined ? this.sql`ask_error` : update.askError}
      WHERE id = ${commentId} AND task_id = ${taskId}
      RETURNING *
    `;
    if (!row) {
      throw new Error(`Review comment not found: ${commentId} (task ${taskId})`);
    }
    return row;
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

  async deleteConversation(sessionId: string): Promise<boolean> {
    // RETURNING makes the "did it exist?" answer part of the same statement —
    // no pre-check, so two concurrent purges cannot both claim the same row.
    const deleted = await this.sql<{ session_id: string }[]>`
      DELETE FROM conversations WHERE session_id = ${sessionId} RETURNING session_id
    `;
    return deleted.length > 0;
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

  private async migrateToV14(): Promise<void> {
    // Builder resume intents gain WHY the builder was stopped. An intent
    // written by the daemon while reaping the previous generation's children
    // must NOT make the wrapper wait for a daemon restart — that restart has
    // already happened by then, so the wait would never end. Nullable: an
    // intent written by an older lazy is an upgrade intent, which is exactly
    // the pre-existing behavior.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE builder_resume_intents ADD COLUMN IF NOT EXISTS reason TEXT`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (14, '13')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  private async migrateToV15(): Promise<void> {
    // A reviewer can retract their own review comment before it reaches the
    // agent. Recorded as a timestamp rather than a delete, so the record and
    // its thread survive; nullable, because every existing comment is simply
    // not withdrawn. The V13 CREATE TABLE above carries the column too, for
    // databases created fresh after this point.
    await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      await sql`ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS withdrawn_at BIGINT`;
      await sql`
        INSERT INTO schema_version (version, migrated_from)
        VALUES (15, '14')
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  // --- Builder Resume Intents (durable upgrade↔builder handshake) ---

  async saveBuilderResumeIntent(intent: BuilderResumeIntent): Promise<void> {
    await this.sql`
      INSERT INTO builder_resume_intents (builder_id, project_root, session_id, created_at, upgrade_pid, upgrade_host, reason)
      VALUES (
        ${intent.builderId}, ${intent.projectRoot}, ${intent.sessionId ?? null}, ${intent.createdAt},
        ${intent.upgradePid ?? null}, ${intent.upgradeHost ?? null}, ${intent.reason ?? null}
      )
      ON CONFLICT (builder_id) DO UPDATE SET
        project_root = EXCLUDED.project_root,
        session_id = EXCLUDED.session_id,
        created_at = EXCLUDED.created_at,
        upgrade_pid = EXCLUDED.upgrade_pid,
        upgrade_host = EXCLUDED.upgrade_host,
        reason = EXCLUDED.reason
    `;
  }

  async takeBuilderResumeIntent(builderId: string): Promise<BuilderResumeIntent | null> {
    // INVARIANT: consume+clear atomically. DELETE ... RETURNING does both in a
    // single statement so an intent is acted on at most once even under
    // concurrent takers.
    const [row] = await this.sql<BuilderResumeIntent[]>`
      DELETE FROM builder_resume_intents WHERE builder_id = ${builderId}
      RETURNING
        builder_id AS "builderId",
        project_root AS "projectRoot",
        session_id AS "sessionId",
        created_at AS "createdAt",
        upgrade_pid AS "upgradePid",
        upgrade_host AS "upgradeHost",
        reason AS "reason"
    `;
    if (!row) return null;
    // Normalize SQL NULLs to absent optional fields.
    return dropNullOptionals<BuilderResumeIntent>(
      row as unknown as Record<string, unknown>,
      BUILDER_RESUME_INTENT_OPTIONAL_COLUMNS
    );
  }

  async listBuilderResumeIntents(projectRoot?: string): Promise<BuilderResumeIntent[]> {
    const rows = projectRoot
      ? await this.sql<BuilderResumeIntent[]>`
          SELECT
            builder_id AS "builderId",
            project_root AS "projectRoot",
            session_id AS "sessionId",
            created_at AS "createdAt",
            upgrade_pid AS "upgradePid",
            upgrade_host AS "upgradeHost",
            reason AS "reason"
          FROM builder_resume_intents WHERE project_root = ${projectRoot} ORDER BY created_at DESC
        `
      : await this.sql<BuilderResumeIntent[]>`
          SELECT
            builder_id AS "builderId",
            project_root AS "projectRoot",
            session_id AS "sessionId",
            created_at AS "createdAt",
            upgrade_pid AS "upgradePid",
            upgrade_host AS "upgradeHost",
            reason AS "reason"
          FROM builder_resume_intents ORDER BY created_at DESC
        `;
    return rows.map(row =>
      dropNullOptionals<BuilderResumeIntent>(
        row as unknown as Record<string, unknown>,
        BUILDER_RESUME_INTENT_OPTIONAL_COLUMNS
      )
    );
  }

  private async recordStatusChange(taskId: string, status: string, timestamp: number, actor?: Actor): Promise<void> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO status_changelog (id, task_id, status, timestamp, actor)
      VALUES (${id}, ${taskId}, ${status}, ${timestamp}, ${actor ?? null})
    `;
  }

  async getStatusHistory(taskId: string): Promise<StatusChange[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT status, timestamp, actor FROM status_changelog WHERE task_id = ${taskId} ORDER BY timestamp ASC
    `;
    return rows.map(row => dropNullOptionals<StatusChange>(row, ACTOR_ONLY_OPTIONAL_COLUMNS));
  }

  // --- Tags ---

  private async recordTagEvent(taskId: string, event: TagEvent): Promise<void> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO tag_history (id, task_id, tag, action, timestamp, actor)
      VALUES (${id}, ${taskId}, ${event.tag}, ${event.action}, ${event.timestamp}, ${event.actor ?? null})
    `;
  }

  async addTaskTag(taskId: string, tag: string, actor?: Actor): Promise<Task> {
    const normalized = normalizeTag(tag);
    if (!normalized) {
      throw new Error(`Invalid tag '${tag}': normalizes to an empty string.`);
    }
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Idempotent: already tagged → no state change, no history event.
    if (task.tags.includes(normalized)) {
      return task;
    }

    const newTags = [...task.tags, normalized];
    await this.sql`UPDATE tasks SET tags = ${this.sql.json(newTags)} WHERE id = ${task.id}`;
    await this.recordTagEvent(task.id, {
      tag: normalized,
      action: 'tag',
      timestamp: Date.now(),
      ...(actor ? { actor } : {}),
    });
    return { ...task, tags: newTags };
  }

  async removeTaskTag(taskId: string, tag: string, actor?: Actor): Promise<Task> {
    const normalized = normalizeTag(tag);
    if (!normalized) {
      throw new Error(`Invalid tag '${tag}': normalizes to an empty string.`);
    }
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Idempotent: not tagged → no state change, no history event.
    if (!task.tags.includes(normalized)) {
      return task;
    }

    const newTags = task.tags.filter(t => t !== normalized);
    await this.sql`UPDATE tasks SET tags = ${this.sql.json(newTags)} WHERE id = ${task.id}`;
    // Append-only: untag records an 'untag' event; it never erases the 'tag' event.
    await this.recordTagEvent(task.id, {
      tag: normalized,
      action: 'untag',
      timestamp: Date.now(),
      ...(actor ? { actor } : {}),
    });
    return { ...task, tags: newTags };
  }

  async getTagHistory(taskId: string): Promise<TagEvent[]> {
    const task = await this.getTask(taskId);
    if (!task) return [];
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT tag, action, timestamp, actor FROM tag_history WHERE task_id = ${task.id} ORDER BY timestamp ASC
    `;
    return rows.map(row => dropNullOptionals<TagEvent>(row, ACTOR_ONLY_OPTIONAL_COLUMNS));
  }

  // --- Memory (lazy-owned shared knowledge) ---

  /** Row → MemoryRecord: SQL NULLs become absent optional fields. */
  private rowToMemory(row: Record<string, unknown>): MemoryRecord {
    return {
      name: row.name as string,
      description: row.description as string,
      type: row.type as MemoryRecord['type'],
      body: row.body as string,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      created_by: row.created_by as Actor,
      updated_by: row.updated_by as Actor,
      revision: row.revision as number,
      ...(row.deleted_at != null ? { deleted_at: row.deleted_at as number } : {}),
      ...(row.deleted_by != null ? { deleted_by: row.deleted_by as Actor } : {}),
    };
  }

  async saveMemory(input: MemoryWriteInput, actor: Actor): Promise<MemoryRecord> {
    const now = Date.now();

    // Upsert + history append in one transaction so a record can never exist
    // without the event that produced it (and vice versa). Saving a tombstoned
    // name revives it (deleted_at/deleted_by cleared) — the delete event stays
    // in history, which is append-only.
    const record = await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      const [existing] = await sql<Record<string, unknown>[]>`
        SELECT * FROM memories WHERE name = ${input.name} FOR UPDATE
      `;
      const revision = existing ? (existing.revision as number) + 1 : 1;
      const createdAt = existing ? (existing.created_at as number) : now;
      const createdBy = existing ? (existing.created_by as string) : actor;

      const [row] = await sql<Record<string, unknown>[]>`
        INSERT INTO memories (name, description, type, body, created_at, updated_at, created_by, updated_by, revision, deleted_at, deleted_by)
        VALUES (${input.name}, ${input.description}, ${input.type}, ${input.body}, ${createdAt}, ${now}, ${createdBy}, ${actor}, ${revision}, NULL, NULL)
        ON CONFLICT (name) DO UPDATE SET
          description = EXCLUDED.description,
          type = EXCLUDED.type,
          body = EXCLUDED.body,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by,
          revision = EXCLUDED.revision,
          deleted_at = NULL,
          deleted_by = NULL
        RETURNING *
      `;

      await sql`
        INSERT INTO memory_history (id, name, action, actor, timestamp, revision, description, type, body)
        VALUES (${randomUUID()}, ${input.name}, ${existing ? 'update' : 'create'}, ${actor}, ${now}, ${revision}, ${input.description}, ${input.type}, ${input.body})
      `;

      return row;
    });

    return this.rowToMemory(record as Record<string, unknown>);
  }

  async getMemory(name: string): Promise<MemoryRecord | null> {
    const [row] = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM memories WHERE name = ${name} AND deleted_at IS NULL
    `;
    return row ? this.rowToMemory(row) : null;
  }

  async listMemories(options?: { includeDeleted?: boolean }): Promise<MemoryRecord[]> {
    const rows = options?.includeDeleted
      ? await this.sql<Record<string, unknown>[]>`SELECT * FROM memories ORDER BY updated_at DESC`
      : await this.sql<Record<string, unknown>[]>`SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC`;
    return rows.map(r => this.rowToMemory(r));
  }

  async deleteMemory(name: string, actor: Actor): Promise<MemoryRecord | null> {
    const now = Date.now();
    const record = await this.sql.begin(async (txSql) => {
      const sql = txSql as unknown as ReturnType<typeof postgres>;
      const [row] = await sql<Record<string, unknown>[]>`
        UPDATE memories SET deleted_at = ${now}, deleted_by = ${actor}
        WHERE name = ${name} AND deleted_at IS NULL
        RETURNING *
      `;
      if (!row) return null; // absent or already tombstoned — idempotent

      await sql`
        INSERT INTO memory_history (id, name, action, actor, timestamp, revision)
        VALUES (${randomUUID()}, ${name}, 'delete', ${actor}, ${now}, ${row.revision as number})
      `;
      return row;
    });

    return record ? this.rowToMemory(record as Record<string, unknown>) : null;
  }

  async getMemoryHistory(name?: string): Promise<MemoryEvent[]> {
    const rows = name
      ? await this.sql<Record<string, unknown>[]>`SELECT * FROM memory_history WHERE name = ${name} ORDER BY timestamp ASC`
      : await this.sql<Record<string, unknown>[]>`SELECT * FROM memory_history ORDER BY timestamp ASC`;
    return rows.map(row => ({
      id: row.id as string,
      name: row.name as string,
      action: row.action as MemoryEvent['action'],
      actor: row.actor as Actor,
      timestamp: row.timestamp as number,
      revision: row.revision as number,
      ...(row.description != null ? { description: row.description as string } : {}),
      ...(row.type != null ? { type: row.type as MemoryRecord['type'] } : {}),
      ...(row.body != null ? { body: row.body as string } : {}),
    }));
  }

  // --- Memory compact (derived; single row, overwritten on every recompact) ---

  async saveMemoryCompact(input: MemoryCompactInput, actor: Actor): Promise<MemoryCompact> {
    const now = Date.now();
    await this.sql`
      INSERT INTO memory_compact (id, content, generated_at, generated_by, method, model, covered)
      VALUES (TRUE, ${input.content}, ${now}, ${actor}, ${input.method}, ${input.model ?? null},
              ${this.sql.json(input.covered as any)})
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        generated_at = EXCLUDED.generated_at,
        generated_by = EXCLUDED.generated_by,
        method = EXCLUDED.method,
        model = EXCLUDED.model,
        covered = EXCLUDED.covered
    `;
    return {
      content: input.content,
      generated_at: now,
      generated_by: actor,
      method: input.method,
      ...(input.model ? { model: input.model } : {}),
      covered: input.covered,
    };
  }

  async getMemoryCompact(): Promise<MemoryCompact | null> {
    const [row] = await this.sql<Record<string, unknown>[]>`SELECT * FROM memory_compact WHERE id = TRUE`;
    if (!row) return null;
    return {
      content: row.content as string,
      generated_at: Number(row.generated_at),
      generated_by: row.generated_by as Actor,
      method: row.method as MemoryCompact['method'],
      ...(row.model != null ? { model: row.model as string } : {}),
      covered: (row.covered ?? []) as MemoryCompact['covered'],
    };
  }

  async clearMemoryCompact(): Promise<boolean> {
    const rows = await this.sql`DELETE FROM memory_compact WHERE id = TRUE RETURNING id`;
    return rows.length > 0;
  }

  async search(query: string): Promise<SearchResult[]> {
    const pattern = `%${query}%`;

    // Run all queries in parallel since they're independent
    const [taskRows, prompts, turns, commits, comments, followUps, conversations, memories] = await Promise.all([
      this.sql`SELECT * FROM tasks WHERE goal ILIKE ${pattern}`,

      this.sql<(TaskPromptVersion & { task_goal: string; task_code: string | null })[]>`
        SELECT ph.*, t.goal as task_goal, t.code as task_code
        FROM prompt_history ph
        INNER JOIN tasks t ON ph.task_id = t.id
        WHERE ph.content ILIKE ${pattern}
      `,

      // The entity_index columns below carry the hit's position in the list
      // `show` pages over, so a hit is directly addressable. Each is ranked in
      // an inner query and filtered OUTSIDE it: a window function is evaluated
      // AFTER WHERE, so ranking in the same query would number only the
      // MATCHING rows and report a position that does not exist.
      this.sql<(Turn & { task_id: string; task_goal: string; task_code: string | null; entity_index: number })[]>`
        SELECT * FROM (
          SELECT t.*, s.task_id, tasks.goal as task_goal, tasks.code as task_code,
                 (ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.sequence ASC))::int - 1 AS entity_index
          FROM turns t
          INNER JOIN sessions s ON t.session_id = s.id
          INNER JOIN tasks ON s.task_id = tasks.id
        ) ranked
        WHERE ranked.content ILIKE ${pattern}
      `,

      this.sql<(Commit & { task_id: string; task_goal: string; task_code: string | null; entity_index: number })[]>`
        SELECT * FROM (
          SELECT c.*, s.task_id, tasks.goal as task_goal, tasks.code as task_code,
                 (ROW_NUMBER() OVER (PARTITION BY c.session_id ORDER BY c.timestamp ASC))::int - 1 AS entity_index
          FROM commits c
          INNER JOIN sessions s ON c.session_id = s.id
          INNER JOIN tasks ON s.task_id = tasks.id
        ) ranked
        WHERE ranked.message ILIKE ${pattern}
      `,

      this.sql<(Comment & { task_goal: string; task_code: string | null; entity_index: number })[]>`
        SELECT * FROM (
          SELECT c.*, t.goal as task_goal, t.code as task_code,
                 (ROW_NUMBER() OVER (PARTITION BY c.task_id ORDER BY c.created_at ASC))::int - 1 AS entity_index
          FROM comments c
          INNER JOIN tasks t ON c.task_id = t.id
        ) ranked
        WHERE ranked.content ILIKE ${pattern}
      `,

      this.sql<(FollowUp & { task_goal: string; task_code: string | null; entity_index: number })[]>`
        SELECT * FROM (
          SELECT f.*, t.goal as task_goal, t.code as task_code,
                 (ROW_NUMBER() OVER (PARTITION BY f.task_id ORDER BY f.created_at ASC))::int - 1 AS entity_index
          FROM follow_ups f
          INNER JOIN tasks t ON f.task_id = t.id
        ) ranked
        WHERE ranked.content ILIKE ${pattern}
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

      // Live memory records only — a tombstoned record is no longer part of
      // the project's knowledge (its content stays in memory_history).
      this.sql<Record<string, unknown>[]>`
        SELECT * FROM memories
        WHERE deleted_at IS NULL
          AND (name ILIKE ${pattern} OR description ILIKE ${pattern} OR body ILIKE ${pattern})
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
        content: turnText(turn),
        match_context: turnText(turn).slice(0, 200),
        entity_index: turn.entity_index,
        turn_sequence: turn.sequence,
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
        entity_index: commit.entity_index,
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
        entity_index: comment.entity_index,
      });
    }

    for (const followUp of followUps) {
      results.push({
        entity_type: 'followup',
        entity_id: followUp.id,
        task_id: followUp.task_id,
        task_code: followUp.task_code,
        task_goal: followUp.task_goal,
        content: followUp.content,
        match_context: followUp.content.slice(0, 200),
        entity_index: followUp.entity_index,
      });
    }

    for (const row of memories) {
      const memory = this.rowToMemory(row);
      results.push({
        entity_type: 'memory',
        entity_id: memory.name,
        task_id: memory.name,
        task_code: null,
        task_goal: `memory: ${memory.name}`,
        content: memory.body,
        match_context: memory.description,
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

  // --- Tracing ---
  // Spans are a local operational concern (daemon debugging), not shared
  // domain state, so they persist as JSONL under the storage path rather than
  // in Postgres — same format and location as the file backend.

  async appendTraceSpans(spans: SpanRecord[]): Promise<void> {
    await appendSpansJsonl(this.getStoragePath(), spans);
  }

  async readTraceSpans(sinceMs?: number): Promise<SpanRecord[]> {
    return readSpansJsonl(this.getStoragePath(), sinceMs);
  }

  // --- Wait intervals ---
  // JSONL under the storage path, exactly like trace spans: append-only
  // observability data with no relational consumers, so it does not earn a
  // table (or a migration) and stays byte-identical across backends.

  async recordWaitStart(start: WaitIntervalStart): Promise<void> {
    await appendWaitStartJsonl(this.getStoragePath(), start);
  }

  async recordWaitEnd(id: string, endedAt: string, outcome: WaitOutcome): Promise<void> {
    await appendWaitEndJsonl(this.getStoragePath(), id, endedAt, outcome);
  }

  async readWaitIntervals(filter?: WaitIntervalFilter): Promise<WaitInterval[]> {
    return readWaitIntervalsJsonl(this.getStoragePath(), filter);
  }
}
