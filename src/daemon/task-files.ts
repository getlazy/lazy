/**
 * Per-task secret FILES — a `.env`, a service-account JSON, a client cert —
 * written into ONE task's worktree, never committed or pushed. The file-shaped
 * sibling of per-task environment variables (./task-env.ts); Lazy Teams pushes
 * each task's effective set over the control-only `taskFiles` RPC.
 *
 * WHERE THE CONTENTS LIVE
 * -----------------------
 * `~/.lazy/daemon/<slug>/task-files.json`, mode 0600, outside Storage — for
 * exactly the reasons ./task-env.ts gives (the project root is mounted into
 * every container; Storage travels; a secret must not). Bounded by
 * construction (MAX_FILES_PER_TASK, MAX_FILE_BYTES, MAX_TOTAL_BYTES, and the
 * scrubber's per-source cap, checked BEFORE anything is written) and
 * disposable (the control plane pushes the set again). Forgotten at the task's
 * terminal state next to its env (revokeTaskTokens in ./task-lifecycle.ts).
 * No read RPC returns contents — paths only.
 *
 * The same registry is the ONLY record of what was delivered: per task, every
 * path ever written and every content written there (`delivered`). The
 * worktree's `.lazy-task-sandbox/task-files.json` is a convenience copy for
 * tooling in the container; it is agent-writable, so nothing security-relevant
 * reads it — no guard, and certainly no deletion.
 *
 * DELIVERY
 * --------
 * `deliverTaskFiles` writes every file into the worktree, mode 0600, through
 * the link-safe writer (./link-safe-files.ts: a symlink planted at the path is
 * replaced, never followed; a symlinked parent directory is refused). It runs
 * when the worktree is created and before EVERY work launch — start, unblock,
 * resume, auto-resume, auto-deliver, sync — so a merge or an agent edit that
 * touched a path is repaired on the next turn.
 *
 * A path that ALREADY holds exactly what would be written (same bytes, no
 * looser mode, and — for a root daemon — already owned by the worktree's
 * owner) is left untouched: no write, no rename, no new inode or mtime. The
 * exclude list and the manifest are treated the same way. A task's services
 * keep running in its container while its agent works, and a dev server that
 * watches `.env` restarts on every replace, so a launch that rewrote unchanged
 * secrets restarted the person's app every turn. A changed file is still
 * written exactly as before, and a root daemon hands it to the worktree's owner
 * BEFORE it is renamed into place, so it is never briefly unreadable to them.
 *
 * A path the task's branch TRACKS is never overwritten: delivering there would
 * either ship the secret as a modification or silently replace the project's
 * own file. Nor is an UNTRACKED file lazy did not put there (a
 * `[worktree] include` copy, the agent's own work). Both are refused per path
 * and reported in the result (`refused`), which the RPC and the launch
 * narration surface.
 *
 * LAZY NEVER DELETES A DELIVERED FILE
 * -----------------------------------
 * A path the control plane stops sending is RETIRED: no longer written, and
 * left exactly where it is — whatever it holds. It stays excluded from git and
 * guarded for the task's whole life, so deselecting never re-exposes it, and its
 * last content stays registered with the scrubber (`retired`) until the task
 * ends, since the agent can still read it. A
 * retired file still present is reported (`retired`; the `taskFiles` list
 * action) so a person can remove it if they want to.
 *
 * NEVER COMMITTED
 * ---------------
 * Each delivery writes `.lazy-task-sandbox/task-files.exclude` (git ignore
 * lines for every path ever delivered to the task); git is pointed at it by
 * command-scope config — see ../git/delivered-files-exclude.ts. lazy_commit,
 * accept, push, submit and the record-time notice refuse a commit carrying a
 * delivered path (by path, whatever its content) or any delivered content
 * (../git/delivered-files.ts), from the registry alone (`deliveredGuardFor`).
 */

