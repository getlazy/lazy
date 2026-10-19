/**
 * The backstop for delivered per-task files (src/daemon/task-files.ts): a
 * delivered file that reaches the index or a commit despite the exclusion
 * (src/git/delivered-files-exclude.ts) — `git add -f`, an agent that unset its
 * env — is REFUSED, never silently shipped.
 *
 * Recognition is two-fold:
 *  - by CONTENT (`entries`): git holding exactly bytes the daemon delivered, at
 *    the delivered path (index, tip) or anywhere in history (a rename does not
 *    hide a blob id) — across every task, since no delivered secret may reach
 *    origin from any branch;
 *  - by PATH (`paths`): the task's OWN ever-delivered paths, whatever their
 *    content. A delivered file that was edited or deselected is still the
 *    secret's home; matching only exact bytes let an edited `.env` through.
 *
 * Callers take both from the daemon's registry (`deliveredGuardFor`), never
 * from the agent-writable manifest in the worktree.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { runGit } from '../utils/git';
import { DELIVERED_FILES_MANIFEST_REL, type DeliveredFileEntry } from './delivered-files-exclude';

/**
 * The worktree's manifest of delivered files; empty when there is none.
 * A CONVENIENCE copy for tooling inside the container — agent-writable, so no
 * guard and no deletion may rely on it.
 */
export async function readDeliveredManifest(worktreePath: string): Promise<DeliveredFileEntry[]> {
  const path = join(worktreePath, DELIVERED_FILES_MANIFEST_REL);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`failed to read delivered-files manifest ${path}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(parsed.files)) throw new Error('expected { files: [...] }');
    return parsed.files.filter((f): f is DeliveredFileEntry =>
      !!f && typeof (f as DeliveredFileEntry).path === 'string' && typeof (f as DeliveredFileEntry).blob === 'string');
  } catch (err) {
    throw new Error(`delivered-files manifest ${path} does not parse: ${(err as Error).message}`);
  }
}

function literal(path: string): string {
  return `:(literal)${path}`;
}

function uniqueSorted(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').map(s => s.replace(/^\n+/, '')).filter(Boolean);
}

/**
 * Delivered paths STAGED in the index: an entry's delivered content at its
 * path, or any added/modified content at one of `paths` (the task's own
 * delivered paths — guarded by path whatever the bytes).
 */
export async function findDeliveredFilesStaged(
  worktreePath: string,
  entries: DeliveredFileEntry[],
  paths: string[] = [],
): Promise<string[]> {
  let byContent: string[] = [];
  if (entries.length > 0) {
    const res = await runGit(['ls-files', '-s', '-z', '--', ...entries.map(e => literal(e.path))], { cwd: worktreePath });
    if (res.exitCode !== 0) {
      throw new Error(`could not read the index of ${worktreePath} to check delivered files: ${res.stderr}`);
    }
    byContent = matchListing(res.stdout, entries);
  }
  let byPath: string[] = [];
  if (paths.length > 0) {
    const res = await runGit(
      ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', '--', ...paths.map(literal)],
      { cwd: worktreePath },
    );
    if (res.exitCode !== 0) {
      throw new Error(`could not read the index of ${worktreePath} to check delivered files: ${res.stderr}`);
    }
    byPath = nulList(res.stdout);
  }
  return uniqueSorted(byContent, byPath);
}

/** Delivered paths in the tree of `ref`: an entry's delivered content, or anything at one of `paths`. */
export async function findDeliveredFilesAtRef(
  worktreePath: string,
  ref: string,
  entries: DeliveredFileEntry[],
  paths: string[] = [],
): Promise<string[]> {
  if (entries.length === 0 && paths.length === 0) return [];
  const all = [...entries.map(e => e.path), ...paths];
  const res = await runGit(['ls-tree', '-r', '-z', ref, '--', ...all.map(literal)], { cwd: worktreePath });
  if (res.exitCode !== 0) {
    throw new Error(`could not read ${ref} in ${worktreePath} to check delivered files: ${res.stderr}`);
  }
  const guarded = new Set(paths);
  const present = res.stdout.split('\0').map(r => r.slice(r.indexOf('\t') + 1)).filter(p => guarded.has(p));
  return uniqueSorted(matchListing(res.stdout, entries), present);
}

/** `ls-files -s` (`mode sha stage\tpath`) and `ls-tree` (`mode type sha\tpath`) alike. */
function matchListing(stdout: string, entries: DeliveredFileEntry[]): string[] {
  const blobs = new Map<string, Set<string>>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    const ids = record.slice(0, tab).split(' ').filter(s => /^[0-9a-f]{40,64}$/.test(s));
    const set = blobs.get(path) ?? new Set<string>();
    ids.forEach(id => set.add(id));
    blobs.set(path, set);
  }
  return entries.filter(e => blobs.get(e.path)?.has(e.blob)).map(e => e.path).sort();
}

/** The refusal text shared by every guard, naming the paths and never their content. */
export function deliveredFilesRefusal(where: string, paths: string[]): string {
  return (
    `${where} refused: ${paths.join(', ')} ${paths.length === 1 ? 'is a' : 'are'} per-task secret ` +
    `file${paths.length === 1 ? '' : 's'} delivered by lazy and must never be committed or pushed. `
  );
}

/**
 * Delivered files in ANY commit reachable from `head` but not from `exclude`
 * (rev-list arguments: `['^<sha>']`, or `['--not', '--remotes']` for "not yet
 * pushed") — not only the tip: a secret committed and then deleted is still in
 * the branch's history, which is what reaches origin. An entry matches by blob
 * id, so a rename does not hide it; a guarded `path` matches when any commit in
 * the range adds or modifies it, whatever the content.
 */
export async function findDeliveredFilesInRange(
  worktreePath: string,
  head: string,
  exclude: string[],
  entries: DeliveredFileEntry[],
  paths: string[] = [],
): Promise<string[]> {
  let byContent: string[] = [];
  if (entries.length > 0) {
    const res = await runGit(['rev-list', '--objects', head, ...exclude], { cwd: worktreePath });
    if (res.exitCode !== 0) {
      throw new Error(`could not list the commits of ${head} in ${worktreePath} to check delivered files: ${res.stderr}`);
    }
    const ids = new Set(res.stdout.split('\n').map(line => line.split(' ')[0]).filter(Boolean));
    byContent = entries.filter(e => ids.has(e.blob)).map(e => e.path);
  }
  let byPath: string[] = [];
  if (paths.length > 0) {
    const res = await runGit(
      // `-c` (combined): a merge's own resolution — a path differing from EVERY
      // parent — is listed, or an edited secret added while resolving a merge
      // would pass unseen. Not `-m`, which also lists a file taken cleanly from
      // one parent and so blames a sync merge for an upstream commit's file.
      ['log', '-c', '--format=', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', head, ...exclude, '--', ...paths.map(literal)],
      { cwd: worktreePath },
    );
    if (res.exitCode !== 0) {
      throw new Error(`could not list the commits of ${head} in ${worktreePath} to check delivered files: ${res.stderr}`);
    }
    byPath = nulList(res.stdout);
  }
  return uniqueSorted(byContent, byPath);
}
