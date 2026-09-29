/**
 * NESTED repositories planted inside a task worktree — found, reported and
 * quarantined without ever running git inside them.
 *
 * The pointer boundary (./worktree-pointers.ts) protects the git that runs at
 * a worktree's ROOT. A task can instead create `<worktree>/<sub>/.git/` — a
 * directory, not a pointer — whose `config` sets `core.fsmonitor`,
 * `core.hooksPath`, `core.sshCommand` or a filter driver. A human who cds into
 * `<sub>` and runs git, or an IDE that scans a freshly opened folder for
 * nested repositories, executes that config with the human's own credentials.
 * The same holds for a `.git` FILE (a pointer to a directory anywhere), for a
 * bare-repository-shaped directory (git discovers one by its contents alone),
 * and for a symbolic link whose target is either.
 *
 * lazy's OWN git at the worktree root reaches a nested repository too, once it
 * is staged as a gitlink: git asks the submodule whether it is dirty by running
 * `git status` inside it. `runGit` therefore passes `diff.ignoreSubmodules=dirty`
 * and `core.fsmonitor=false` in task worktrees (see `taskWorktreeGitEnv` in ../utils/git.ts),
 * and `lazy_commit` refuses to stage while a finding is present — `git add`
 * asks the submodule regardless of that setting.
 *
 * What is legitimate is decided by the BASE branch, never by the worktree:
 * a submodule path listed in the base's `.gitmodules`, whose `.git` is the
 * pointer file `git submodule` writes (into the project's own
 * `modules/` directory), and a bare-shaped fixture the base tracks whose
 * `config`, `commondir` and hooks are byte-identical to the base's. The
 * worktree's own `.gitmodules` is task-writable and is not read.
 *
 * Quarantine never deletes: the planted entry is evidence, and could hold
 * somebody's real work. `.git` becomes `.git.lazy-quarantine-<n>` and, when it
 * is a directory, its `HEAD` is renamed the same way (a renamed git dir is
 * still a bare repository to a git run INSIDE it); a bare-shaped directory
 * loses its `HEAD` the same way; a symbolic link is moved out of the worktree
 * into the project's data dir. Nothing is skipped by NAME — a quarantined entry
 * is simply no longer shaped like a repository.
 */

import { lstat, mkdir, readdir, readFile, realpath, rename, stat } from 'fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { runGit } from '../utils/git';
import { getDataDir } from '../project-paths';
import { getBranchNameFromId, getWorktreePath } from '../task/identity';
import { integrationBranchOf, parentTaskIdOf } from '../task-target';
import { getRemoteDefaultBranch } from './operations';
import { loadConfig } from '../config/loader';
import { resolveProjectCommonDir } from './worktree-pointers';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';

export const QUARANTINE_INFIX = '.lazy-quarantine-';

export interface NestedGitFinding {
  /** Path relative to the worktree, `/`-separated — what a human reads. */
  rel: string;
  /** Absolute path of the entry quarantine moves. */
  path: string;
  kind: 'git-dir' | 'git-file' | 'git-symlink' | 'bare-repo' | 'symlink-to-repo';
}

/** Reads a file from the base branch's tree; null when the base has no such file. */
export type BaseFileReader = (relPath: string) => Promise<string | null>;

/**
 * A {@link BaseFileReader} over `ref` in the project's repository (git runs at
 * the PROJECT ROOT, never in a worktree). The ref is verified once: a ref that
 * does not resolve would read as "the base has no such file" and flag every
 * legitimate submodule, so it is an error naming the ref instead.
 */
export function baseFileReader(projectRoot: string, ref: string): BaseFileReader {
  const cache = new Map<string, Promise<string | null>>();
  let verified: Promise<void> | null = null;
  return async (relPath) => {
    verified ??= runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: projectRoot }).then(r => {
      if (r.exitCode !== 0) throw new Error(`the base ref ${ref} does not resolve to a commit in ${projectRoot}`);
    });
    await verified;
    let hit = cache.get(relPath);
    if (!hit) {
      hit = runGit(['cat-file', 'blob', `${ref}:${relPath}`], { cwd: projectRoot, trim: false })
        .then(r => (r.exitCode === 0 ? r.stdout : null));
      cache.set(relPath, hit);
    }
    return hit;
  };
}

/** Submodule paths from a `.gitmodules` text (the `path =` keys). */
export function submodulePaths(gitmodules: string | null): Set<string> {
  const out = new Set<string>();
  if (!gitmodules) return out;
  for (const line of gitmodules.split(/\r?\n/)) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let p = m[1];
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    out.add(p.replace(/\/+$/, ''));
  }
  return out;
}

/** git on a case-insensitive filesystem (a macOS host) finds `.GIT` too — match it however it is spelled. */
const isDotGit = (name: string) => name.toLowerCase() === '.git';

