/**
 * How a task is named and where its work lives.
 *
 * A task's code, its short id, the stable ref derived from them, and the
 * worktree path and branch name that ref produces are domain facts about the
 * task — the daemon launches turns from them, the remote drivers push them, the
 * reconciler walks them, the CLI merely prints them. They live here so no layer
 * has to import a CLI module to learn a task's own identity.
 */

import { join } from 'path';
import { getDataDir } from '../project-paths';
import { taskBranchFor } from '../git/branch-prefix';
import type { Storage } from '../storage';
import type { Task } from '../types';

/**
 * Maximum length for task codes (in characters).
 * Used for validation in CLI and MCP tool schemas.
 *
 * 63 because a task code becomes a DNS label: a task's services are served at
 * `<service>.<code>.lazy.localhost`, and 63 octets is the label limit every
 * resolver and browser enforces. See {@link validateCode}.
 */
export const MAX_TASK_CODE_LENGTH = 63;

/**
 * Path segments the web UI routes under `/tasks/` as something OTHER than a
 * task — the create and link forms. A task whose code is one of these would be
 * addressed at `/tasks/new`, which the router matches as the form first, so the
 * task is unreachable at its own code URL.
 *
 * ONE list, read by all three parties, so a future reserved route cannot drift
 * away from the rule that keeps codes off it:
 *   - `validateCode` below refuses a new code that collides;
 *   - the router (`src/server/index.ts`) matches its literal routes from here;
 *   - link generation (`src/server/task-urls.ts`) falls back to the id for a
 *     code already stored, since validation only ever ran on new codes.
 *
 * Adding a route to this list is therefore the whole change: nothing else has
 * to be remembered.
 */
export const TASK_PATH_SEGMENT_NEW = 'new';
export const TASK_PATH_SEGMENT_LINK = 'link';

/**
 * The list is DERIVED from the named segments above, so the router can route by
 * name while validation and link generation read the whole set. Adding a
 * reserved route means adding its constant here and nowhere else.
 */
export const RESERVED_TASK_PATH_SEGMENTS = [
  TASK_PATH_SEGMENT_NEW,
  TASK_PATH_SEGMENT_LINK,
] as const;

/** Whether `value` is a segment the web router reserves under `/tasks/`. */
export function isReservedTaskPathSegment(value: string): boolean {
  return (RESERVED_TASK_PATH_SEGMENTS as readonly string[]).includes(value);
}

/**
 * Shorten a UUID to 8 characters
 */
export function shortId(id: string): string {
  return id.substring(0, 8);
}

/**
 * Return the preferred display identifier for a task.
 * If the task has a code, return it; otherwise return the short hex ID.
 */
export function displayId(task: Task): string {
  return task.code ?? shortId(task.id);
}

/**
 * Look up a task by ID and return its display identifier.
 * Falls back to shortId if the task cannot be found.
 */
export async function displayIdFor(storage: Storage, taskId: string): Promise<string> {
  const task = await storage.getTask(taskId);
  return task ? displayId(task) : shortId(taskId);
}

/**
 * Get the stable task ref for a task.
 * Returns the stored task_ref metadata if available, falling back to shortId.
 * New tasks have task_ref stored at creation time; old tasks use shortId.
 */
export function taskRef(task: Task): string {
  return task.metadata?.task_ref ?? shortId(task.id);
}

/**
 * Look up a task's ref by ID. Falls back to shortId if task not found.
 */
export async function taskRefFromId(taskId: string, storage: Storage): Promise<string> {
  const task = await storage.getTask(taskId);
  return task ? taskRef(task) : shortId(taskId);
}

/**
 * Get the worktree path for a task.
 */
export function getWorktreePath(root: string, task: Task): string {
  return join(root, getDataDir(root), 'worktrees', taskRef(task));
}

/**
 * Get the worktree path for a task ref string (already resolved).
 */
export function getWorktreePathForRef(root: string, tRef: string): string {
  return join(root, getDataDir(root), 'worktrees', tRef);
}

/**
 * Get the git branch name for a task.
 *
 * The namespace comes from `[git] default_branch_prefix`, installed process-wide
 * by loadConfig — never a `lazy/` literal (see src/git/branch-prefix.ts).
 */
export function getBranchName(task: Task): string {
  return taskBranchFor(taskRef(task));
}

/**
 * Get the git branch name for a task by ID.
 */
export async function getBranchNameFromId(taskId: string, storage: Storage): Promise<string> {
  return taskBranchFor(await taskRefFromId(taskId, storage));
}

/**
 * Format a timestamp as YY-MM-DD for use in task refs.
 */
