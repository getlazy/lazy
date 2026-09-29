/**
 * A task worktree's git POINTERS — checked, copied, mounted and repaired
 * without ever running git.
 *
 * Three small files tell git where a linked worktree's repository is:
 *
 *   - `<worktree>/.git`          — `gitdir: <common>/worktrees/<id>`
 *   - `<gitdir>/commondir`       — `../..` (the shared `<repo>/.git`)
 *   - `<gitdir>/gitdir`          — `<worktree>/.git` (the back-pointer)
 *
 * They live where a turn can write them: the worktree and the per-worktree
 * gitdir are both writable in a task container (../capture/git-mounts.ts). A
 * turn that rewrites `.git` or `commondir` to a directory it controls, holding
 * a `config` with `core.fsmonitor`, `core.hooksPath` or `core.sshCommand`,
 * gets its code run by the NEXT git outside the container in that worktree —
 * the daemon's commit, sync and accept, and the human's own `git` on their
 * machine. git's ownership check is not a boundary here (Teams images set
 * `safe.directory = *`, and on a laptop the files are the human's anyway), so
 * the boundary is structural, in three layers:
 *
 *   1. Task and member containers get read-only COPIES of the checked text
 *      bind-mounted over the three paths ({@link writeGitPointerCopies}), so
 *      nothing inside a container can rewrite them.
 *   2. Every git lazy runs in a task worktree checks them first
 *      ({@link refuseTamperedWorktreeGit}, called from `runGit`) and refuses
 *      to run on a mismatch.
 *   3. `lazy doctor` and a daemon sweep find tampered worktrees and rewrite the
 *      pointers to what `git worktree add` wrote ({@link repairWorktreeGitPointers}).
 *
 * Running `git rev-parse` to find out where things are would follow the very
 * redirection being checked for, so everything here reads files directly.
 * A `config.worktree` in the per-worktree gitdir is refused too, and so is a
 * common config that turns `extensions.worktreeConfig` on: with it on, git
 * reads that turn-writable file as repository config.
 */

import { lstat, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'path';
import { randomBytes } from 'crypto';
import { writeRegularFileUnder } from '../daemon/link-safe-files';
import { LAZY_DIR, LEGACY_DIR, getDataDir } from '../project-paths';
import type { GitMountPaths } from '../capture/git-mounts';
import { findUnsafeSubmoduleGitDirs, repairSubmoduleGitDirs } from './submodule-gitdirs';

export type GitPointerName = 'dotgit' | 'commondir' | 'gitdir';

export interface WorktreeGitPointers extends GitMountPaths {
  /**
   * `<worktree>/.git`, `<gitdir>/commondir`, `<gitdir>/gitdir`: the exact text
   * that was checked, and the path a container sees it at.
   */
  pointerFiles: Array<{ name: GitPointerName; content: string; target: string }>;
}

/** A pointer differs from what lazy created. `detail` names the file. */
export class GitPointerTamperError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'GitPointerTamperError';
  }
}

/**
 * `<worktree>/.git` does not exist at all: a directory that is not (or no
 * longer, mid-removal) a git worktree. Harmless for a human's git — it falls
 * back to the project repository — but lazy still refuses to run git there,
 * and repair never recreates it.
 */
export class WorktreeNotLinkedError extends GitPointerTamperError {
  constructor(detail: string) {
    super(detail);
    this.name = 'WorktreeNotLinkedError';
  }
}

/**
 * A PROJECT-level git setting or layout lazy cannot put a task container on
 * safely (`extensions.worktreeConfig` on, or a git dir it cannot locate by
 * reading files). Not a task's doing — reported once, never "repaired".
 */
export class UnsupportedGitLayoutError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'UnsupportedGitLayoutError';
  }
}

/**
 * A real directory (never itself a link), returned as its realpath. With
 * `expected`, the realpath must be exactly that — a system link higher up
 * (macOS /var → /private/var) is fine, a redirection is not.
 */
async function realDir(path: string, what: string, expected?: string): Promise<string> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    throw new GitPointerTamperError(`${what} ${path} is missing (${err.code ?? err.message})`);
  });
  if (st.isSymbolicLink()) throw new GitPointerTamperError(`${what} ${path} is a symbolic link`);
  if (!st.isDirectory()) throw new GitPointerTamperError(`${what} ${path} is not a directory`);
  const real = await realpath(path);
  if (expected !== undefined && real !== expected) throw new GitPointerTamperError(`${what} ${path} resolves to ${real}, not ${expected}`);
  return real;
}