import { lstat, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { basename, dirname, join, posix } from 'path';
import { homedir } from 'os';
import { getTaskFilesPath } from './paths';
import { LinkRefusedError, readRegularFileUnder, regularFileHolds, writeRegularFileUnder } from './link-safe-files';
import { assertRegistrableSecretValues, MAX_REGISTERED_VALUES_PER_SOURCE, registeredSecretSources, setRegisteredSecretValues } from '../utils/redact';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';
import {
  DELIVERED_FILES_EXCLUDE_REL,
  DELIVERED_FILES_MANIFEST_REL,
  excludeLineFor,
  gitBlobId,
  type DeliveredFileEntry,
} from '../git/delivered-files-exclude';
import { deliveredFilesRefusal, findDeliveredFilesAtRef, findDeliveredFilesInRange } from '../git/delivered-files';
import type { Storage } from '../storage/interface';
import { taskRefFromBranch } from '../git/branch-prefix';
import { getWorktreePathForRef } from '../task/identity';
import { pathExists, writeFileAtomic } from '../utils/fs';
import { secretStringsForFile } from '../utils/secret-file-strings';

export const MAX_FILES_PER_TASK = 32;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
/** Longest accepted path, in bytes. */
const MAX_PATH_BYTES = 1024;
/** Distinct paths ever delivered to one task (the guard set grows only). */
export const MAX_DELIVERED_PATHS_PER_TASK = 256;
/** Contents remembered per delivered path for the content guard, newest kept. */
const MAX_BLOBS_PER_PATH = 16;

/** A file as the RPC receives it. Exactly one of `contents` (UTF-8) / `contentsBase64`. */
export interface TaskFileInput {
  path: string;
  contents?: string;
  contentsBase64?: string;
}

/** What one task was ever given: the worktree ref it went to, and path -> blob ids written there. */
interface DeliveredHistory {
  ref?: string;
  paths: Record<string, string[]>;
}

/** On-disk shape. `tasks`: taskId -> normalized path -> base64 content (the current set). */
interface TaskFilesRegistry {
  version: 2;
  tasks: Record<string, Record<string, string>>;
  delivered: Record<string, DeliveredHistory>;
  /**
   * taskId -> path -> base64: the last content of a delivered file that is no
   * longer selected. lazy leaves such a file in the worktree, where the agent
   * can still read it, so its content stays registered with the scrubber until
   * the task ends. Bounded by MAX_TOTAL_BYTES per task.
   */
  retired: Record<string, Record<string, string>>;
}

/** The scrubber source for one task's files — one per task, so its cap is per task. */
function redactionSource(taskId: string): string {
  return `task-files:${taskId}`;
}

function secretStringsForSet(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([path, b64]) => secretStringsForFile(path, Buffer.from(b64, 'base64').toString('utf-8')));
}

/**
 * Tasks whose stored files could not be registered with the scrubber (an entry
 * written before the cap was checked at intake, or a malformed one). Their
 * files are never delivered — a secret the scrubber cannot recognise must not
 * be put where turns and logs can quote it — and nothing else is affected.
 */
const unscrubbable = new Set<string>();

function registerForRedaction(registry: TaskFilesRegistry): void {
  // One source PER TASK (as ./task-env.ts): one task's oversized or malformed
  // entry is that task's problem, logged and refused at delivery — never a
  // throw that breaks every other task's commit, push, accept or scrub.
  const current = new Set<string>();
  for (const taskId of new Set([...Object.keys(registry.tasks), ...Object.keys(registry.retired)])) {
    const files = { ...registry.retired[taskId], ...registry.tasks[taskId] };
    const source = redactionSource(taskId);
    current.add(source);
    try {
      setRegisteredSecretValues(source, secretStringsForSet(files));
      unscrubbable.delete(taskId);
    } catch (err) {
      // Logged when it starts, not on every read of the registry.
      if (unscrubbable.has(taskId)) continue;
      unscrubbable.add(taskId);
      logger.error(`Task ${taskId}: its secret files cannot be scrubbed from logs and turns, so they will not be delivered: ${(err as Error).message}`);
    }
  }
  for (const source of registeredSecretSources()) {
    if (source.startsWith('task-files:') && !current.has(source)) setRegisteredSecretValues(source, []);
  }
  for (const taskId of [...unscrubbable]) if (!registry.tasks[taskId] && !registry.retired[taskId]) unscrubbable.delete(taskId);
}

/**
 * Validate and normalize one path. Throws with text naming the path (never
 * the content). Refused: empty, absolute, backslashes, NUL and other control characters, `.`/`..`/empty
 * segments, and anything at or under `.git`, `.lazy`, `.lazy-task-sandbox`
 * or a nested `.git` — lazy's own state and git's.
 */
export function validateTaskFilePath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid task file path: a path is required.`);
  }
  const shown = JSON.stringify(input);
  if (input.includes('\0')) throw new Error(`Invalid task file path ${shown}: it contains a NUL byte.`);
  // A newline would inject lines into the worktree's exclude file (`foo\n*`
  // hides every file); no control character belongs in a path.
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error(`Invalid task file path ${shown}: it contains a control character.`);
  if (Buffer.byteLength(input, 'utf-8') > MAX_PATH_BYTES) {
    throw new Error(`Invalid task file path ${shown}: longer than ${MAX_PATH_BYTES} bytes.`);
  }
  if (input.includes('\\')) throw new Error(`Invalid task file path ${shown}: use '/' separators, not '\\'.`);
  if (posix.isAbsolute(input)) {
    throw new Error(`Invalid task file path ${shown}: it must be relative to the worktree root, not absolute.`);
  }
  const parts = input.split('/');
  if (parts.some(p => p === '..')) {
    throw new Error(`Invalid task file path ${shown}: '..' would escape the worktree.`);
  }
  if (parts.some(p => p === '' || p === '.')) {
    throw new Error(`Invalid task file path ${shown}: empty or '.' segments are not allowed — write it as a plain relative path (e.g. config/.env).`);
  }
  const first = parts[0].toLowerCase();
  if (first === '.lazy' || first === '.lazy-task-sandbox' || first === '.lazy-lock') {
    throw new Error(`Invalid task file path ${shown}: '${parts[0]}' is lazy's own state.`);
  }
  if (parts.some(p => p.toLowerCase() === '.git')) {
    throw new Error(`Invalid task file path ${shown}: paths at or under .git are git's own state.`);
  }
  return parts.join('/');
}

