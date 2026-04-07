/**
 * Durable signal queue for task events — SQLite-backed.
 *
 * Signals are lightweight notifications that "something changed" for a task.
 * They are persisted in a SQLite database so they survive daemon restarts,
 * supervisor restarts, and concurrent arrivals.
 *
 * Design: pull-based model. The actual state changes (comments, CI results,
 * upstream commits) are already durable in storage or git. Signals are just
 * notifications that trigger the supervisor to collect those changes.
 * The signal row contains a summary for prompt injection, but the full
 * details are always retrieved from durable storage at delivery time.
 *
 * Signal lifecycle:
 *   1. External change detected (auto-react, catchup) → emitSignal() inserts row
 *   2. Task becomes blocked → auto-deliver checks for pending signals
 *   3. Signals collected → delivered to task, consumed (DELETEd)
 *
 * Storage: <project>/.lazy/signals.db (per-project SQLite file)
 *   This is a LOCAL transient store — never committed to git, never shared.
 *   It is separate from the lazy store (FileStorage/PostgresStorage) which
 *   holds tasks, sessions, turns, etc. Each project has its own signals DB
 *   co-located with its .lazy/ directory.
 *
 * No per-type deduplication on the write side — it's safer to accept
 * duplicates than to lose signals. Deduplication happens at consumption
 * time when building the summary (e.g., multiple upstream_change signals
 * collapse to showing only the latest).
 */

import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

/**
 * Signal types that can be emitted for a task.
 *
 * Each type corresponds to an external event that may require the agent's
 * attention at the next turn boundary:
 *
 * - upstream_change: Parent branch has new commits that should be merged
 * - ci_result: CI check completed (pass or fail) with details
 * - comment: New comment/note added to the task by a human or system
 * - feedback: User feedback arrived (e.g., from a review or external tool)
 * - child_completed: A child task completed its turn (blocked/conflict)
 * - child_failed: A child task failed (interrupted)
 */
export type SignalType =
  | 'upstream_change'
  | 'ci_result'
  | 'comment'
  | 'feedback'
  | 'child_completed'
  | 'child_failed';

/**
 * A durable signal stored in SQLite.
 *
 * task_id is optional in the interface because buildSignalSummary() accepts
 * signals constructed without it (e.g., in tests). When read from the database,
 * task_id is always present.
 */
export interface TaskSignal {
  /** Unique signal ID */
  id: string;
  /** Task this signal belongs to (always set when read from DB) */
  task_id?: string;
  /** Signal type — determines how the agent should react */
  type: SignalType;
  /** When the signal was created (ISO 8601) */
  created_at: string;
  /** Human-readable summary for prompt injection */
  summary: string;
  /** Optional structured details (type-specific payload) */
  details?: Record<string, unknown>;
}

/** Raw row shape from SQLite (details stored as JSON text). */
interface SignalRow {
  id: string;
  task_id: string;
  type: string;
  created_at: string;
  summary: string;
  details_json: string | null;
}

/** Per-project root set by initSignalDb(). */
let _projectRoot: string | null = null;

/**
 * Initialize the signal database for a specific project.
 * Must be called before any signal operations. The daemon calls this
 * at startup with its project root.
 */
export function initSignalDb(projectRoot: string): void {
  _projectRoot = projectRoot;
}

/**
 * Get the path to the signals database.
 * Uses the per-project .lazy/ directory. Override with LAZY_PROTOCOL_BASE for testing.
 */
function signalsDbPath(): string {
  if (process.env.LAZY_PROTOCOL_BASE) {
    return join(process.env.LAZY_PROTOCOL_BASE, 'signals.db');
  }
  if (!_projectRoot) {
    throw new Error('Signal DB not initialized — call initSignalDb(projectRoot) first');
  }
  return join(_projectRoot, '.lazy', 'signals.db');
}

/** Singleton database handle — lazily opened, shared across calls. */
let _db: Database | null = null;
/** Track the path the singleton was opened for, so we reopen if it changes. */
let _dbPath: string | null = null;