/** The file's exact text (compared with {@link chomp}, copied as read). */
async function regularFileText(path: string, what: string): Promise<string> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    throw new GitPointerTamperError(`${what} ${path} is missing (${err.code ?? err.message})`);
  });
  if (st.isSymbolicLink()) throw new GitPointerTamperError(`${what} ${path} is a symbolic link`);
  if (!st.isFile()) throw new GitPointerTamperError(`${what} ${path} is not a regular file`);
  if (st.size > 4096) throw new GitPointerTamperError(`${what} ${path} is unexpectedly large`);
  return readFile(path, 'utf-8');
}

const chomp = (text: string) => text.replace(/\r?\n$/, '');

/**
 * True when the common config turns `extensions.worktreeConfig` on. A plain
 * scan rather than `git config`, for the reason in the module header; it errs
 * towards "on" — any value that is not one of git's false spellings counts.
 */
export function worktreeConfigEnabled(configText: string): boolean {
  let section = '';
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const header = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\](.*)$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      const rest = header[2]!.trim();
      if (!rest) continue;
      if (section === 'extensions' && worktreeConfigLine(rest)) return true;
      continue;
    }
    if (section === 'extensions' && worktreeConfigLine(line)) return true;
  }
  return false;
}

function worktreeConfigLine(line: string): boolean {
  const m = /^worktreeconfig\s*(?:=\s*(.*))?$/i.exec(line);
  if (!m) return false;
  const value = (m[1] ?? 'true').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  return !['false', 'no', 'off', '0', ''].includes(value);
}

/**
 * The worktree's git pointers, checked against what lazy created, or a
 * GitPointerTamperError naming the first thing that differs.
 */
export async function validateWorktreeGitPointers(
  projectRoot: string,
  worktreePath: string,
  opts: { requireWorktreeConfigOff?: boolean } = {},
): Promise<WorktreeGitPointers> {
  const commonDir = await resolveProjectCommonDir(projectRoot);
  const worktree = await realDir(await realpath(worktreePath).catch(() => worktreePath), 'the worktree');

  const dotGit = join(worktree, '.git');
  if (!(await exists(dotGit))) {
    throw new WorktreeNotLinkedError(`${dotGit} is missing, so ${worktree} is not a git worktree`);
  }
  const pointerText = await regularFileText(dotGit, "the worktree's .git file");
  const m = /^gitdir: (.+)$/.exec(chomp(pointerText));
  if (!m) throw new GitPointerTamperError(`${dotGit} does not name a gitdir`);
  const gitDir = m[1]!;
  if (!isAbsolute(gitDir)) throw new GitPointerTamperError(`${dotGit} names a relative gitdir (${gitDir})`);
  const id = basename(gitDir);
  if (!id || id.startsWith('.')) throw new GitPointerTamperError(`${dotGit} points at ${gitDir}, not a worktree of ${commonDir}`);
  const worktreeGitDir = await realDir(gitDir, "the worktree's gitdir", join(commonDir, 'worktrees', id));

  const commondirFile = join(worktreeGitDir, 'commondir');
  const commondirText = await regularFileText(commondirFile, 'the commondir file');
  const commondir = chomp(commondirText);
  if (commondir !== '../..' && commondir !== commonDir) {
    throw new GitPointerTamperError(`${commondirFile} points at ${commondir}`);
  }
  const gitdirFile = join(worktreeGitDir, 'gitdir');
  const backText = await regularFileText(gitdirFile, 'the gitdir file');
  const back = chomp(backText);
  const backReal = await realpath(dirname(back)).then((d) => join(d, basename(back)), () => back);
  if (backReal !== dotGit) {
    throw new GitPointerTamperError(`${gitdirFile} points at ${back}, not ${dotGit}`);
  }
  const configWorktree = join(worktreeGitDir, 'config.worktree');
  if (await exists(configWorktree)) {
    throw new GitPointerTamperError(`${configWorktree} exists; lazy never writes one`);
  }
  // Submodule repositories live inside this writable gitdir too, and git in a
  // submodule (the human's, or ours through a root `git status`) reads their
  // config and hooks (./submodule-gitdirs.ts).
  const unsafeSubmodule = (await findUnsafeSubmoduleGitDirs(worktreeGitDir, worktree))[0];
  if (unsafeSubmodule) throw new GitPointerTamperError(unsafeSubmodule.detail);
  if (opts.requireWorktreeConfigOff !== false) await assertWorktreeConfigOff(commonDir);

  const objectsDir = await realDir(join(commonDir, 'objects'), 'the object store', join(commonDir, 'objects'));
  return {
    commonDir,
    objectsDir,
    worktreeGitDir,
    pointerFiles: [
      // The worktree is mounted at the path lazy knows it by.
      { name: 'dotgit', content: pointerText, target: join(worktreePath, '.git') },
      { name: 'commondir', content: commondirText, target: commondirFile },
      { name: 'gitdir', content: backText, target: gitdirFile },
    ],
  };
}

