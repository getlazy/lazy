/**
 * Which hex ids in prose name something lazy has a page for.
 *
 * A reader pastes `29044bce` into a comment meaning a raised item, `a1b2c3d4`
 * meaning a task, `4f9e2c1` meaning a commit. Every rendering surface — the
 * daemon dashboard and Lazy Teams (through the `resolveIds` RPC) — asks THIS
 * module which of those tokens exist, so the two can never disagree about what
 * a string links to, and Teams never re-derives the store's contents.
 *
 * Rules:
 * - an 8-hex token that is the prefix of exactly one task id is that task;
 * - else an 8-hex token that is the prefix of exactly one raised-item id is
 *   that item;
 * - else a 7..40-hex token that is the prefix of exactly one commit RECORDED
 *   on the context task is that commit (no task context → no commit links);
 * - anything else — no match, or two matches of one kind — is not a link.
 *
 * Task codes are a separate table (src/server/task-code-links.ts) and are
 * matched before any of this.
 */

import type { Storage } from '../storage/interface';

export type IdLinkTarget =
  | { kind: 'task'; taskId: string; taskCode: string | null }
  | { kind: 'raised'; raisedId: string; taskId: string }
  | { kind: 'commit'; taskId: string; taskCode: string | null; commitId: string; sha: string };

export interface IdLinkIndex {
  resolve(token: string): IdLinkTarget | null;
}

/** Minimum length at which a stored task code is a candidate for word autolink. */
export const AUTOLINK_TASK_CODE_MIN_LENGTH = 8;

/**
 * Whether this stored code should become a link in prose. Matching only — not
 * validation: `validateCode` still accepts 2-character codes, which would
 * light up ordinary words, so a code must be long enough AND look like a slug.
 */
export function isAutolinkableTaskCode(code: string): boolean {
  if (code.length < AUTOLINK_TASK_CODE_MIN_LENGTH) return false;
  return /[-_0-9]/.test(code);
}

/** A candidate token in prose: 7 to 40 lowercase hex characters. */
export const ID_TOKEN_PATTERN = /^[0-9a-f]{7,40}$/;
const SHORT_ID_LENGTH = 8;

/** Unique-prefix lookup: the one value whose key starts with `token`, else null. */
function uniquePrefix<T>(byShort: Map<string, T | null>, token: string): T | null {
  return byShort.get(token) ?? null;
}

function indexShort<T>(entries: Iterable<[string, T]>): Map<string, T | null> {
  const map = new Map<string, T | null>();
  for (const [id, value] of entries) {
    const short = id.toLowerCase().slice(0, SHORT_ID_LENGTH);
    // Two ids sharing a short prefix: the token is ambiguous, never guessed.
    map.set(short, map.has(short) ? null : value);
  }
  return map;
}

export function buildIdLinkIndexFrom(input: {
  tasks: ReadonlyArray<{ id: string; code?: string | null }>;
  raised: ReadonlyArray<{ id: string; task_id: string }>;
  contextTask?: { id: string; code?: string | null } | null;
  commits?: ReadonlyArray<{ id: string; sha: string }>;
}): IdLinkIndex {
  const tasks = indexShort(input.tasks.map((t) => [t.id, t] as [string, typeof t]));
  const raised = indexShort(input.raised.map((r) => [r.id, r] as [string, typeof r]));
  const commits = (input.commits ?? []).map((c) => ({ ...c, sha: c.sha.toLowerCase() }));
  const ctx = input.contextTask ?? null;
  // Exact task codes (autolinkable, unique) — a code shared by two tasks is
  // never guessed.
  const codeCount = new Map<string, number>();
  for (const t of input.tasks) if (t.code) codeCount.set(t.code, (codeCount.get(t.code) ?? 0) + 1);
  // A target's `taskCode` is set only when it names ONE task, so a remote
  // renderer can put it in a URL without knowing the duplicate set.
  const uniqueCode = (code?: string | null) => (code && codeCount.get(code) === 1 ? code : null);
  const codes = new Map<string, { id: string; code: string } | null>();
  for (const t of input.tasks) {
    const code = t.code?.trim();
    if (!code || !isAutolinkableTaskCode(code)) continue;
    codes.set(code, codes.has(code) ? null : { id: t.id, code });
  }

  return {
    resolve(raw: string): IdLinkTarget | null {
      const byCode = codes.get(raw);
      if (byCode) return { kind: 'task', taskId: byCode.id, taskCode: byCode.code };
      const token = raw.toLowerCase();
      if (!ID_TOKEN_PATTERN.test(token)) return null;
      if (token.length === SHORT_ID_LENGTH) {
        const task = uniquePrefix(tasks, token);
        if (task) return { kind: 'task', taskId: task.id, taskCode: uniqueCode(task.code) };
        const item = uniquePrefix(raised, token);
        if (item) return { kind: 'raised', raisedId: item.id, taskId: item.task_id };
      }
      if (!ctx) return null;
      const hits = commits.filter((c) => c.sha.startsWith(token));
      // The same sha recorded twice is still one commit.
      if (hits.length === 0 || new Set(hits.map((h) => h.sha)).size > 1) return null;
      return { kind: 'commit', taskId: ctx.id, taskCode: uniqueCode(ctx.code), commitId: hits[0]!.id, sha: hits[0]!.sha };
    },
  };
}

/**
 * Snapshot the store into an index. `taskId` names the task whose recorded
 * commits may be linked; without it only tasks and raised items resolve.
 */
export async function buildIdLinkIndex(
  storage: Storage,
  options: {
    taskId?: string | null;
    /** The caller's already-loaded `listTaskCodes()`, to skip a second read. */
    taskCodes?: ReadonlyArray<{ id: string; code: string | null }>;
    /**
     * The tokens that will be asked about, when known up front (the RPC). Lets
     * the build skip the store-wide raised scan and the commit read when no
     * token could need them.
     */
    tokens?: readonly string[];
  } = {},
): Promise<IdLinkIndex> {
  const tasks = options.taskCodes ?? await storage.listTaskCodes();
  const hex = options.tokens?.map((t) => t.toLowerCase()).filter((t) => ID_TOKEN_PATTERN.test(t));
  const taskShorts = new Set(tasks.map((t) => t.id.toLowerCase().slice(0, SHORT_ID_LENGTH)));
  const needRaised = !hex || hex.some((t) => t.length === SHORT_ID_LENGTH && !taskShorts.has(t));
  const needCommits = !hex || hex.length > 0;
  const raised = needRaised
    ? (await storage.listRaisedItems({ state: 'all', collapseExactDuplicates: false })).items
    : [];
  let contextTask: { id: string; code: string | null } | null = null;
  const commits: { id: string; sha: string }[] = [];
  if (options.taskId && needCommits) {
    // A code, full id or unique prefix — whatever the caller's URL carried.
    const { task } = await storage.resolveTask(options.taskId);
    if (task) {
      contextTask = { id: task.id, code: task.code ?? null };
      // The task's ONE session, ended or not — the same read the commit page
      // uses, so a link never points at a commit that page cannot find.
      // (`listSessions` would drop an ended session: no links on finished tasks.)
      const session = await storage.getSessionByTaskId(task.id);
      if (session) commits.push(...(await storage.getSessionCommits(session.id)));
    }
  }
  return buildIdLinkIndexFrom({ tasks, raised, contextTask, commits });
}