/** Decode, validate and cap a whole set. Throws on the first problem. */
export function normalizeTaskFiles(files: unknown, taskId: string): Record<string, string> {
  if (!Array.isArray(files)) throw new Error(`'files' must be an array of { path, contents }.`);
  if (files.length > MAX_FILES_PER_TASK) {
    throw new Error(`Task ${taskId} would have ${files.length} files (limit ${MAX_FILES_PER_TASK}).`);
  }
  const out: Record<string, string> = {};
  const lower = new Map<string, string>();
  let total = 0;
  for (const raw of files as TaskFileInput[]) {
    if (!raw || typeof raw !== 'object') throw new Error(`Each file must be an object { path, contents }.`);
    const path = validateTaskFilePath(raw.path);
    const hasText = typeof raw.contents === 'string';
    const hasB64 = typeof raw.contentsBase64 === 'string';
    if (hasText === hasB64) {
      throw new Error(`File ${JSON.stringify(path)}: give exactly one of 'contents' (UTF-8) or 'contentsBase64'.`);
    }
    const buf = hasText ? Buffer.from(raw.contents!, 'utf-8') : Buffer.from(raw.contentsBase64!, 'base64');
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(`File ${JSON.stringify(path)} is ${buf.length} bytes (limit ${MAX_FILE_BYTES}).`);
    }
    total += buf.length;
    // Duplicates, including ones only case differs on (one file on a
    // case-insensitive filesystem, two entries in the registry), and a path
    // that is another one's parent directory.
    const key = path.toLowerCase();
    if (lower.has(key)) {
      throw new Error(`File path ${JSON.stringify(path)} is given twice (as ${JSON.stringify(lower.get(key))}).`);
    }
    for (const other of lower.keys()) {
      if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) {
        throw new Error(`File paths ${JSON.stringify(lower.get(other))} and ${JSON.stringify(path)} conflict: one is inside the other.`);
      }
    }
    lower.set(key, path);
    out[path] = buf.toString('base64');
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`Task ${taskId}'s files would total ${total} bytes (limit ${MAX_TOTAL_BYTES}).`);
  }
  return out;
}

/** A stored task entry is an object of base64 strings; anything else is dropped from that task alone. */
function wellFormedFiles(taskId: string, files: unknown): Record<string, string> | null {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    logger.error(`Per-task files registry: the entry for task ${taskId} is malformed; ignoring it.`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [path, b64] of Object.entries(files as Record<string, unknown>)) {
    if (typeof b64 !== 'string') {
      logger.error(`Per-task files registry: task ${taskId}'s ${JSON.stringify(path)} is malformed; ignoring it.`);
      continue;
    }
    out[path] = b64;
  }
  return out;
}

function wellFormedHistory(raw: unknown): Record<string, DeliveredHistory> {
  const out: Record<string, DeliveredHistory> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [taskId, h] of Object.entries(raw as Record<string, unknown>)) {
    const entry = h as { ref?: unknown; paths?: unknown } | null;
    if (!entry || typeof entry.paths !== 'object' || entry.paths === null) continue;
    const paths: Record<string, string[]> = {};
    for (const [path, blobs] of Object.entries(entry.paths as Record<string, unknown>)) {
      paths[path] = Array.isArray(blobs) ? blobs.filter((b): b is string => typeof b === 'string') : [];
    }
    out[taskId] = { ...(typeof entry.ref === 'string' ? { ref: entry.ref } : {}), paths };
  }
  return out;
}

async function loadRegistry(projectRoot: string): Promise<TaskFilesRegistry> {
  const path = getTaskFilesPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, tasks: {}, delivered: {}, retired: {} };
    throw new Error(`Failed to read per-task files registry ${path}: ${(err as Error).message}`);
  }
  let parsed: { tasks?: unknown; delivered?: unknown; retired?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (err) {
    throw new Error(
      `Per-task files registry ${path} is not valid JSON (${(err as Error).message}). ` +
      `Do not delete it: besides each task's files (which the control plane pushes again), it holds the only ` +
      `record of the paths ever delivered into task worktrees, which keeps them out of commits and pushes — ` +
      `restore it from a backup instead.`,
    );
  }
  if (!parsed || typeof parsed.tasks !== 'object' || parsed.tasks === null) {
    throw new Error(`Per-task files registry ${path} has an unexpected shape (expected { version, tasks: {} }).`);
  }
  const tasks: Record<string, Record<string, string>> = {};
  for (const [taskId, files] of Object.entries(parsed.tasks as Record<string, unknown>)) {
    const ok = wellFormedFiles(taskId, files);
    if (ok) tasks[taskId] = ok;
  }
  const retired: Record<string, Record<string, string>> = {};
  if (parsed.retired && typeof parsed.retired === 'object') {
    for (const [taskId, files] of Object.entries(parsed.retired as Record<string, unknown>)) {
      const ok = wellFormedFiles(taskId, files);
      if (ok) retired[taskId] = ok;
    }
  }
  const registry: TaskFilesRegistry = { version: 2, tasks, delivered: wellFormedHistory(parsed.delivered), retired };
  registerForRedaction(registry);
  return registry;
}