function formatDateForRef(ts: number): string {
  const d = new Date(ts);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Derive a stable, human-readable reference for a task.
 * Used for branch names (lazy/<ref>), worktree dirs, and container names.
 *
 * Progressive disambiguation:
 * 1. <code>                    — when code is unique across all tasks
 * 2. <code>-<yy-mm-dd>        — when another task shares the same code
 * 3. <code>-<yy-mm-dd>-<id>   — when ambiguous on both code and date
 * 4. <shortId>                 — fallback when no code is set
 *
 * @param task The task to derive a ref for
 * @param allTasks All tasks (including terminal) for ambiguity checking
 */
export function deriveTaskRef(task: Task, allTasks: Task[]): string {
  if (!task.code) {
    return shortId(task.id);
  }

  // Check for other tasks with the same code (excluding this task)
  const sameCode = allTasks.filter(t => t.id !== task.id && t.code === task.code);

  if (sameCode.length === 0) {
    // Unique code
    return task.code;
  }

  // Need date disambiguation
  const dateStr = formatDateForRef(task.created_at);

  // Check if any same-code tasks also share the same date
  const sameDateAndCode = sameCode.filter(t => formatDateForRef(t.created_at) === dateStr);

  if (sameDateAndCode.length === 0) {
    // Date disambiguates
    return `${task.code}-${dateStr}`;
  }

  // Full disambiguation with task ID
  return `${task.code}-${dateStr}-${shortId(task.id)}`;
}

/**
 * Build a map from task ID → display identifier for a list of tasks.
 * Useful for resolving parent_task_id in list views without extra lookups.
 * Falls back to shortId for IDs not in the map.
 */
export function buildDisplayIdMap(tasks: Task[]): (taskId: string) => string {
  const map = new Map<string, string>();
  for (const t of tasks) {
    map.set(t.id, displayId(t));
  }
  return (taskId: string) => map.get(taskId) ?? shortId(taskId);
}

/**
 * Derive a task code from a branch name or title string.
 * Rules: lowercase, replace every non-alphanumeric run (dots included) with `-`, truncate to 63 chars.
 * Returns null if the derived code would be invalid (too short, reserved, etc.).
 *
 * Dots become hyphens because the result has to be a DNS label — see
 * {@link validateCode}. `release/v1.0` derives `release-v1-0`.
 */
export function deriveCode(input: string): string | null {
  const derived = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanumeric runs with a single `-`
    .replace(/^-+/, '')           // strip leading hyphens
    .replace(/-+$/, '')           // strip trailing hyphens
    .slice(0, MAX_TASK_CODE_LENGTH)  // truncate to max code length
    .replace(/-+$/, '');          // strip any trailing hyphen created by truncation

  if (validateCode(derived) !== null) {
    return null;
  }
  return derived;
}

/**
 * Validate a task code.
 * Rules: lowercase alphanumeric + hyphens, 2-63 chars, starts and ends with a letter or digit.
 * Returns null if valid, or an error message string if invalid.
 *
 * That is exactly a DNS label, and deliberately so: a task's `[serve]` services
 * are reachable at `<service>.<code>.lazy.localhost`, so a code that is not a
 * label cannot be addressed there. Dots used to be allowed and are not any
 * more — a dotted code would silently become two labels in that hostname.
 *
 * Only NEW codes go through here. Tasks created before this rule keep their
 * dotted codes and keep working everywhere; in a hostname they are addressed by
 * their short id instead (src/serve/subdomain.ts).
 */
export function validateCode(code: string): string | null {
  if (code.length < 2) {
    return `Code must be 2-${MAX_TASK_CODE_LENGTH} characters long`;
  }
  if (code.length > MAX_TASK_CODE_LENGTH) {
    return `Task code must be ${MAX_TASK_CODE_LENGTH} characters or fewer (got ${code.length}). ` +
      `A code becomes part of a hostname (<service>.<code>.lazy.localhost), and that limit is a ` +
      `DNS one. Shorten it.`;
  }
  if (code.includes('.')) {
    // Called out separately from the general format error: dots were valid
    // until recently, so the useful answer is why they stopped being valid and
    // what to write instead — not a restatement of the rule.
    return `Code must not contain dots — it becomes part of a hostname ` +
      `(<service>.<code>.lazy.localhost), where a dot would split it into two labels. ` +
      `Use hyphens: '${code.replace(/\.+/g, '-')}'`;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(code)) {
    return 'Code must be lowercase alphanumeric + hyphens, starting and ending with a letter or digit';
  }
  if (code.startsWith('lazy-')) {
    return "Codes starting with 'lazy-' are reserved for system entities";
  }
  if (isReservedTaskPathSegment(code)) {
    // The web UI addresses a task at /tasks/<code>, and these segments route to
    // the create and link FORMS first — so such a task could never be opened at
    // its own code URL.
    return `Code '${code}' is reserved — the web UI routes /tasks/${code} to a form, ` +
      `so a task with this code could not be opened by its code. Reserved: ` +
      `${RESERVED_TASK_PATH_SEGMENTS.join(', ')}.`;
  }
  return null;
}