/** The entry of `names` that is `want` case-insensitively, if any. */
function named(names: string[], want: string): string | undefined {
  return names.find(n => n === want) ?? names.find(n => n.toLowerCase() === want.toLowerCase());
}

/** A file git would read as one — a regular file, or a link to one (git accepts a symlinked HEAD). */
async function fileFollowing(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
/** A directory git would use as one — it follows links for objects/ and refs/. */
async function dirFollowing(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}
async function isDir(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isDirectory() ?? false;
}

/** git's own test for "this directory is a git dir": HEAD, plus objects+refs or a commondir. */
async function looksLikeGitDir(dir: string, names: string[]): Promise<boolean> {
  const head = named(names, 'HEAD');
  if (!head || !(await fileFollowing(join(dir, head)))) return false;
  const commondir = named(names, 'commondir');
  if (commondir && (await fileFollowing(join(dir, commondir)))) return true;
  const objects = named(names, 'objects');
  const refs = named(names, 'refs');
  return !!objects && !!refs && (await dirFollowing(join(dir, objects))) && (await dirFollowing(join(dir, refs)));
}

export interface ScanOptions {
  /** The project's shared git dir (realpath) — where a legitimate submodule's gitdir lives. */
  commonDir: string;
}

/**
 * Every nested repository in `worktreePath` the base does not account for.
 * Reads directory entries, a few small files and, for a symbolic link to a
 * directory, that directory's entry list; never walks through a link and never
 * runs git below the worktree.
 */
export async function scanNestedGitDirs(worktreePath: string, readBase: BaseFileReader, opts: ScanOptions): Promise<NestedGitFinding[]> {
  const submodules = submodulePaths(await readBase('.gitmodules'));
  const findings: NestedGitFinding[] = [];
  const toRel = (p: string) => relative(worktreePath, p).split(sep).join('/');

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that vanished mid-walk is not a finding; anything else is
      // a scan that could not answer, and must not read as "clean".
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const names = entries.map(e => e.name);
    const relDir = toRel(dir);

    if (dir !== worktreePath && (await looksLikeGitDir(dir, names))) {
      if (!(await legitimateBareFixture(dir, relDir, names, readBase))) {
        findings.push({ rel: relDir, path: join(dir, named(names, 'HEAD')!), kind: 'bare-repo' });
      }
      return; // a git dir's own contents are not a working tree
    }

    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (isDotGit(e.name)) {
        // The worktree's own pointer — ./worktree-pointers.ts guards it.
        if (dir === worktreePath && e.name === '.git') continue;
        if (submodules.has(relDir) && e.isFile() && (await isSubmoduleGitFile(full, opts.commonDir))) continue;
        const kind = e.isSymbolicLink() ? 'git-symlink' : e.isDirectory() ? 'git-dir' : 'git-file';
        findings.push({ rel, path: full, kind });
        continue;
      }
      if (e.isSymbolicLink()) {
        if (await linkLeadsToRepo(full)) findings.push({ rel, path: full, kind: 'symlink-to-repo' });
        continue;
      }
      if (e.isDirectory()) await walk(full);
    }
  };

  await walk(worktreePath);
  return findings;
}

/**
 * A symbolic link whose target directory is itself a git dir, or holds a
 * `.git` — `cd link && git status` (or an IDE following it) runs that repo's
 * config. One level only: the target is not walked.
 */
async function linkLeadsToRepo(link: string): Promise<boolean> {
  if (!(await dirFollowing(link))) return false;
  const names = await readdir(link).catch(() => [] as string[]);
  return names.some(isDotGit) || (await looksLikeGitDir(link, names));
}

/**
 * The `.git` FILE `git submodule` writes: `gitdir: <path>` resolving inside the
 * project's own git dir, under `modules/` or `worktrees/<id>/modules/`.
 * Anything else at a submodule path — a directory, a link, a pointer elsewhere
 * — is treated like any planted repository.
 */
async function isSubmoduleGitFile(path: string, commonDir: string): Promise<boolean> {
  const text = await readFile(path, 'utf8').catch(() => null);
  const m = text === null ? null : /^gitdir: (.+?)\r?\n?$/.exec(text);
  if (!m) return false;
  const target = await realpath(isAbsolute(m[1]) ? m[1] : join(dirname(path), m[1])).catch(() => null);
  if (!target || !(await isDir(target))) return false;
  const rel = relative(commonDir, target).split(sep);
  if (rel[0] === '..' || isAbsolute(rel.join('/'))) return false;
  return (rel[0] === 'modules' && rel.length > 1) || (rel[0] === 'worktrees' && rel[2] === 'modules' && rel.length > 3);
}

/**
 * A bare-shaped fixture the base tracks, unchanged where it matters: `HEAD`
 * tracked, and `config`, `commondir` and every file under `hooks/` identical
 * to the base (a missing file only matches a file the base lacks too).
 */
