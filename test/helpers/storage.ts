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
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

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

/** Absolute path to a file inside a task's storage directory. */
export function taskFilePath(root: string, shortId: string, file: string): string {
  return join(taskDirFor(root, shortId), file);
}

/**
 * Absolute path to a task's git worktree.
 *
 * Worktrees are NOT external storage — they live in the repo's data dir
 * (`<root>/.lazy/worktrees/<task_ref>`, see `getWorktreePath` in
 * src/cli/helpers.ts). Test tasks are created without a code, so the ref is the
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
