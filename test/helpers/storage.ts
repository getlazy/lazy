/**
 * Shared storage-path helpers for e2e tests.
 *
 * Test projects `lazy init` with the `external` storage backend, so a task's
 * on-disk state does NOT live at `<root>/.lazy/tasks` — it lives at the
 * `external_path` written into the project's lazy.toml (by default
 * `~/.lazy/<project-name>`). Suites that poke storage directly (to seed a
 * state the CLI can't produce, or to assert on turn/violation records) used to
 * hardcode `<root>/.lazy/tasks` and silently broke when the backend changed.
 *
 * This module is the ONE place that knows the layout. It is a TEST-ONLY
 * convenience: production code must always go through the Storage interface.
 */

import { join } from 'path';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';

/**
 * Resolve the external storage base directory for a test project by reading
 * `external_path` out of its lazy.toml. Falls back to the in-repo `.lazy`
 * layout for projects initialized without an external path.
 */
export function storageDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return m[1];
  return join(root, '.lazy');
}

/** Resolve the tasks directory for a test project. */
export function tasksDirFor(root: string): string {
  return join(storageDirFor(root), 'tasks');
}

/** Find the full task UUID directory name from a short (8-char) prefix. */
export function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = tasksDirFor(root);
  const dirs = readdirSync(tasksDir);
  const match = dirs.find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId} in ${tasksDir}`);
  return match;
}

/** Absolute path to a task's storage directory. */
export function taskDirFor(root: string, shortId: string): string {
  return join(tasksDirFor(root), findFullTaskId(root, shortId));
}

/**
 * Resolve a task's storage directory by short id, code, or task_ref — whatever
 * the caller has. CLI arg resolution accepts all three; this is the test-side
 * equivalent for helpers that read storage directly. Codes and refs do not
 * prefix-match the UUID directory names, so fall back to reading task.json.
 */
export function taskDirByRef(root: string, ref: string): string {
  const tasksDir = tasksDirFor(root);
  try {
    return taskDirFor(root, ref);
  } catch {
    // Not a UUID prefix — scan for code / task_ref / short id inside task.json.
    for (const dir of readdirSync(tasksDir)) {
      if (dir.includes('.tmp') || dir.includes('.backup')) continue;
      const taskPath = join(tasksDir, dir, 'task.json');
      if (!existsSync(taskPath)) continue;
      const data = JSON.parse(readFileSync(taskPath, 'utf-8')) as Record<string, any>;
      if (
        data.code === ref ||
        (data.metadata?.task_ref as string | undefined) === ref ||
        data.id?.startsWith(ref)
      ) {
        return join(tasksDir, dir);
      }
    }
    throw new Error(`Task directory not found for ${ref} in ${tasksDir} (by code/task_ref/id)`);
  }
}

/** Absolute path to a file inside a task's storage directory. */
export function taskFilePath(root: string, shortId: string, file: string): string {
  return join(taskDirByRef(root, shortId), file);
}

/**
 * Absolute path to a task's git worktree.
 *
 * Worktrees are NOT external storage — they live in the repo's data dir
 * (`<root>/.lazy/worktrees/<task_ref>`, see `getWorktreePath` in
 * src/task/identity.ts). Test tasks are created without a code, so the ref is the
 * short id.
 */
export function worktreePathFor(root: string, shortId: string): string {
  return join(root, '.lazy', 'worktrees', shortId);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Read a task's task.json. */
export function readTaskJson(root: string, shortId: string): Record<string, any> {
  return readJson(taskFilePath(root, shortId, 'task.json'));
}

/** Write a task's task.json. */
export function writeTaskJson(root: string, shortId: string, data: Record<string, any>): void {
  writeJson(taskFilePath(root, shortId, 'task.json'), data);
}

/** Read a task's current status straight from storage. */
export function readTaskStatus(root: string, shortId: string): string {
  return readTaskJson(root, shortId).status;
}

/** Overwrite a task's status straight in storage (test setup shortcut). */
export function setTaskStatus(root: string, shortId: string, status: string): void {
  const data = readTaskJson(root, shortId);
  data.status = status;
  writeTaskJson(root, shortId, data);
}

/** Set one metadata key on a task straight in storage (test setup shortcut). */
export function setTaskMetadata(root: string, shortId: string, key: string, value: string): void {
  const data = readTaskJson(root, shortId);
  if (!data.metadata) data.metadata = {};
  data.metadata[key] = value;
  writeTaskJson(root, shortId, data);
}

/** Read a task's session.json, or null when the task was never started. */
export function readSessionJson(root: string, shortId: string): Record<string, any> | null {
  const path = taskFilePath(root, shortId, 'session.json');
  if (!existsSync(path)) return null;
  return readJson(path);
}

/** Write a task's session.json. */
export function writeSessionJson(root: string, shortId: string, data: Record<string, any>): void {
  writeJson(taskFilePath(root, shortId, 'session.json'), data);
}

export interface StoredTurn {
  role: string;
  content: string;
  turn_type?: string;
  actor?: string;
  /** WHICH person acted, when the acting token identified one. */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
  sequence?: number;
  usage?: { cacheCreationTokens?: number; cacheReadTokens?: number };
  violations?: Array<{ file: string; base_sha: string; status: string }>;
  [key: string]: unknown;
}

/** Read a task's recorded turns straight from storage. */
export function readTurns(root: string, shortId: string): StoredTurn[] {
  const path = taskFilePath(root, shortId, 'turns.json');
  if (!existsSync(path)) return [];
  return readJson<{ turns: StoredTurn[] }>(path).turns;
}

/**
 * Overwrite a task's recorded turns. Only for seeding states the CLI cannot
 * produce on purpose — e.g. a legacy turn record with no `content` key, which
 * is exactly the corruption that crashed accept and search.
 */
export function writeTurns(root: string, shortId: string, turns: StoredTurn[]): void {
  writeJson(taskFilePath(root, shortId, 'turns.json'), { turns });
}

export interface StoredRaisedItem {
  id: string;
  task_id: string;
  content: string;
  created_at: number;
  /** The whole difference between the two former entities. */
  blocking?: boolean;
  title?: string;
  /** Absent means open — that back-compat default is worth exercising. */
  triage_status?: 'open' | 'acknowledged' | 'dismissed' | 'promoted';
  status?: string;
  [key: string]: unknown;
}

/**
 * Seed a task's raised items. The only authoring path is an agent calling
 * `lazy_raise` mid-turn, so a suite that needs a task carrying triaged and
 * untriaged items — blocking and not — cannot get there through the CLI. It
 * writes the records the listing reads.
 */
export function writeRaisedItemsFile(root: string, shortId: string, items: StoredRaisedItem[]): void {
  writeJson(taskFilePath(root, shortId, 'raised-items.json'), { raised_items: items });
}

/** Read a task's raised items straight from storage. */
export function readRaisedItems(root: string, shortId: string): StoredRaisedItem[] {
  const path = taskFilePath(root, shortId, 'raised-items.json');
  if (!existsSync(path)) return [];
  return readJson<{ raised_items: StoredRaisedItem[] }>(path).raised_items;
}

export interface StoredJournalEntry {
  id?: string;
  task_id?: string;
  content: string;
  created_at?: number;
  actor?: string;
  [key: string]: unknown;
}

/** Read a task's journal entries straight from storage. */
export function readJournal(root: string, shortId: string): StoredJournalEntry[] {
  const path = taskFilePath(root, shortId, 'journal.json');
  if (!existsSync(path)) return [];
  return readJson<{ journal: StoredJournalEntry[] }>(path).journal ?? [];
}

/** @deprecated Legacy shape — use {@link StoredRaisedItem}. */
export type StoredFollowUp = StoredRaisedItem;

/**
 * Seed a task's PRE-UNIFICATION `follow-ups.json`.
 *
 * This is a MIGRATION fixture, not an ordinary seeding helper: follow-ups are
 * raised items with `blocking: false` now, and the file this writes is only
 * ever read by the one-time conversion that runs at daemon start. Seed it
 * BEFORE the daemon comes up, or the records stay invisible — the migration
 * does not re-run. For ordinary seeding use `writeRaisedItemsFile`.
 */
export function writeFollowUpsFile(root: string, shortId: string, followUps: StoredFollowUp[]): void {
  writeJson(taskFilePath(root, shortId, 'follow-ups.json'), { follow_ups: followUps });
}

export interface StoredSystemMessage {
  id: string;
  created_at: number;
  source: string;
  title: string;
  body: string;
  kind: string;
  read_at?: number;
  dismissed_at?: number;
  dismissed_by?: string;
  [key: string]: unknown;
}

/** Read the project's system messages straight from storage. */
export function readSystemMessagesFile(root: string): StoredSystemMessage[] {
  const path = join(storageDirFor(root), 'system-messages.json');
  if (!existsSync(path)) return [];
  return readJson<{ system_messages: StoredSystemMessage[] }>(path).system_messages;
}

/**
 * Seed the project's system messages. Only for e2e suites: the CLI has no
 * create surface on purpose (producers file messages via `lazy_message_post`
 * or the daemon), so tests seed the store directly to exercise list/read/
 * dismiss and the builder-launch injection.
 */
export function writeSystemMessagesFile(root: string, messages: StoredSystemMessage[]): void {
  writeJson(join(storageDirFor(root), 'system-messages.json'), { system_messages: messages });
}

/** Write one stored conversation JSON file into the external store. */
export function writeConversationFile(root: string, conversation: Record<string, unknown>): void {
  const dir = join(storageDirFor(root), 'conversations');
  const sessionId = conversation.sessionId as string;
  if (!sessionId) throw new Error('writeConversationFile: conversation.sessionId is required');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${sessionId}.json`), conversation);
}