async function legitimateBareFixture(dir: string, relDir: string, names: string[], readBase: BaseFileReader): Promise<boolean> {
  if ((await readBase(`${relDir}/HEAD`)) === null) return false;
  const same = async (name: string) => {
    const ours = await readFile(join(dir, name), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    return ours === (await readBase(`${relDir}/${name}`));
  };
  if (!(await same('config')) || !(await same('commondir'))) return false;
  // A differently-cased twin of any of those is a file git may read instead.
  for (const want of ['config', 'commondir', 'hooks']) {
    if (names.some(n => n !== want && n.toLowerCase() === want)) return false;
  }
  if (!names.includes('hooks')) return true;
  const hooks = join(dir, 'hooks');
  if ((await lstat(hooks)).isSymbolicLink()) return false;
  for (const h of await readdir(hooks, { withFileTypes: true })) {
    if (!h.isFile()) return false;
    if (!(await same(`hooks/${h.name}`))) return false;
  }
  return true;
}

async function freeName(base: string): Promise<string> {
  let n = 1;
  while (await lstat(`${base}${QUARANTINE_INFIX}${n}`).then(() => true, () => false)) n++;
  return `${base}${QUARANTINE_INFIX}${n}`;
}

/**
 * Move each finding aside (never delete). Returns where each went. A git dir
 * also has its HEAD renamed, a symbolic link is moved out of the worktree into
 * `linkQuarantineDir` (a link renamed in place would still lead to the repo).
 */
export async function quarantineNestedGit(
  findings: NestedGitFinding[],
  linkQuarantineDir: string,
): Promise<Array<{ finding: NestedGitFinding; movedTo: string }>> {
  const out: Array<{ finding: NestedGitFinding; movedTo: string }> = [];
  for (const f of findings) {
    let target: string;
    if (f.kind === 'git-symlink' || f.kind === 'symlink-to-repo') {
      await mkdir(linkQuarantineDir, { recursive: true });
      target = await freeName(join(linkQuarantineDir, f.rel.replace(/\//g, '__')));
    } else {
      target = await freeName(f.path);
    }
    await rename(f.path, target);
    if (f.kind === 'git-dir') {
      const names = await readdir(target).catch(() => [] as string[]);
      const head = named(names, 'HEAD');
      if (head) await rename(join(target, head), await freeName(join(target, head)));
    }
    out.push({ finding: f, movedTo: target });
  }
  return out;
}

/** Where a worktree's quarantined symbolic links go: under the data dir, outside every worktree. */
export function linkQuarantineDirFor(projectRoot: string, worktreeName: string): string {
  return join(projectRoot, getDataDir(projectRoot), 'nested-git-quarantine', worktreeName);
}

/** One line naming the findings (at most `max`), for refusals and doctor. */
export function describeNestedGit(findings: NestedGitFinding[], max = 20): string {
  const kinds: Record<NestedGitFinding['kind'], string> = {
    'git-dir': 'repository',
    'git-file': 'git pointer file',
    'git-symlink': 'git symlink',
    'bare-repo': 'bare repository',
    'symlink-to-repo': 'symlink to a repository',
  };
  const shown = findings.slice(0, max).map(f => `${f.rel} (${kinds[f.kind]})`).join(', ');
  return findings.length > max ? `${shown} …and ${findings.length - max} more` : shown;
}

/**
 * The ref whose tree decides what is legitimate for `task`: its parent task's
 * branch, its integration branch, else the repository's default branch —
 * never whatever the project root happens to have checked out.
 */
export async function nestedGitBaseRef(projectRoot: string, storage: Storage, task: Task | null): Promise<string> {
  const parentId = task ? parentTaskIdOf(task) : null;
  if (parentId) return getBranchNameFromId(parentId, storage);
  const integration = task ? integrationBranchOf(task) : undefined;
  if (integration) return integration;
  const config = await loadConfig(projectRoot);
  return getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
}

/** Everything one worktree's scan needs, resolved from the task. */
export async function scanTaskWorktreeNestedGit(projectRoot: string, storage: Storage, task: Task | null, worktreePath: string): Promise<NestedGitFinding[]> {
  const ref = await nestedGitBaseRef(projectRoot, storage, task);
  const commonDir = await resolveProjectCommonDir(projectRoot);
  return scanNestedGitDirs(worktreePath, baseFileReader(projectRoot, ref), { commonDir });
}

export interface NestedGitWorktreeReport {
  name: string;
  path: string;
  task: Task | null;
  findings: NestedGitFinding[];
  /** Set when the scan itself failed — never read as clean. */
  error?: string;
}

/**
 * Scan every task worktree under the project. `include` picks which worktrees
 * are walked (the sweep skips live turns and bounds each tick); a worktree dir
 * with no task is judged against the default branch.
 */
export async function scanProjectNestedGit(
  projectRoot: string,
  storage: Storage,
  include: (task: Task | null, path: string) => boolean = () => true,
): Promise<NestedGitWorktreeReport[]> {
  const dir = join(projectRoot, getDataDir(projectRoot), 'worktrees');
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  const byPath = new Map((await storage.listTasks()).map(t => [getWorktreePath(projectRoot, t), t] as const));
  const out: NestedGitWorktreeReport[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    if (!(await isDir(path))) continue;
    const task = byPath.get(path) ?? null;
    if (!include(task, path)) continue;
    try {
      out.push({ name, path, task, findings: await scanTaskWorktreeNestedGit(projectRoot, storage, task, path) });
    } catch (err) {
      out.push({ name, path, task, findings: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Quarantine is never done under a live turn: the agent may be mid-way through
 * whatever created the directory, and moving it underneath would corrupt that
 * turn. lazy's own git cannot reach it meanwhile (`taskWorktreeGitEnv` in ../utils/git.ts,
 * `lazy_commit`'s refusal). The finding waits for the turn to end.
 */
export function notUnderLiveTurn(task: Task | null): boolean {
  return !task || !['working', 'pairing', 'merging'].includes(task.status);
}

export type QuarantineOutcome = { name: string; path: string; moved: Array<{ rel: string; movedTo: string }>; error?: string };

/** Quarantine one scanned worktree's findings. Failure is reported, never thrown. */
export async function quarantineReport(projectRoot: string, r: NestedGitWorktreeReport): Promise<QuarantineOutcome> {
  try {
    const moved = await quarantineNestedGit(r.findings, linkQuarantineDirFor(projectRoot, r.name));
    return { name: r.name, path: r.path, moved: moved.map(m => ({ rel: m.finding.rel, movedTo: relative(r.path, m.movedTo).split(sep).join('/') })) };
  } catch (err) {
    return { name: r.name, path: r.path, moved: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Scan (outside live turns) and quarantine. Per-worktree failures are reported, never thrown. */
export async function quarantineProjectNestedGit(
  projectRoot: string,
  storage: Storage,
  include: (task: Task | null, path: string) => boolean = () => true,
): Promise<QuarantineOutcome[]> {
  const out: QuarantineOutcome[] = [];
  for (const r of await scanProjectNestedGit(projectRoot, storage, (t, p) => notUnderLiveTurn(t) && include(t, p))) {
    if (r.error) { out.push({ name: r.name, path: r.path, moved: [], error: r.error }); continue; }
    if (r.findings.length === 0) continue;
    out.push(await quarantineReport(projectRoot, r));
  }
  return out;
}

/** How long a clean walk is trusted before the sweep walks that worktree again. */
export const SWEEP_CLEAN_TTL_MS = 5 * 60_000;
/** Worktrees walked per reconciler tick at most — a walk reads the whole tree. */
export const SWEEP_WORKTREES_PER_TICK = 2;

/** path → when the sweep last found it clean (this process only). */
const sweptCleanAt = new Map<string, number>();

/**
 * The reconciler's between-turns sweep. Each tick walks at most
 * {@link SWEEP_WORKTREES_PER_TICK} worktrees not under a live turn, oldest
 * clean-walk first (never walked comes first), skipping any found clean within
 * {@link SWEEP_CLEAN_TTL_MS}. A task seen under a live turn loses its clean
 * mark, so it is walked first once the turn ends. Accept scans unconditionally.
 */
export async function sweepNestedGit(projectRoot: string, storage: Storage, now: () => number = Date.now): Promise<QuarantineOutcome[]> {
  const t = now();
  const candidates: string[] = [];
  const due = (task: Task | null, path: string) => {
    if (!notUnderLiveTurn(task)) { sweptCleanAt.delete(path); return false; }
    const at = sweptCleanAt.get(path);
    if (at !== undefined && t - at < SWEEP_CLEAN_TTL_MS) return false;
    candidates.push(path);
    return false; // collect first, walk the chosen few below
  };
  await scanProjectNestedGit(projectRoot, storage, due);
  const chosen = new Set(
    candidates
      .sort((a, b) => (sweptCleanAt.get(a) ?? -Infinity) - (sweptCleanAt.get(b) ?? -Infinity))
      .slice(0, SWEEP_WORKTREES_PER_TICK),
  );
  const results = await quarantineProjectNestedGit(projectRoot, storage, (_task, path) => chosen.has(path));
  const failed = new Set(results.filter(r => r.error).map(r => r.path));
  for (const path of chosen) {
    if (failed.has(path)) sweptCleanAt.delete(path);
    else sweptCleanAt.set(path, t);
  }
  return results;
}

/** Test seam: forget every clean mark. */
export function resetNestedGitSweepForTests(): void {
  sweptCleanAt.clear();
}