async function persist(projectRoot: string, registry: TaskFilesRegistry): Promise<void> {
  const path = getTaskFilesPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // Atomic: a torn registry would lose the history of delivered paths, which is
  // what keeps a delivered secret out of every commit and push.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, '', { mode: 0o600 });
  await writeFileAtomic(path, JSON.stringify(registry), tmp);
  registerForRedaction(registry);
}

let writeChain: Promise<unknown> = Promise.resolve();

async function mutate<T>(projectRoot: string, fn: (r: TaskFilesRegistry) => Promise<T> | T): Promise<T> {
  const run = writeChain.then(async () => fn(await loadRegistry(projectRoot)));
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * REPLACE a task's whole file set (the control plane sends the effective set).
 * An empty array clears it. Returns the stored paths, sorted — never contents.
 * Everything is validated BEFORE anything is written, the scrubber's cap
 * included: a set the scrubber would refuse is refused here, cleanly, rather
 * than stored where every later read would trip over it.
 */
export async function setTaskFiles(projectRoot: string, taskId: string, files: unknown): Promise<string[]> {
  const normalized = normalizeTaskFiles(files, taskId);
  assertScrubbable(taskId, normalized, {});
  return mutate(projectRoot, async registry => {
    retireDropped(registry, taskId, normalized);
    // The combined set the scrubber will hold: checked before anything is written.
    assertScrubbable(taskId, normalized, registry.retired[taskId] ?? {});
    if (Object.keys(normalized).length === 0) delete registry.tasks[taskId];
    else registry.tasks[taskId] = normalized;
    await persist(projectRoot, registry);
    return Object.keys(normalized).sort();
  });
}

function assertScrubbable(taskId: string, current: Record<string, string>, retired: Record<string, string>): void {
  try {
    assertRegistrableSecretValues(redactionSource(taskId), secretStringsForSet({ ...retired, ...current }));
  } catch (err) {
    throw new Error(
      `Task ${taskId}'s files hold too many distinct secret lines for lazy to scrub from logs and turns ` +
      `(limit ${MAX_REGISTERED_VALUES_PER_SOURCE} per task, counting files no longer selected but still in its worktree; ` +
      `${(err as Error).message}). Nothing was stored. Deliver fewer or smaller files.`,
    );
  }
}

/**
 * Before a task's set changes: a DELIVERED path leaving the set keeps its last
 * content in `retired` — the file stays in the worktree, so its content must
 * stay scrubbed. A path coming back into the set leaves `retired`. Bounded by
 * MAX_TOTAL_BYTES per task, oldest retirement dropped first (logged).
 */
function retireDropped(registry: TaskFilesRegistry, taskId: string, next: Record<string, string>): void {
  const delivered = registry.delivered[taskId]?.paths ?? {};
  const retired = { ...registry.retired[taskId] };
  for (const [path, b64] of Object.entries(registry.tasks[taskId] ?? {})) {
    if (next[path] === undefined && delivered[path]) {
      delete retired[path];
      retired[path] = b64;
    }
  }
  for (const path of Object.keys(next)) delete retired[path];
  let total = Object.values(retired).reduce((n, b64) => n + Buffer.from(b64, 'base64').length, 0);
  for (const path of Object.keys(retired)) {
    if (total <= MAX_TOTAL_BYTES) break;
    total -= Buffer.from(retired[path], 'base64').length;
    delete retired[path];
    logger.warn(`Task ${taskId}: no longer scrubbing the retired secret file ${path} (over ${MAX_TOTAL_BYTES} bytes of retired files).`);
  }
  if (Object.keys(retired).length > 0) registry.retired[taskId] = retired;
  else delete registry.retired[taskId];
}

/** Paths only, sorted. The read path for anything user-facing. */
export async function listTaskFilePaths(projectRoot: string, taskId: string): Promise<string[]> {
  const registry = await loadRegistry(projectRoot);
  return Object.keys(registry.tasks[taskId] ?? {}).sort();
}

/**
 * Stop delivering every file for one task. Returns how many were selected.
 * Idempotent. Deletes nothing in the worktree and keeps what was delivered
 * EXCLUDED, GUARDED and SCRUBBED — deselecting never re-exposes a path to git.
 */
export async function clearTaskFiles(projectRoot: string, taskId: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const count = Object.keys(registry.tasks[taskId] ?? {}).length;
    if (count === 0) return 0;
    retireDropped(registry, taskId, {});
    delete registry.tasks[taskId];
    await persist(projectRoot, registry);
    return count;
  });
}