/**
 * Seed shared-memory records by writing `memories.json` in the external store.
 *
 * Prefer `lazy memory save` when a few records will do — that is the real
 * authoring path. Direct writes exist for bulk fixtures (mechanical compact
 * only pays off at ~50+ records) where 60 CLI subprocesses would dominate
 * the suite, and for asserting store state after a web POST. The daemon's
 * FileStorage re-reads this file on every call, so a write then a fetch is
 * visible; do not open a second Storage instance in a withDaemon suite
 * (the daemon holds `.storage-lock`).
 */
export function writeMemoriesFile(root: string, memories: Array<Record<string, unknown>>): void {
  writeJson(join(storageDirFor(root), 'memories.json'), { memories });
}

/** Read the project's memory records straight from storage. */
export function readMemoriesFile(root: string): Array<Record<string, unknown>> {
  const path = join(storageDirFor(root), 'memories.json');
  if (!existsSync(path)) return [];
  return readJson<{ memories: Array<Record<string, unknown>> }>(path).memories ?? [];
}

/** Read the derived memory compact, or null when none has been generated. */
export function readMemoryCompactFile(root: string): Record<string, unknown> | null {
  const path = join(storageDirFor(root), 'memory-compact.json');
  if (!existsSync(path)) return null;
  return readJson<{ compact: Record<string, unknown> }>(path).compact ?? null;
}

/** Read the project settings record (the store's overlay), or null when none. */
export function readProjectSettingsFile(root: string): Record<string, unknown> | null {
  const path = join(storageDirFor(root), 'project-settings.json');
  if (!existsSync(path)) return null;
  return readJson<Record<string, unknown>>(path);
}