/**
 * Refuse while the common config turns `extensions.worktreeConfig` on: git
 * then reads `<gitdir>/config.worktree`, which a task container can write.
 * A project setting (`git sparse-checkout` turns it on), so it is reported as
 * one, not as tampering.
 */
export async function assertWorktreeConfigOff(commonDir: string): Promise<void> {
  const commonConfig = join(commonDir, 'config');
  const configText = await readFile(commonConfig, 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  if (worktreeConfigEnabled(configText)) {
    throw new UnsupportedGitLayoutError(
      `${commonConfig} turns extensions.worktreeConfig on, which makes git read a per-worktree config ` +
      `a task can write, so lazy will not start task containers; turn it off with ` +
      `\`git config --unset extensions.worktreeConfig\` in the project root`,
    );
  }
}

/**
 * The project's shared git dir, found by READING files (never git): `<root>/.git`
 * when it is a directory; when it is a file (the project is itself a linked
 * worktree, or uses `--separate-git-dir`), the dir it names — or that dir's
 * `commondir` when it has one. Returned as a realpath.
 */
export async function resolveProjectCommonDir(projectRoot: string): Promise<string> {
  const root = await realpath(projectRoot);
  const dotGit = join(root, '.git');
  const st = await lstat(dotGit).catch((err: NodeJS.ErrnoException) => {
    throw new UnsupportedGitLayoutError(`the project's git directory ${dotGit} is missing (${err.code ?? err.message})`);
  });
  if (st.isDirectory() && !st.isSymbolicLink()) return realDir(dotGit, "the project's git directory", dotGit);
  if (!st.isFile()) throw new UnsupportedGitLayoutError(`the project's ${dotGit} is neither a directory nor a gitdir file`);
  const m = /^gitdir: (.+)$/.exec(chomp(await readFile(dotGit, 'utf-8')));
  if (!m) throw new UnsupportedGitLayoutError(`the project's ${dotGit} does not name a gitdir`);
  const gitDir = await realpath(isAbsolute(m[1]!) ? m[1]! : join(root, m[1]!)).catch(() => {
    throw new UnsupportedGitLayoutError(`the project's ${dotGit} names ${m[1]}, which does not exist`);
  });
  const cd = await readFile(join(gitDir, 'commondir'), 'utf-8').then(chomp, () => null);
  if (cd === null) return gitDir;
  return realpath(isAbsolute(cd) ? cd : join(gitDir, cd)).catch(() => {
    throw new UnsupportedGitLayoutError(`${join(gitDir, 'commondir')} names ${cd}, which does not exist`);
  });
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
}

/**
 * Write the checked pointer texts under `root/relDir` (a directory no turn can
 * write) and return what to mount where.
 */
export async function writeGitPointerCopies(
  root: string,
  relDir: string,
  layout: Pick<WorktreeGitPointers, 'pointerFiles'>,
): Promise<Array<{ source: string; target: string }>> {
  const copies: Array<{ source: string; target: string }> = [];
  for (const f of layout.pointerFiles) {
    await writeRegularFileUnder(root, join(relDir, f.name), f.content, 0o444);
    copies.push({ source: join(root, relDir, f.name), target: f.target });
  }
  return copies;
}

/** `-v` args binding each copy read-only over the original's path. */
export function gitPointerMountArgs(copies: Array<{ source: string; target: string }>): string[] {
  return copies.flatMap((f) => ['-v', `${f.source}:${f.target}:ro`]);
}

/**
 * Where, under the project root, a TASK container's pointer copies live:
 * `<data dir>/git-pointers/<worktree name>`. The project root is mounted
 * read-only into every task container and only the task's own worktree is
 * writable on top, so no container can rewrite a copy.
 */
export function taskGitPointerCopyDir(projectRoot: string, worktreePath: string): string {
  return join(getDataDir(projectRoot), 'git-pointers', basename(worktreePath));
}

/** Drop a task's pointer copies once its worktree is gone. Missing is fine. */
export async function removeTaskGitPointerCopies(projectRoot: string, worktreePath: string): Promise<void> {
  await rm(join(projectRoot, taskGitPointerCopyDir(projectRoot, worktreePath)), { recursive: true, force: true });
}

/**
 * Validate, write the copies, and return the extra `-v` args for a task
 * container. Throws GitPointerTamperError on a tampered worktree, and
 * UnsupportedGitLayoutError on a project layout it cannot protect — a
 * container must never be launched on either.
 */
export async function taskGitPointerMounts(projectRoot: string, worktreePath: string): Promise<{ layout: WorktreeGitPointers; mountArgs: string[] }> {
  const layout = await validateWorktreeGitPointers(projectRoot, worktreePath);
  const root = await realpath(projectRoot);
  const copies = await writeGitPointerCopies(root, taskGitPointerCopyDir(root, worktreePath), layout);
  return { layout, mountArgs: gitPointerMountArgs(copies) };
}

/**
 * The lazy task worktree `cwd` is inside — `<root>/<.lazy|.workshop>/worktrees/<name>`
 * — or null when it is not in one. Path-shaped on purpose: it has to be cheap
 * enough for every git lazy runs.
 */
export function taskWorktreeOf(cwd: string): { projectRoot: string; worktreePath: string } | null {
  let best: { at: number; marker: string; dir: string } | null = null;
  for (const dir of [LAZY_DIR, LEGACY_DIR]) {
    const marker = `${sep}${dir}${sep}worktrees${sep}`;
    const at = cwd.lastIndexOf(marker);
    if (at > 0 && (!best || at > best.at)) best = { at, marker, dir };
  }
  if (!best) return null;
  const name = cwd.slice(best.at + best.marker.length).split(sep)[0];
  if (!name) return null;
  const projectRoot = cwd.slice(0, best.at);
  return { projectRoot, worktreePath: join(projectRoot, best.dir, 'worktrees', name) };
}

/**
 * The refusal message for git that must not run in `cwd`, or null when it may.
 * Only lazy task worktrees are checked. Fails CLOSED: anything that stops the
 * check from answering is a refusal naming it, never a thrown error (runGit
 * returns results, it does not throw) and never a silent pass.
 */
export async function refuseTamperedWorktreeGit(cwd: string): Promise<string | null> {
  const wt = taskWorktreeOf(cwd);
  if (!wt) return null;
  if (!(await exists(wt.worktreePath).catch(() => true))) return null;
  // A "project root" with no .git at all is not a layout lazy creates task
  // worktrees in (a standalone repo that happens to sit at such a path): leave
  // it to git. A .git FILE there (a linked-worktree project) is checked.
  if ((await lstat(join(wt.projectRoot, '.git')).catch(() => null)) === null) return null;
  try {
    await validateWorktreeGitPointers(wt.projectRoot, wt.worktreePath, { requireWorktreeConfigOff: false });
    return null;
  } catch (err) {
    const detail = err instanceof GitPointerTamperError || err instanceof UnsupportedGitLayoutError
      ? err.detail
      : `its git pointers could not be checked: ${err instanceof Error ? err.message : String(err)}`;
    return tamperRefusal(basename(wt.worktreePath), detail);
  }
}

export function tamperRefusal(taskName: string, detail: string): string {
  return (
    `Refusing to run git in the worktree of task ${taskName}: its git pointers or submodule git dirs are not ` +
    `what lazy and git created (${detail}). Running git there could execute code the task planted. ` +
    `See \`lazy doctor\`; \`lazy doctor --repair-git-pointers\` repairs them.`
  );
}

/** One task worktree's pointer state. */
export interface WorktreePointerReport {
  name: string;
  path: string;
  /**
   * `ok` — what lazy created. `tampered` — a pointer was changed (repairable).
   * `not-a-worktree` — no `.git` at all (a leftover or half-removed dir; never
   * repaired). `error` — the check itself failed (`problem` says why).
   */
  state: 'ok' | 'tampered' | 'not-a-worktree' | 'error';
  /** Null when `state` is `ok`. */
  problem: string | null;
}

/** Every task worktree under the project's data dir, checked. One failure never aborts the scan. */
export async function scanWorktreeGitPointers(projectRoot: string): Promise<WorktreePointerReport[]> {
  const dir = join(projectRoot, getDataDir(projectRoot), 'worktrees');
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  const out: WorktreePointerReport[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st?.isDirectory()) continue;
    try {
      await validateWorktreeGitPointers(projectRoot, path, { requireWorktreeConfigOff: false });
      out.push({ name, path, state: 'ok', problem: null });
    } catch (err) {
      if (err instanceof WorktreeNotLinkedError) out.push({ name, path, state: 'not-a-worktree', problem: err.detail });
      else if (err instanceof GitPointerTamperError) out.push({ name, path, state: 'tampered', problem: err.detail });
      else out.push({ name, path, state: 'error', problem: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** A pointer text, or null when it is absent, a link, or not a small regular file. */
async function plainText(path: string): Promise<string | null> {
  const st = await lstat(path).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > 4096) return null;
  return readFile(path, 'utf-8').catch(() => null);
}

/** `path`'s realpath when it resolves, else `path` as given. */
async function realOr(path: string): Promise<string> {
  const d = await realpath(dirname(path)).catch(() => null);
  return d ? join(d, basename(path)) : path;
}

/**
 * Which `<common>/worktrees/<id>` belongs to this worktree, found without git
 * and without assuming the id is the folder name (git appends a number when a
 * stale entry of that name is still registered):
 *   1. the id the current `.git` names, when that is a real gitdir;
 *   2. otherwise the ONE gitdir whose `gitdir` back-pointer names this worktree;
 *   3. otherwise the folder name, unless its back-pointer names another worktree that exists.
 * A candidate whose back-pointer names a DIFFERENT worktree that exists is never
 * taken. Null when nothing qualifies.
 */
async function findOwnGitDir(commonDir: string, worktree: string): Promise<string | null> {
  const dotGit = join(worktree, '.git');
  const worktreesDir = join(commonDir, 'worktrees');
  const isRealGitDir = async (d: string) => {
    const st = await lstat(d).catch(() => null);
    return !!st && st.isDirectory() && !st.isSymbolicLink();
  };
  const backNamesUs = async (d: string) => {
    const back = await plainText(join(d, 'gitdir'));
    return back !== null && (await realOr(chomp(back))) === dotGit;
  };
  const backNamesOther = async (d: string) => {
    const back = await plainText(join(d, 'gitdir'));
    if (back === null) return false;
    const target = await realOr(chomp(back));
    return target !== dotGit && (await exists(dirname(target)).catch(() => false));
  };

  const current = await plainText(dotGit);
  const m = current ? /^gitdir: (.+)$/.exec(chomp(current)) : null;
  if (m && isAbsolute(m[1]!)) {
    const id = basename(m[1]!);
    const d = join(worktreesDir, id);
    if (id && !id.startsWith('.') && (await realOr(m[1]!)) === d && (await isRealGitDir(d)) && !(await backNamesOther(d))) return d;
  }
  const ids = await readdir(worktreesDir).catch(() => [] as string[]);
  const claiming: string[] = [];
  for (const id of ids) {
    const d = join(worktreesDir, id);
    if ((await isRealGitDir(d)) && (await backNamesUs(d))) claiming.push(d);
  }
  if (claiming.length === 1) return claiming[0]!;
  if (claiming.length > 1) return null;
  const byName = join(worktreesDir, basename(worktree));
  if ((await isRealGitDir(byName)) && !(await backNamesOther(byName))) return byName;
  return null;
}

/**
 * Rewrite a worktree's pointers to what `git worktree add` wrote, derived from
 * paths alone (see {@link findOwnGitDir} for how the gitdir is chosen), and
 * remove a `config.worktree`. Throws — changing nothing — when the worktree
 * has no `.git` at all (not a worktree, or mid-removal: repair never recreates
 * one), when no gitdir can be attributed to it, or when `.git` is a directory
 * (a planted repository: moved aside to `.git.lazy-quarantine-<n>`, then repaired).
 * Every write replaces the file — a rename replaces a planted link, it never
 * writes through one.
 *
 * Does NOT touch the common config: an `extensions.worktreeConfig` a human
 * turned on is reported, never silently reverted.
 */
export async function repairWorktreeGitPointers(
  projectRoot: string,
  worktreePath: string,
  opts: { submodules?: boolean } = {},
): Promise<string[]> {
  const commonDir = await resolveProjectCommonDir(projectRoot);
  const root = await realpath(projectRoot);
  const worktree = join(root, getDataDir(root), 'worktrees', basename(worktreePath));
  await realDir(worktree, 'the worktree', worktree);
  const dotGit = join(worktree, '.git');
  const dotGitStat = await lstat(dotGit).catch(() => null);
  if (!dotGitStat) {
    throw new WorktreeNotLinkedError(`${dotGit} is missing, so ${worktree} is not a git worktree; nothing to repair`);
  }
  const changed: string[] = [];
  if (dotGitStat.isDirectory() && !dotGitStat.isSymbolicLink()) {
    // A whole repository planted in place of the pointer file. Moved aside,
    // never deleted: it is evidence, and it may hold the task's work.
    const aside = `${dotGit}.lazy-quarantine-${randomBytes(4).toString('hex')}`;
    await rename(dotGit, aside);
    changed.push(`${dotGit} (planted directory moved to ${aside})`);
  }
  const gitDir = await findOwnGitDir(commonDir, worktree);
  if (!gitDir) {
    throw new Error(
      `cannot tell which of ${join(commonDir, 'worktrees')}/* belongs to ${worktree} without running git; ` +
      `recreate the task's worktree instead`,
    );
  }

  const want: Array<[string, string]> = [
    [dotGit, `gitdir: ${gitDir}\n`],
    [join(gitDir, 'commondir'), `${relativeCommonDir(gitDir, commonDir)}\n`],
    [join(gitDir, 'gitdir'), `${dotGit}\n`],
  ];
  for (const [path, text] of want) {
    if ((await plainText(path)) === text) continue;
    await replaceFile(path, text);
    changed.push(path);
  }
  const configWorktree = join(gitDir, 'config.worktree');
  if (await exists(configWorktree)) {
    await rm(configWorktree, { recursive: true, force: true });
    changed.push(configWorktree);
  }
  if (opts.submodules !== false) changed.push(...(await repairSubmoduleGitDirs(gitDir, worktree)));
  return changed;
}

/** `../..` for the ordinary layout; the absolute path when the gitdir is elsewhere. */
function relativeCommonDir(gitDir: string, commonDir: string): string {
  return dirname(dirname(gitDir)) === commonDir ? '../..' : commonDir;
}

async function replaceFile(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.lazy-repair-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, text, { flag: 'wx', mode: 0o644 });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined); // best effort: the rename's error is the one to report
    throw new Error(`failed to replace ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Repair every TAMPERED worktree under the project (never a not-a-worktree
 * dir, never a failed check). Used by the daemon's sweep. `turnIsLive(name)`
 * true leaves that worktree's SUBMODULE git dirs alone: the agent's own git
 * writes them mid-turn, so they are repaired between turns (lazy's git keeps
 * refusing meanwhile). Its pointers are repaired regardless — no turn writes those.
 */
export async function repairTamperedWorktrees(
  projectRoot: string,
  opts: { turnIsLive?: (name: string) => Promise<boolean> } = {},
): Promise<Array<{ name: string; problem: string; repaired: string[] | null; error?: string }>> {
  const results: Array<{ name: string; problem: string; repaired: string[] | null; error?: string }> = [];
  for (const r of await scanWorktreeGitPointers(projectRoot)) {
    if (r.state !== 'tampered') continue;
    try {
      const live = opts.turnIsLive ? await opts.turnIsLive(r.name) : false;
      const repaired = await repairWorktreeGitPointers(projectRoot, r.path, { submodules: !live });
      const after = await validateWorktreeGitPointers(projectRoot, r.path, { requireWorktreeConfigOff: false })
        .then(() => null, (e) => (e instanceof GitPointerTamperError ? e.detail : String(e)));
      results.push(after ? { name: r.name, problem: r.problem!, repaired: null, error: live ? `${after} (a turn is running; its submodule git dirs are repaired once it ends)` : after } : { name: r.name, problem: r.problem!, repaired });
    } catch (err) {
      results.push({ name: r.name, problem: r.problem!, repaired: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// HEAD — which branch a daemon-side commit in a task worktree moves
// ---------------------------------------------------------------------------
//
// `<gitdir>/HEAD` has to stay writable inside a task container (git rewrites it
// on every checkout), so a task can point it at `ref: refs/heads/<another
// branch>` — a sibling's, its parent's, main — and the daemon's next commit,
// merge or recorded range in that worktree then acts on a branch the task does
// not own. No planted code runs, which is why this is not part of the pointer
// check `runGit` does; it is checked by the WRITING paths, which know the
// task's branch, and repaired only by doctor and the daemon sweep.

/** A task worktree's HEAD names something other than the task's own branch. */
export class TaskHeadBranchError extends Error {
  constructor(readonly taskName: string, readonly expectedBranch: string, readonly detail: string) {
    super(
      `Refusing to write git in the worktree of task ${taskName}: its HEAD ${detail}, not its own branch ` +
      `${expectedBranch}. Committing, syncing or accepting there would move a branch the task does not own. ` +
      `In that worktree, finish or abort any rebase or merge in progress and run \`git checkout ${expectedBranch}\`; ` +
      `or see \`lazy doctor\` — \`lazy doctor --repair-git-pointers\` points HEAD back at ${expectedBranch}.`,
    );
    this.name = 'TaskHeadBranchError';
  }
}

/** HEAD is off the task branch but rewriting it alone would be wrong; a human must check out. */
export class HeadRepairUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadRepairUnsafeError';
  }
}

/** How HEAD's text differs from `ref: refs/heads/<branch>`, or null when it does not. */
export function describeHeadMismatch(headText: string, branch: string): string | null {
  const head = chomp(headText);
  if (head === `ref: refs/heads/${branch}`) return null;
  const m = /^ref: refs\/heads\/(.+)$/.exec(head);
  if (m) return `points at branch ${m[1]}`;
  if (/^ref: /.test(head)) return `points at ${head.slice(5)}`;
  if (/^[0-9a-f]{40,64}$/.test(head)) return `is detached at ${head.slice(0, 12)}`;
  return 'is not a branch reference';
}

/**
 * Null when the task worktree's HEAD is `ref: refs/heads/<branch>`, else the
 * mismatch. Reads the file through the validated pointers, never git; a pointer
 * problem is reported as the mismatch (the write must not go ahead either way).
 */
export async function checkTaskWorktreeHead(projectRoot: string, worktreePath: string, branch: string): Promise<string | null> {
  let layout: WorktreeGitPointers;
  try {
    layout = await validateWorktreeGitPointers(projectRoot, worktreePath, { requireWorktreeConfigOff: false });
  } catch (err) {
    return `could not be read: ${err instanceof GitPointerTamperError ? err.detail : err instanceof Error ? err.message : String(err)}`;
  }
  let text: string;
  try {
    text = await regularFileText(join(layout.worktreeGitDir, 'HEAD'), 'the HEAD file');
  } catch (err) {
    return `could not be read: ${err instanceof GitPointerTamperError ? err.detail : String(err)}`;
  }
  return describeHeadMismatch(text, branch);
}

/**
 * Throw {@link TaskHeadBranchError} unless the task worktree `worktreePath`
 * has HEAD on `branch`. A path outside a lazy task worktree is not checked
 * (the project root's own checkout is the human's).
 */
export async function assertTaskWorktreeHead(worktreePath: string, branch: string): Promise<void> {
  const wt = taskWorktreeOf(worktreePath);
  if (!wt) return;
  const mismatch = await checkTaskWorktreeHead(wt.projectRoot, wt.worktreePath, branch);
  if (mismatch) throw new TaskHeadBranchError(basename(wt.worktreePath), branch, mismatch);
}

/**
 * Whether the worktree's INDEX holds `branch`'s tree: `same` when it does,
 * `differs` when git says it does not (a real checkout moved it), `unknown`
 * when the comparison itself failed (`detail` says why — branch gone, a HEAD
 * git will not read). Only `same` makes a HEAD-only rewrite safe. Call after
 * the pointers are validated: this is a read, and it then follows nothing.
 */
export async function indexHoldsBranch(
  worktreePath: string,
  branch: string,
): Promise<{ state: 'same' | 'differs' | 'unknown'; detail?: string }> {
  // Dynamic: ../utils/git imports this module for runGit's pointer check.
  const { runGit } = await import('../utils/git');
  const r = await runGit(['diff', '--cached', '--quiet', `refs/heads/${branch}`, '--'], { cwd: worktreePath });
  if (r.exitCode === 0) return { state: 'same' };
  if (r.exitCode === 1) return { state: 'differs' };
  return { state: 'unknown', detail: r.stderr || `git diff exited ${r.exitCode}` };
}

/** The manual remedy for a HEAD repair cannot safely do on its own. */
export function manualHeadRemedy(worktreePath: string, branch: string): string {
  return `in ${worktreePath} run \`git checkout ${branch}\` (\`git stash\` first if it has uncommitted changes)`;
}

/**
 * Point the task worktree's HEAD back at `branch`. Only HEAD is rewritten —
 * the index and working files are left as they are, so the task's uncommitted
 * edits survive and show as changes against its own branch. Returns true when
 * something was rewritten. Refuses (throws) on tampered pointers: repair those first.
 *
 * Throws {@link HeadRepairUnsafeError}, rewriting nothing, unless the INDEX
 * still holds the task branch's tree — the attack case, where only the HEAD
 * file was written. A real `git checkout <other>` moved the index and files
 * too; pointing HEAD back under them would make the next commit revert the
 * task's work. Also thrown when that comparison could not be made.
 */
export async function repairTaskWorktreeHead(projectRoot: string, worktreePath: string, branch: string): Promise<boolean> {
  const layout = await validateWorktreeGitPointers(projectRoot, worktreePath, { requireWorktreeConfigOff: false });
  const head = join(layout.worktreeGitDir, 'HEAD');
  const want = `ref: refs/heads/${branch}\n`;
  const current = await plainText(head);
  if (current !== null && describeHeadMismatch(current, branch) === null) return false;
  const index = await indexHoldsBranch(worktreePath, branch);
  if (index.state === 'differs') {
    throw new HeadRepairUnsafeError(
      `its index does not hold ${branch}'s tree (a real checkout moved it), so HEAD was not rewritten; ` +
      manualHeadRemedy(worktreePath, branch),
    );
  }
  if (index.state === 'unknown') {
    throw new HeadRepairUnsafeError(
      `could not compare its index with ${branch} (${index.detail}), so HEAD was not rewritten; ` +
      manualHeadRemedy(worktreePath, branch),
    );
  }
  await replaceFile(head, want);
  return true;
}

export interface TaskHeadReport {
  name: string;
  path: string;
  branch: string;
  problem: string;
  /**
   * True when the repair will refuse (the index is not the task branch's tree,
   * or could not be compared): surfaces name the manual remedy, not the flag.
   */
  manual: boolean;
}

/**
 * Every task worktree whose HEAD is off its task's branch. `branches` maps a
 * worktree's folder name (the task ref) to the branch its session owns;
 * worktrees missing from it are not judged. Tampered pointers are left to the
 * pointer scan and not reported twice.
 */
export async function scanTaskWorktreeHeads(projectRoot: string, branches: Map<string, string>): Promise<TaskHeadReport[]> {
  const out: TaskHeadReport[] = [];
  for (const r of await scanWorktreeGitPointers(projectRoot)) {
    if (r.state !== 'ok') continue;
    const branch = branches.get(r.name);
    if (!branch) continue;
    const problem = await checkTaskWorktreeHead(projectRoot, r.path, branch);
    if (!problem) continue;
    const manual = (await indexHoldsBranch(r.path, branch)).state !== 'same';
    out.push({ name: r.name, path: r.path, branch, problem, manual });
  }
  return out;
}

/** Repair every redirected HEAD {@link scanTaskWorktreeHeads} finds. Used by the daemon's sweep. */
export async function repairRedirectedTaskHeads(
  projectRoot: string,
  branches: Map<string, string>,
  opts: { skipDetached?: boolean } = {},
): Promise<Array<TaskHeadReport & { error?: string }>> {
  const results: Array<TaskHeadReport & { error?: string }> = [];
  for (const r of await scanTaskWorktreeHeads(projectRoot, branches)) {
    if (opts.skipDetached && r.problem.startsWith('is detached')) continue;
    try {
      await repairTaskWorktreeHead(projectRoot, r.path, r.branch);
      const after = await checkTaskWorktreeHead(projectRoot, r.path, r.branch);
      results.push(after ? { ...r, error: `HEAD still ${after} after the rewrite` } : r);
    } catch (err) {
      results.push({ ...r, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/**
 * The paths a HOST-runner agent in `worktreePath` must not write, for
 * `applyGitPointerDenies` (src/runner/host-sandbox.ts): this worktree's three
 * pointers, the common `config` and `hooks`, every other task worktree's
 * `commondir` / `gitdir` / `config.worktree` (Claude Code binds
 * `<common>/worktrees` writable for Bash, so without them one task could
 * redirect another's), and the common dir itself. Each path in both the
 * spelling lazy knows it by and its realpath: file-tool rules match literal
 * spellings, and a symlinked project root must not slip past.
 *
 * Null when `worktreePath` is not a lazy task worktree, or its project has no
 * `.git` — the same scope as {@link refuseTamperedWorktreeGit}. Validated
 * first, exactly as a container launch is: a tampered worktree, or a project
 * with `extensions.worktreeConfig` on, throws and no agent is launched.
 * Worktrees created DURING the turn are not covered; theirs are validated
 * before their own first git or launch (layers 1 and 2).
 */
export async function hostGitPointerDenyPaths(
  worktreePath: string,
): Promise<{ protectedPaths: string[]; commonDirs: string[] } | null> {
  const wt = taskWorktreeOf(worktreePath);
  if (!wt) return null;
  if ((await lstat(join(wt.projectRoot, '.git')).catch(() => null)) === null) return null;
  const task = basename(wt.worktreePath);
  const layout = await validateWorktreeGitPointers(wt.projectRoot, worktreePath).catch((err: unknown) => {
    // Name the task and the repair, as runGit does, not just the file.
    if (err instanceof GitPointerTamperError) throw new GitPointerTamperError(tamperRefusal(task, err.detail));
    if (err instanceof UnsupportedGitLayoutError) {
      throw new UnsupportedGitLayoutError(`Refusing to launch an agent for task ${task}: ${err.detail}`);
    }
    throw err;
  });
  const commonDir = layout.commonDir;

  const inCommon: string[] = [join(commonDir, 'config'), join(commonDir, 'hooks')];
  for (const f of layout.pointerFiles) {
    if (f.name !== 'dotgit') inCommon.push(f.target);
  }
  const worktreesDir = join(commonDir, 'worktrees');
  const others = await readdir(worktreesDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw new Error(`could not list ${worktreesDir} to protect other worktrees' git pointers: ${err.message}`);
  });
  for (const id of others) {
    const dir = join(worktreesDir, id);
    if (dir === layout.worktreeGitDir) continue;
    inCommon.push(join(dir, 'commondir'), join(dir, 'gitdir'), join(dir, 'config.worktree'));
  }

  // The common dir as lazy spells it, when that is a different path to it.
  const spelled = join(wt.projectRoot, '.git');
  const spellings = [commonDir];
  if (spelled !== commonDir && (await realpath(spelled).catch(() => null)) === commonDir) spellings.push(spelled);
  const respell = (p: string) => spellings.map((s) => s + p.slice(commonDir.length));

  const realWorktree = await realpath(worktreePath);
  const paths = new Set<string>([join(worktreePath, '.git'), join(realWorktree, '.git')]);
  for (const p of inCommon) for (const s of respell(p)) paths.add(s);
  return { protectedPaths: [...paths], commonDirs: spellings };
}