/**
 * The task reached a terminal state: drop its files, its delivery record and
 * its retired contents. Returns how many files were selected. Idempotent.
 */
export async function forgetTaskFiles(projectRoot: string, taskId: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const count = Object.keys(registry.tasks[taskId] ?? {}).length;
    if (count === 0 && !registry.delivered[taskId] && !registry.retired[taskId]) return 0;
    delete registry.tasks[taskId];
    delete registry.delivered[taskId];
    delete registry.retired[taskId];
    await persist(projectRoot, registry);
    return count;
  });
}

/** Register every stored value with the scrubber. Called at daemon start. */
export async function primeTaskFilesRedaction(projectRoot: string): Promise<void> {
  await loadRegistry(projectRoot);
}

/** `{ path, blob }` for each of a task's files — what the accept guard compares. */
export async function taskFileBlobs(projectRoot: string, taskId: string): Promise<DeliveredFileEntry[]> {
  const registry = await loadRegistry(projectRoot);
  return Object.entries(registry.tasks[taskId] ?? {})
    .map(([path, b64]) => ({ path, blob: gitBlobId(Buffer.from(b64, 'base64')) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface TaskFilesDelivery {
  /** Paths written (or already holding the delivered content). */
  written: string[];
  /** Paths NOT written, each with the reason — shown to the human. */
  refused: Array<{ path: string; reason: string }>;
  /**
   * Delivered earlier, no longer selected, and still present in the worktree.
   * lazy leaves them in place (still excluded and guarded); a person may remove them.
   */
  retired: string[];
}

/**
 * The user's global excludes, which our `core.excludesFile` replaces for git
 * in this worktree (../git/delivered-files-exclude.ts). Empty when there is none.
 */
async function globalExcludesText(): Promise<string> {
  const configured = await runGit(['config', '--global', '--path', '--get', 'core.excludesFile']);
  const candidates = configured.exitCode === 0 && configured.stdout
    ? [configured.stdout]
    : [`${process.env.XDG_CONFIG_HOME || `${homedir()}/.config`}/git/ignore`];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Could not read the global git excludes file ${path}: ${(err as Error).message}`);
      }
    }
  }
  return '';
}

/** Paths the worktree's HEAD tracks at or under `path`. */
async function trackedAt(worktreePath: string, path: string): Promise<boolean> {
  const res = await runGit(['ls-files', '-z', '--', `:(literal)${path}`], { cwd: worktreePath });
  if (res.exitCode !== 0) throw new Error(`could not ask git whether ${path} is tracked: ${res.stderr}`);
  return res.stdout.length > 0;
}

/** True when a parent of `path` is a tracked FILE (writing would replace it with a directory). */
async function trackedParentFile(worktreePath: string, path: string): Promise<string | null> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    const res = await runGit(['ls-files', '-z', '--', `:(literal)${parent}`], { cwd: worktreePath });
    if (res.exitCode === 0 && res.stdout.split('\0').includes(parent)) return parent;
  }
  return null;
}

/**
 * Is it safe to write at `path`, where lazy has never delivered? Only when
 * nothing is there, a symlink is there (replaced, never followed — the link
 * holds no content of its own), or it already holds exactly `content`.
 * Returns the refusal reason, or null.
 */
async function untrackedObstacle(worktreePath: string, path: string, content: Buffer): Promise<string | null> {
  try {
    const existing = await readRegularFileUnder(worktreePath, path, MAX_FILE_BYTES);
    if (existing === null || existing.equals(content)) return null;
  } catch (err) {
    if (!(err instanceof LinkRefusedError)) throw err;
    const st = await lstat(join(worktreePath, path)).catch(() => null);
    if (st?.isSymbolicLink()) return null;
    if (!st || st.isFile()) return (err as Error).message;
  }
  return `an untracked file lazy did not deliver already exists at ${path}; lazy will not overwrite it with a secret — remove or rename it, then push the files again`;
}

/** Record `planned` as delivered to the task BEFORE any is written. Returns paths over the cap. */
async function recordDelivered(
  projectRoot: string,
  taskId: string,
  ref: string,
  planned: Array<{ path: string; blob: string }>,
): Promise<{ overCap: string[]; history: DeliveredHistory }> {
  return mutate(projectRoot, async registry => {
    const history: DeliveredHistory = registry.delivered[taskId] ?? { paths: {} };
    const overCap: string[] = [];
    let changed = history.ref !== ref;
    history.ref = ref;
    for (const d of planned) {
      const blobs = history.paths[d.path];
      if (!blobs && Object.keys(history.paths).length >= MAX_DELIVERED_PATHS_PER_TASK) {
        overCap.push(d.path);
        continue;
      }
      const list = blobs ?? [];
      if (!list.includes(d.blob)) {
        list.push(d.blob);
        while (list.length > MAX_BLOBS_PER_PATH) list.shift();
        changed = true;
      }
      if (!blobs) changed = true;
      history.paths[d.path] = list;
    }
    registry.delivered[taskId] = history;
    if (changed) await persist(projectRoot, registry);
    return { overCap, history: { ref: history.ref, paths: { ...history.paths } } };
  });
}

/**
 * Write a task's files into its worktree. Never throws for one bad path — each
 * is refused and reported; throws only when the registry itself cannot be read
 * (a launch must not run without files the task was promised, silently).
 * A no-op (no git, no writes) for a task with no files and nothing delivered before.
 * Never deletes anything: a retired path is left in place, still excluded.
 */
export async function deliverTaskFiles(
  projectRoot: string,
  taskId: string,
  worktreePath: string,
): Promise<TaskFilesDelivery> {
  const registry = await loadRegistry(projectRoot);
  const files = registry.tasks[taskId] ?? {};
  const before = registry.delivered[taskId]?.paths ?? {};
  const result: TaskFilesDelivery = { written: [], refused: [], retired: [] };
  if (Object.keys(files).length === 0 && Object.keys(before).length === 0) return result;

  // 1. Decide which paths may be delivered: never one the branch tracks, nor
  // an untracked file lazy did not put there.
  const planned: Array<{ path: string; content: Buffer; blob: string }> = [];
  for (const [path, b64] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const content = Buffer.from(b64, 'base64');
    if (unscrubbable.has(taskId)) {
      result.refused.push({ path, reason: `the task's files cannot be scrubbed from logs and turns (too many distinct secret lines); push a smaller set` });
      continue;
    }
    try {
      if (await trackedAt(worktreePath, path)) {
        result.refused.push({ path, reason: `the task's branch tracks a file at ${path}; lazy will not overwrite it with a secret` });
        continue;
      }
      const parentFile = await trackedParentFile(worktreePath, path);
      if (parentFile) {
        result.refused.push({ path, reason: `the task's branch tracks ${parentFile} as a file` });
        continue;
      }
      if (!before[path]) {
        const obstacle = await untrackedObstacle(worktreePath, path, content);
        if (obstacle) {
          result.refused.push({ path, reason: obstacle });
          continue;
        }
      }
      planned.push({ path, content, blob: gitBlobId(content) });
    } catch (err) {
      result.refused.push({ path, reason: (err as Error).message });
    }
  }

  // 2. The daemon's record, then the exclude list, BEFORE any secret: a secret
  // on disk that git does not ignore and no guard recognises is exactly the
  // state this feature must never leave behind. If either cannot be written,
  // no secret is. The exclude list carries EVERY path ever delivered, retired
  // ones included. A planned path whose write then fails stays recorded —
  // guarding a path that holds nothing is harmless.
  let history: DeliveredHistory = { paths: { ...before } };
  if (planned.length > 0) {
    try {
      const recorded = await recordDelivered(projectRoot, taskId, basename(worktreePath), planned);
      history = recorded.history;
      for (const path of recorded.overCap) {
        result.refused.push({ path, reason: `the task has already been given ${MAX_DELIVERED_PATHS_PER_TASK} distinct secret file paths` });
      }
      const over = new Set(recorded.overCap);
      for (let i = planned.length - 1; i >= 0; i--) if (over.has(planned[i].path)) planned.splice(i, 1);
    } catch (err) {
      const reason = `could not record the delivery in the daemon's registry: ${(err as Error).message}`;
      for (const d of planned) result.refused.push({ path: d.path, reason });
      planned.length = 0;
    }
  }
  const everDelivered = Object.keys(history.paths).sort();
  const owner = await worktreeOwnerForRootDaemon(worktreePath);
  if (everDelivered.length > 0) {
    try {
      const globals = await globalExcludesText();
      const exclude =
        (globals ? `${globals.replace(/\n?$/, '\n')}` : '') +
        `# Per-task secret files delivered by lazy — never commit these.\n` +
        everDelivered.map(p => `${excludeLineFor(p)}\n`).join('');
      await writeUnlessHeld(worktreePath, DELIVERED_FILES_EXCLUDE_REL, exclude, 0o644, owner);
      // Convenience copy only — agent-writable, read by no guard.
      await writeUnlessHeld(worktreePath, DELIVERED_FILES_MANIFEST_REL,
        JSON.stringify({ files: everDelivered.flatMap(path => history.paths[path].map(blob => ({ path, blob }))) }), 0o600, owner);
    } catch (err) {
      const reason = `could not write the git exclude list that keeps it out of commits: ${(err as Error).message}`;
      for (const d of planned) result.refused.push({ path: d.path, reason });
      planned.length = 0;
    }
  }

  // 3. The files themselves — only those whose content changed (see the
  // header: an unchanged file is never replaced under a running service).
  for (const d of planned) {
    try {
      await writeUnlessHeld(worktreePath, d.path, d.content, 0o600, owner);
      result.written.push(d.path);
    } catch (err) {
      result.refused.push({ path: d.path, reason: (err as Error).message });
    }
  }

  // 4. Retired paths: reported, never removed.
  result.retired = await presentRetired(worktreePath, everDelivered, files);
  result.refused.sort((x, y) => x.path.localeCompare(y.path));
  for (const r of result.refused) logger.warn(`Task ${taskId}: secret file ${r.path} not delivered — ${r.reason}`);
  return result;
}

/**
 * Write `data` at `rel` through the link-safe writer, unless the path already
 * holds exactly that (regularFileHolds) — then nothing is touched at all.
 * Returns whether it wrote.
 */
async function writeUnlessHeld(
  worktreePath: string,
  rel: string,
  data: string | Buffer,
  mode: number,
  owner: { uid: number; gid: number } | undefined,
): Promise<boolean> {
  if (await regularFileHolds(worktreePath, rel, data, mode, owner)) return false;
  await writeRegularFileUnder(worktreePath, rel, data, mode, false, owner);
  return true;
}

/**
 * Who a ROOT daemon's writes into this worktree must belong to: its owner,
 * once the container user adopted it (../utils/worktree-ownership.ts). Undefined
 * for a daemon that is not root, or a worktree root still owns — nothing to hand
 * over, exactly as realignAfterDaemonWrite decides.
 */
async function worktreeOwnerForRootDaemon(worktreePath: string): Promise<{ uid: number; gid: number } | undefined> {
  if (process.getuid?.() !== 0) return undefined;
  const st = await stat(worktreePath);
  return st.uid === 0 ? undefined : { uid: st.uid, gid: st.gid };
}

async function presentRetired(worktreePath: string, everDelivered: string[], files: Record<string, string>): Promise<string[]> {
  const out: string[] = [];
  for (const path of everDelivered) {
    if (files[path] !== undefined) continue;
    if (await lstat(join(worktreePath, path)).then(() => true, () => false)) out.push(path);
  }
  return out;
}

/**
 * Paths delivered to the task earlier, no longer selected, and still in its
 * worktree — for the task page, so a person can remove them if they want.
 */
export async function retiredTaskFilePaths(projectRoot: string, taskId: string, worktreePath: string): Promise<string[]> {
  const registry = await loadRegistry(projectRoot);
  const everDelivered = Object.keys(registry.delivered[taskId]?.paths ?? {}).sort();
  return presentRetired(worktreePath, everDelivered, registry.tasks[taskId] ?? {});
}

/**
 * One line for launch narration, or null when there is nothing to say. Paths
 * only. Refusals are what a person needs to see (the file their task was
 * promised is not there).
 */
export function describeTaskFilesDelivery(d: TaskFilesDelivery): string | null {
  if (d.refused.length > 0) {
    return `secret files: ${d.written.length} delivered; NOT delivered: ` +
      d.refused.map(r => `${r.path} (${r.reason})`).join('; ');
  }
  return d.written.length > 0 ? `secret files delivered: ${d.written.join(', ')}` : null;
}

/**
 * The launch-path form: deliver, narrate what a person must know through the
 * launch's phase sink, and never fail the launch — a turn the human already
 * gave feedback for must not be lost to a secret-file problem. A registry that
 * cannot be read is logged at error level and narrated, so it is loud.
 */
export async function deliverTaskFilesForLaunch(
  projectRoot: string,
  taskId: string,
  worktreePath: string,
  notify?: (message: string) => void,
): Promise<TaskFilesDelivery | null> {
  try {
    const delivery = await deliverTaskFiles(projectRoot, taskId, worktreePath);
    const line = describeTaskFilesDelivery(delivery);
    if (line && delivery.refused.length > 0) notify?.(line);
    else if (line) logger.debug(`Task ${taskId}: ${line}`);
    return delivery;
  } catch (err) {
    const message = `secret files could NOT be delivered: ${(err as Error).message}`;
    logger.error(`Task ${taskId}: ${message}`);
    notify?.(message);
    return null;
  }
}

/** What every delivered-files guard compares against (../git/delivered-files.ts). */
export interface DeliveredGuard {
  /** Content guard: every task's current files and everything ever delivered to any task. */
  entries: DeliveredFileEntry[];
  /** Path guard: every path ever delivered to THIS task, whatever it holds now. */
  paths: string[];
}

/**
 * The guard for one task, identified by its id and/or its worktree ref (a push
 * knows only the branch). Read from the daemon's registry ALONE — never from
 * the agent-writable manifest in the worktree.
 */
export async function deliveredGuardFor(
  projectRoot: string,
  who: { taskId?: string | null; ref?: string | null },
): Promise<DeliveredGuard> {
  const registry = await loadRegistry(projectRoot);
  const byKey = new Map<string, DeliveredFileEntry>();
  const add = (path: string, blob: string) => byKey.set(`${path}\0${blob}`, { path, blob });
  for (const files of Object.values(registry.tasks)) {
    for (const [path, b64] of Object.entries(files)) add(path, gitBlobId(Buffer.from(b64, 'base64')));
  }
  const paths = new Set<string>();
  for (const [taskId, history] of Object.entries(registry.delivered)) {
    const mine = (who.taskId && taskId === who.taskId) || (who.ref && history.ref === who.ref);
    for (const [path, blobs] of Object.entries(history.paths)) {
      for (const blob of blobs) add(path, blob);
      if (mine) paths.add(path);
    }
  }
  return { entries: [...byKey.values()], paths: [...paths].sort() };
}

/**
 * Delivered files a push of `branch` would publish: in a commit reachable from
 * the branch and from no remote-tracking ref. FAILS CLOSED — an unreadable
 * registry or a failing git answer is reported as a hit, because a push is
 * what cannot be undone. Empty when nothing was ever delivered.
 */
export async function deliveredSecretsToPush(projectRoot: string, branch: string): Promise<string[]> {
  const ref = taskRefFromBranch(branch);
  const worktree = getWorktreePathForRef(projectRoot, ref);
  const hasWorktree = await pathExists(worktree);
  let guard: DeliveredGuard;
  try {
    guard = await deliveredGuardFor(projectRoot, { ref });
  } catch (err) {
    logger.error(`Cannot check ${branch} for delivered secret files: ${(err as Error).message}`);
    return ['(delivered-files registry unreadable)'];
  }
  if (guard.entries.length === 0 && guard.paths.length === 0) return [];
  try {
    return await findDeliveredFilesInRange(hasWorktree ? worktree : projectRoot, `refs/heads/${branch}`, ['--not', '--remotes'], guard.entries, guard.paths);
  } catch (err) {
    logger.error(`Cannot check ${branch} for delivered secret files: ${(err as Error).message}`);
    return [...new Set([...guard.entries.map(e => e.path), ...guard.paths])].sort();
  }
}

/** Throw before pushing `branch` when it would publish a delivered file. `where` names the operation. */
export async function assertNoDeliveredSecretsToPush(projectRoot: string, branch: string, where: string): Promise<void> {
  const found = await deliveredSecretsToPush(projectRoot, branch);
  if (found.length === 0) return;
  throw new Error(
    deliveredFilesRefusal(where, found) +
    `A commit on ${branch} carries one, so the branch was NOT pushed. Remove that commit from the branch, then try again.`,
  );
}

/** Task metadata: the paths last reported by noteDeliveredSecretsInSession (dedupe). */
export const DELIVERED_SECRET_NOTICE_KEY = 'delivered_secret_notice';

/**
 * Record time: when a delivered file's content is in a commit this session
 * made, say so ON THE TASK — one `system` comment naming the paths (never the
 * content) — instead of leaving the first sign to a refused push or accept.
 * Written once per distinct set of offending paths (task metadata), and the
 * marker is cleared once the branch is clean, so a recurrence is reported
 * again. A comment starts no turn; it reaches the agent with the next unblock.
 * Never throws: a failure here must not break recording the turn.
 */
export async function noteDeliveredSecretsInSession(
  storage: Pick<Storage, 'createComment' | 'getTaskMetadata' | 'updateTaskMetadata'>,
  projectRoot: string,
  taskId: string,
  worktreePath: string,
  startSha: string | null | undefined,
  /** Rev-list exclusions for what is already on the parent branch (deliveredFilesUpstreamExclude). */
  upstreamExclude: string[] = [],
): Promise<void> {
  try {
    const guard = await deliveredGuardFor(projectRoot, { taskId, ref: basename(worktreePath) });
    if (guard.entries.length === 0 && guard.paths.length === 0) return;
    const found = startSha
      ? await findDeliveredFilesInRange(worktreePath, 'HEAD', [`^${startSha}`, ...upstreamExclude], guard.entries, guard.paths)
      : await findDeliveredFilesAtRef(worktreePath, 'HEAD', guard.entries, guard.paths);
    const key = found.join('\n');
    const previous = (await storage.getTaskMetadata(taskId, DELIVERED_SECRET_NOTICE_KEY)) ?? '';
    if (key === previous) return;
    await storage.updateTaskMetadata(taskId, DELIVERED_SECRET_NOTICE_KEY, key);
    if (found.length === 0) return;
    await storage.createComment(
      taskId,
      deliveredFilesRefusal('[Secret file committed] This branch', found).replace(' refused:', ':') +
      `A commit on the task's branch carries ${found.length === 1 ? 'it' : 'them'}, so lazy will not push the branch and accept will refuse it. ` +
      `Remove ${found.length === 1 ? 'the file' : 'the files'} from the branch's history (drop or amend the commit that added ${found.length === 1 ? 'it' : 'them'}).`,
      'system',
    );
  } catch (err) {
    logger.error(`Task ${taskId}: could not check its commits for delivered secret files: ${(err as Error).message}`);
  }
}
