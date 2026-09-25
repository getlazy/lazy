/**
 * Task URLs for the web UI — one place that turns a task identity into a
 * `/tasks/<segment>` path.
 *
 * WHY CODES
 * Task codes are the human-readable half of a task's identity (`teams-cli-login`),
 * and every `/tasks/:id` route on the dashboard resolves them (`Storage.getTask`
 * and `Storage.resolveTask` both resolve a code, a hex prefix, or an id), so the
 * address bar can carry the name the engineer actually knows the task by. The
 * UUID keeps working everywhere — bookmarks and history entries never break —
 * so the only thing this module changes is which segment NEW links carry.
 *
 * THE DUPLICATE RULE
 * Two tasks can carry the same code (the store guards it at creation but not
 * on every edit path). A code URL resolves to one winner by the same
 * disambiguation `lazy <task>` uses (non-terminal preferred, then most
 * recent), so a duplicated code would send the reader to a DIFFERENT task
 * than the link meant. When the caller knows the duplicate set — built once
 * per route from the cheap, index-served `listTaskCodes()` — links for a
 * duplicated task fall back to its id, exactly the posture
 * `buildTaskCodeLinkify` (prose linkification) already takes. Without a set,
 * links carry the code-or-id segment: correct whenever the code is unique,
 * which is the ordinary case.
 *
 * Segment only, on purpose: callers append their own suffix
 * (`taskPath(task, dup) + '/raised'`) and keep `escapeHtml` for the
 * HTML-attribute context around the href. The returned segment is always
 * URL-escaped.
 */

import type { TaskCodeEntry } from '../storage/types';
import { isReservedTaskPathSegment } from '../task/identity';

/** One task's identity, as link builders see it. Both fields optional: some call sites (diff blame labels) know only the code. */
export interface TaskPathRef {
  id?: string;
  code?: string | null;
}

/**
 * The URL path segment for one task: its code when the task has one and the
 * caller has not said it is duplicated (or has no id to fall back to), its id
 * otherwise. Codeless tasks link by id; UUID links never break.
 */
export function taskPathSegment(ref: TaskPathRef, duplicated?: ReadonlySet<string>): string {
  const code = ref.code ?? null;
  const id = ref.id ?? null;
  const useCode =
    code !== null &&
    code !== '' &&
    !(id !== null && duplicated?.has(code)) &&
    // A code the router reserves under /tasks/ (`new`, `link`) is matched as
    // that FORM before it is matched as a task, so linking by it would open
    // the create page instead of the task. `validateCode` refuses such a code
    // now, but only NEW codes ever went through it — a store can already hold
    // one, so generation falls back here rather than trusting validation.
    !(id !== null && isReservedTaskPathSegment(code));
  const segment = useCode ? code : (id ?? code ?? '');
  if (!segment) {
    throw new Error('taskPathSegment: task has neither id nor code to link by');
  }
  return encodeURIComponent(segment);
}

/** The task's URL path, `/tasks/<segment>`. Caller appends tab suffixes. */
export function taskPath(ref: TaskPathRef, duplicated?: ReadonlySet<string>): string {
  return `/tasks/${taskPathSegment(ref, duplicated)}`;
}

/**
 * The inverse of the escaping {@link taskPathSegment} applies — the resolution
 * half of the pair, so what a link escapes into the address is what the router
 * matches against the store.
 *
 * Generation escapes every path segment exactly once (a task's segment here, a
 * raw id / name / session id at its own call site). Nothing undid it: the
 * router split the raw pathname and matched it verbatim, so a code carrying a
 * URL-significant character was escaped INTO an address that then resolved to
 * nothing — reachable by no spelling at all. Four route handlers had each
 * re-spelled this decode locally, which is the same rule in four places.
 *
 * A malformed escape (`%zz`, a lone `%`) makes `decodeURIComponent` throw. A
 * URL anyone can type must not become a 500, so the raw segment is used
 * instead — it simply will not match a task, which is the correct answer for a
 * path that names none.
 */
export function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-escape — not decodable, so it cannot name a task.
    // Matching on the raw text yields the 404 the caller already handles.
    return raw;
  }
}

/**
 * The set of codes carried by MORE THAN ONE task — the fallback trigger for
 * {@link taskPath}. Pure over its input; callers build it once per render
 * from the index-served `listTaskCodes()`.
 */
export function duplicateTaskCodes(entries: readonly TaskCodeEntry[]): Set<string> {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.code) continue;
    seen.set(entry.code, (seen.get(entry.code) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [code, count] of seen) {
    if (count > 1) dups.add(code);
  }
  return dups;
}

/** Code lookup tables built once per route from `listTaskCodes()`. */
export interface TaskCodeTables {
  /** Code by task id, for call sites that hold only a UUID. */
  codeOf: Map<string, string>;
  /** Codes shared by more than one task — see {@link duplicateTaskCodes}. */
  duplicated: Set<string>;
}

export function taskCodeTables(entries: readonly TaskCodeEntry[]): TaskCodeTables {
  const codeOf = new Map<string, string>();
  for (const entry of entries) {
    if (entry.code) codeOf.set(entry.id, entry.code);
  }
  return { codeOf, duplicated: duplicateTaskCodes(entries) };
}

/** The `/tasks/<segment>` path for a task the caller knows only by id. */
export function taskPathByTaskId(tables: TaskCodeTables, id: string, suffix = ''): string {
  return `${taskPath({ id, code: tables.codeOf.get(id) ?? null }, tables.duplicated)}${suffix}`;
}