/**
 * Get or create the SQLite database connection.
 *
 * The database is created lazily on first access. WAL mode is enabled
 * for concurrent read/write performance. The schema is auto-created
 * if the table doesn't exist (no migration needed — single table).
 *
 * If the project root or LAZY_PROTOCOL_BASE changes (e.g., between
 * test runs), the old connection is closed and a new one opened.
 */
function getDb(): Database {
  const dbPath = signalsDbPath();
  if (_db && _dbPath === dbPath) return _db;

  // Path changed — close the old connection
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }

  mkdirSync(join(dbPath, '..'), { recursive: true });

  const db = new Database(dbPath);

  // WAL mode for concurrent access (daemon + supervisor)
  db.run('PRAGMA journal_mode = WAL');
  // Busy timeout — wait up to 5s if another process holds the lock
  db.run('PRAGMA busy_timeout = 5000');

  // Create table if not exists — no migration needed.
  // rowid is implicit in SQLite and preserves insertion order.
  db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_signals_task ON signals(task_id)
  `);

  _db = db;
  _dbPath = dbPath;
  return db;
}

/**
 * Close the database connection. Called during daemon shutdown or test cleanup.
 */
export function closeSignalDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

/**
 * Reset the database connection (for testing — forces re-open on next access).
 */
export function resetSignalDb(): void {
  closeSignalDb();
  _projectRoot = null;
}

function rowToSignal(row: SignalRow): TaskSignal {
  const signal: TaskSignal = {
    id: row.id,
    task_id: row.task_id,
    type: row.type as SignalType,
    created_at: row.created_at,
    summary: row.summary,
  };
  if (row.details_json) {
    try {
      signal.details = JSON.parse(row.details_json);
    } catch {
      // Malformed JSON in details — skip it rather than losing the signal
    }
  }
  return signal;
}

/**
 * Emit a durable signal for a task.
 *
 * Inserts a signal row into SQLite. The signal survives daemon restarts
 * because it's in a database, not in-memory state.
 *
 * No deduplication on the write side — multiple signals of the same type
 * are preserved. Deduplication happens at consumption time.
 */
export function emitSignal(
  taskId: string,
  signal: Omit<TaskSignal, 'id' | 'task_id' | 'created_at'>,
): TaskSignal {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const detailsJson = signal.details ? JSON.stringify(signal.details) : null;

  db.run(
    'INSERT INTO signals (id, task_id, type, created_at, summary, details_json) VALUES (?, ?, ?, ?, ?, ?)',
    [id, taskId, signal.type, now, signal.summary, detailsJson],
  );

  return {
    id,
    task_id: taskId,
    type: signal.type as SignalType,
    created_at: now,
    summary: signal.summary,
    details: signal.details,
  };
}

/**
 * Read all pending signals for a task, sorted by creation time (oldest first).
 *
 * Returns an empty array if no signals are pending.
 */
export function readSignals(taskId: string): TaskSignal[] {
  const db = getDb();
  const rows = db.query(
    'SELECT id, task_id, type, created_at, summary, details_json FROM signals WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
  ).all(taskId) as SignalRow[];

  return rows.map(rowToSignal);
}

/**
 * Check if a task has any pending signals without reading them all.
 */
export function hasSignals(taskId: string): boolean {
  const db = getDb();
  const row = db.query(
    'SELECT 1 FROM signals WHERE task_id = ? LIMIT 1',
  ).get(taskId);
  return row !== null;
}

/**
 * Consume (delete) all pending signals for a task.
 *
 * Called after signals have been delivered to a task.
 * Uses a single DELETE statement — atomic by default in SQLite.
 */
export function consumeSignals(taskId: string): void {
  const db = getDb();
  db.run('DELETE FROM signals WHERE task_id = ?', [taskId]);
}

/**
 * Consume specific signals by ID within a transaction.
 *
 * More targeted than consumeSignals() — only removes signals that
 * were actually delivered. Signals that arrived during delivery
 * are preserved for the next cycle.
 *
 * The deletion is atomic — either all specified signals are consumed
 * or none are (SQLite transaction).
 */
export function consumeSignalsById(taskId: string, signalIds: string[]): void {
  if (signalIds.length === 0) return;
  const db = getDb();

  // Use a transaction for atomicity when deleting multiple signals
  const deleteStmt = db.prepare('DELETE FROM signals WHERE id = ? AND task_id = ?');
  db.transaction(() => {
    for (const signalId of signalIds) {
      deleteStmt.run(signalId, taskId);
    }
  })();
}

/**
 * Consume signals by ID atomically with an arbitrary callback.
 *
 * Runs the callback inside the same SQLite transaction as the signal
 * deletion. If the callback throws, neither the deletion nor the
 * callback's side effects (if they used the same db) are committed.
 *
 * Note: only the SQLite operations are transactional. External side
 * effects (file writes, network calls) in the callback are NOT rolled
 * back on failure. Keep callbacks limited to signal-related bookkeeping.
 */
export function consumeSignalsAtomically(
  taskId: string,
  signalIds: string[],
  callback: () => void,
): void {
  if (signalIds.length === 0) {
    callback();
    return;
  }

  const db = getDb();
  const deleteStmt = db.prepare('DELETE FROM signals WHERE id = ? AND task_id = ?');

  db.transaction(() => {
    callback();
    for (const signalId of signalIds) {
      deleteStmt.run(signalId, taskId);
    }
  })();
}

/**
 * Build a combined summary of all pending signals for prompt injection.
 *
 * Groups signals by type and produces a concise, actionable summary
 * that tells the agent what changed since its last turn.
 *
 * Deduplication at consumption time:
 * - upstream_change: show only the latest (they supersede each other)
 * - ci_result: show all (different checks are distinct)
 * - comment: show count (details retrieved via MCP)
 * - feedback: show all (each piece of feedback matters)
 * - child_completed: show all (different children)
 * - child_failed: show all (different children)
 */
export function buildSignalSummary(signals: TaskSignal[]): string {
  if (signals.length === 0) return '';

  const byType = new Map<SignalType, TaskSignal[]>();
  for (const signal of signals) {
    const list = byType.get(signal.type) ?? [];
    list.push(signal);
    byType.set(signal.type, list);
  }

  const sections: string[] = [];

  // Upstream changes — latest supersedes earlier ones
  const upstreamSignals = byType.get('upstream_change');
  if (upstreamSignals) {
    const latest = upstreamSignals[upstreamSignals.length - 1];
    sections.push(`**Upstream changes:** ${latest.summary}`);
  }

  // CI results — show all (different checks/runs)
  const ciSignals = byType.get('ci_result');
  if (ciSignals) {
    for (const signal of ciSignals) {
      sections.push(`**CI result:** ${signal.summary}`);
    }
  }

  // Comments — show count, agent retrieves details via MCP
  const commentSignals = byType.get('comment');
  if (commentSignals) {
    const count = commentSignals.length;
    const noun = count === 1 ? 'comment' : 'comments';
    sections.push(`**New ${noun}:** ${count} new ${noun} added since your last turn. Use the lazy MCP tools to read them.`);
  }

  // Feedback — show all
  const feedbackSignals = byType.get('feedback');
  if (feedbackSignals) {
    for (const signal of feedbackSignals) {
      sections.push(`**Feedback:** ${signal.summary}`);
    }
  }

  // Child completed — show all
  const childCompletedSignals = byType.get('child_completed');
  if (childCompletedSignals) {
    for (const signal of childCompletedSignals) {
      sections.push(`**Child task completed:** ${signal.summary}`);
    }
  }

  // Child failed — show all
  const childFailedSignals = byType.get('child_failed');
  if (childFailedSignals) {
    for (const signal of childFailedSignals) {
      sections.push(`**Child task failed:** ${signal.summary}`);
    }
  }

  return '## Signals since your last turn\n\n' + sections.join('\n\n');
}
