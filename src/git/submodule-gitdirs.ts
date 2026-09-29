/**
 * A task worktree's SUBMODULE git dirs — checked and repaired without git.
 *
 * `git submodule update` in a linked worktree puts each submodule's repository
 * under `<common>/worktrees/<id>/modules/<name>`, inside the per-worktree
 * gitdir a task container can write (../capture/git-mounts.ts). A turn that
 * adds `core.fsmonitor`, `core.hooksPath` or `core.sshCommand` to such a
 * `config`, or drops a script into its `hooks/`, gets that code run by the
 * next git in the submodule outside the container — the human's `git` in
 * `<worktree>/<sub>`, and lazy's own `git status` at the worktree root, which
 * runs a status inside every submodule.
 *
 * A mount cannot cover this: submodules appear and change during a turn, and
 * git in the container must write their index and refs. So the check is by
 * content, joined to the pointer check in ./worktree-pointers.ts — every git
 * lazy runs there, every launch, accept, doctor and the daemon's sweep see it:
 *
 *   - `config` may carry only the keys `git clone` / `git submodule` write
 *     ({@link ALLOWED}); anything else — including `include.path` — or a
 *     config that does not parse, is refused (an allowlist, because the list of
 *     keys that run programs is long and grows). `core.worktree` must resolve
 *     inside the task worktree, or a checkout in the submodule writes wherever
 *     the task pointed it;
 *   - `hooks/` may hold only `*.sample` files, which git never runs;
 *   - `config.worktree` and `commondir` must not exist (either makes git read
 *     another file as this repository's config);
 *   - no symbolic link anywhere under `modules/` (git follows a linked git dir
 *     or a linked folder above one), except a `HEAD` naming `refs/...`.
 *
 * A git dir is recognised the way git recognises one — `HEAD` plus `commondir`,
 * or `HEAD` plus `objects` and `refs` — at any depth: submodule names contain
 * slashes, and nested submodules live in `<gitdir>/modules` again. The whole
 * tree is walked, so one hidden anywhere is still found.
 */

import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from 'path';
import { randomBytes } from 'crypto';

/** Keys a fresh clone / `git submodule` writes. `sub: true` means "under any subsection". */
const ALLOWED: Array<{ section: string; sub: boolean; name: string }> = [
  ...['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'worktree', 'symlinks', 'ignorecase', 'precomposeunicode']
    .map(name => ({ section: 'core', sub: false, name })),
  { section: 'remote', sub: true, name: 'url' },
  { section: 'remote', sub: true, name: 'fetch' },
  { section: 'branch', sub: true, name: 'remote' },
  { section: 'branch', sub: true, name: 'merge' },
  { section: 'submodule', sub: true, name: 'url' },
  { section: 'submodule', sub: true, name: 'active' },
  { section: 'extensions', sub: false, name: 'objectformat' },
  { section: 'extensions', sub: false, name: 'refstorage' },
];

/** Walk budget: a modules tree bigger than this is refused rather than half-checked. */
const MAX_DIRS = 50_000;
const MAX_CONFIG_BYTES = 256 * 1024;

export function allowedSubmoduleConfigEntry(e: { section: string; subsection: string | null; name: string }): boolean {
  return ALLOWED.some(a => a.section === e.section && a.name === e.name && (a.sub === (e.subsection !== null)));
}

export class GitConfigParseError extends Error {}

/** One `key[ = value]` entry. */
export interface GitConfigEntry {
  /** Lowercased section name. */
  section: string;
  /** Subsection as written (git compares it case-sensitively), or null. */
  subsection: string | null;
  /** Lowercased variable name. */
  name: string;
  /** `section[.subsection].name`, for messages. */
  key: string;
  /** The value git would read, or null for a bare boolean key. */
  value: string | null;
  /** The section header it sits under, verbatim. */
  header: string;
  /** `name = value` verbatim, trailing comment excluded. */
  text: string;
}

/**
 * git's config syntax, read strictly enough that nothing git would take as a
 * key is missed: section headers (`[s]`, `[s "sub"]`, legacy `[s.sub]`), a key
 * on the header's own line, quoted values, `\` escapes and line continuations,
 * `#`/`;` comments. Anything it cannot place throws — the caller refuses.
 */
export function parseGitConfig(text: string): GitConfigEntry[] {
  const src = text.replace(/^\uFEFF/, '');
  const out: GitConfigEntry[] = [];
  let section: string | null = null;
  let subsection: string | null = null;
  let header = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '#' || c === ';') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '[') {
      const m = /^\[[ \t]*([A-Za-z0-9.-]+)(?:[ \t]+"((?:[^"\\\n]|\\[^\n])*)")?[ \t]*\]/.exec(src.slice(i));
      if (!m) throw new GitConfigParseError(`unreadable section header at offset ${i}`);
      const raw = m[1]!;
      if (m[2] !== undefined) {
        if (raw.includes('.')) throw new GitConfigParseError(`unreadable section header ${m[0]}`);
        section = raw.toLowerCase();
        subsection = m[2].replace(/\\(.)/g, '$1');
      } else {
        const dot = raw.indexOf('.');
        section = (dot < 0 ? raw : raw.slice(0, dot)).toLowerCase();
        // Legacy `[section.sub]`: git lowercases the subsection.
        subsection = dot < 0 ? null : raw.slice(dot + 1).toLowerCase();
      }
      if (!section || subsection === '') throw new GitConfigParseError(`unreadable section header ${m[0]}`);
      header = m[0];
      i += m[0].length;
      continue;
    }
    const km = /^[A-Za-z][A-Za-z0-9-]*/.exec(src.slice(i));
    if (!km) throw new GitConfigParseError(`unexpected ${JSON.stringify(c)} at offset ${i}`);
    if (section === null) throw new GitConfigParseError(`key ${km[0]} outside any section`);
    const start = i;
    i += km[0].length;
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    let end = i;
    let value: string | null = null;
    if (src[i] === '=') {
      i++;
      let quoted = false;
      end = i;
      let v = '';
      let pendingSpace = '';
      while (i < n) {
        const ch = src[i]!;
        if (ch === '\\') {
          if (i + 1 >= n) throw new GitConfigParseError(`dangling escape in ${km[0]}`);
          const nx = src[i + 1]!;
          if (nx !== '\n') v += pendingSpace + (({ n: '\n', t: '\t', b: '\b' } as Record<string, string>)[nx] ?? nx);
          if (nx !== '\n') pendingSpace = '';
          i += 2; end = i; continue;
        }
        if (ch === '"') { v += pendingSpace; pendingSpace = ''; quoted = !quoted; i++; end = i; continue; }
        if (ch === '\n') {
          if (quoted) throw new GitConfigParseError(`unterminated quote in ${km[0]}`);
          break;
        }
        if ((ch === '#' || ch === ';') && !quoted) {
          while (i < n && src[i] !== '\n') i++;
          break;
        }
        i++;
        if (!quoted && (ch === ' ' || ch === '\t' || ch === '\r')) {
          if (v !== '') pendingSpace += ch;
          continue;
        }
        v += pendingSpace + ch;
        pendingSpace = '';
        end = i;
      }
      if (quoted) throw new GitConfigParseError(`unterminated quote in ${km[0]}`);
      value = v;
    } else if (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== '#' && src[i] !== ';') {
      throw new GitConfigParseError(`unexpected text after key ${km[0]}`);
    }
    const name = km[0].toLowerCase();
    const key = subsection === null ? `${section}.${name}` : `${section}.${subsection}.${name}`;
    out.push({ section, subsection, name, key, value, header, text: src.slice(start, end) });
  }
  return out;
}

export type SubmoduleProblemKind = 'config' | 'hooks' | 'remove';

export interface SubmoduleGitDirProblem {
  /** The file or directory at fault. */
  path: string;
  /** How repair handles it: rewrite the config, move hooks aside, move the path out of the tree. */
  kind: SubmoduleProblemKind;
  detail: string;
}

/** lstat, null only for "does not exist" — any other error is thrown (fail closed). */
async function lstatOrNull(path: string) {
  return lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(`could not check ${path}: ${err.code ?? err.message}`);
  });
}

/** True when `p` (resolved through whatever part of it exists) lies inside `root`. */
async function resolvesInside(p: string, root: string): Promise<boolean> {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    const real = await realpath(head).catch(() => null);
    if (real !== null) {
      const full = join(real, ...tail.reverse());
      return full === root || full.startsWith(root + sep);
    }
    const parent = dirname(head);
    if (parent === head) return false;
    tail.push(basename(head));
    head = parent;
  }
}

/**
 * Everything unsafe under `<worktreeGitDir>/modules`. Empty when there is no
 * such directory — the common case, one lstat. Reads files only. `worktree`
 * (the task worktree) bounds where `core.worktree` may point.
 */
export async function findUnsafeSubmoduleGitDirs(worktreeGitDir: string, worktree: string): Promise<SubmoduleGitDirProblem[]> {
  const root = join(worktreeGitDir, 'modules');
  const st = await lstatOrNull(root);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return [{ path: root, kind: 'remove', detail: `${root} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}` }];
  }
  const worktreeReal = await realpath(worktree);
  const problems: SubmoduleGitDirProblem[] = [];
  let budget = MAX_DIRS;
  const walk = async (dir: string): Promise<void> => {
    if (--budget < 0) throw new Error(`${root} holds more than ${MAX_DIRS} directories; refusing to half-check it`);
    const entries = await readdir(dir, { withFileTypes: true });
    const names = new Set(entries.map(e => e.name));
    if (names.has('HEAD') && ((names.has('objects') && names.has('refs')) || (names.has('commondir') && (await commondirResolves(dir))))) {
      await checkGitDir(dir, worktreeReal, problems);
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) {
        // git follows a linked git dir, or a linked folder above one, as if it
        // were here; only a symbolic-ref HEAD is a link git itself writes.
        if (e.name === 'HEAD' && (await readlink(full).catch(() => '')).startsWith('refs/')) continue;
        problems.push({ path: full, kind: 'remove', detail: `${full} is a symbolic link inside the submodule git dirs` });
        continue;
      }
      if (e.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return problems;
}

/**
 * git takes a dir with `HEAD` and a `commondir` as a git dir only when the
 * commondir names an existing directory — a remote branch literally named
 * `commondir` next to `refs/remotes/origin/HEAD` does not. Unreadable = true.
 */
async function commondirResolves(dir: string): Promise<boolean> {
  const text = await readFile(join(dir, 'commondir'), 'utf-8').catch(() => null);
  if (text === null) return true;
  const target = text.replace(/\r?\n$/, '');
  const st = await stat(isAbsolute(target) ? target : resolve(dir, target)).catch(() => null);
  return !!st?.isDirectory();
}

async function checkGitDir(dir: string, worktreeReal: string, problems: SubmoduleGitDirProblem[]): Promise<void> {
  const config = join(dir, 'config');
  const cst = await lstatOrNull(config);
  if (cst && !cst.isSymbolicLink()) {
    if (!cst.isFile()) {
      problems.push({ path: config, kind: 'remove', detail: `submodule git config ${config} is not a regular file` });
    } else if (cst.size > MAX_CONFIG_BYTES) {
      problems.push({ path: config, kind: 'config', detail: `submodule git config ${config} is unexpectedly large` });
    } else {
      try {
        const bad: string[] = [];
        for (const e of parseGitConfig(await readFile(config, 'utf-8'))) {
          if (!allowedSubmoduleConfigEntry(e)) bad.push(e.key);
          else if (e.section === 'core' && e.name === 'worktree' && !(await worktreeValueOk(dir, e.value, worktreeReal))) {
            bad.push(`core.worktree (${e.value ?? ''}, outside the task worktree)`);
          }
        }
        if (bad.length > 0) {
          problems.push({ path: config, kind: 'config', detail: `submodule git config ${config} sets ${[...new Set(bad)].join(', ')}, which git submodule never writes` });
        }
      } catch (err) {
        problems.push({ path: config, kind: 'config', detail: `submodule git config ${config} does not parse (${err instanceof Error ? err.message : String(err)})` });
      }
    }
  }
  // A linked config/hooks is reported by the walk's link rule.
  const hooks = join(dir, 'hooks');
  const hst = await lstatOrNull(hooks);
  if (hst && !hst.isSymbolicLink()) {
    if (!hst.isDirectory()) {
      problems.push({ path: hooks, kind: 'remove', detail: `submodule hooks ${hooks} is not a directory` });
    } else {
      const live = (await readdir(hooks, { withFileTypes: true })).filter(h => !(h.isFile() && h.name.endsWith('.sample')));
      if (live.length > 0) {
        problems.push({ path: hooks, kind: 'hooks', detail: `submodule hooks ${hooks} holds ${live.map(h => h.name).join(', ')}; git submodule only writes *.sample` });
      }
    }
  }
  for (const name of ['config.worktree', 'commondir']) {
    const p = join(dir, name);
    if (await lstatOrNull(p)) {
      problems.push({ path: p, kind: 'remove', detail: `${p} exists in a submodule git dir; git submodule never writes one` });
    }
  }
}

async function worktreeValueOk(gitDir: string, value: string | null, worktreeReal: string): Promise<boolean> {
  if (!value) return false;
  return resolvesInside(isAbsolute(value) ? value : resolve(gitDir, value), worktreeReal);
}

/**
 * Put every unsafe submodule git dir back into a state git runs nothing from.
 * Nothing is deleted — it is evidence: an unsafe `config` is rewritten to its
 * allowed entries with the original kept beside it as
 * `config.lazy-quarantine-<hex>` (a name git never reads); a `hooks/` with a
 * live hook is renamed `hooks.lazy-quarantine-<hex>`; anything else is moved
 * out of `modules/` into `<worktreeGitDir>/lazy-quarantine/`. Returns what changed.
 */
export async function repairSubmoduleGitDirs(worktreeGitDir: string, worktree: string): Promise<string[]> {
  const changed: string[] = [];
  const worktreeReal = await realpath(worktree);
  for (const p of await findUnsafeSubmoduleGitDirs(worktreeGitDir, worktree)) {
    const tag = randomBytes(4).toString('hex');
    if (!(await lstatOrNull(p.path))) continue; // moved with an earlier item
    if (p.kind === 'hooks') {
      const aside = `${p.path}.lazy-quarantine-${tag}`;
      await rename(p.path, aside);
      changed.push(`${p.path} (moved to ${aside})`);
    } else if (p.kind === 'config') {
      const text = await readFile(p.path, 'utf-8');
      let kept = '';
      try {
        let header: string | null = null;
        for (const e of parseGitConfig(text)) {
          if (!allowedSubmoduleConfigEntry(e)) continue;
          if (e.section === 'core' && e.name === 'worktree' && !(await worktreeValueOk(dirname(p.path), e.value, worktreeReal))) continue;
          if (e.header !== header) { kept += `${e.header}\n`; header = e.header; }
          kept += `\t${e.text}\n`;
        }
      } catch (err) {
        // Unparseable: nothing in it can be trusted, so none of it is kept;
        // the original is preserved beside it below.
        if (!(err instanceof GitConfigParseError)) throw err;
        kept = '';
      }
      const aside = `${p.path}.lazy-quarantine-${tag}`;
      await rename(p.path, aside);
      await writeFile(p.path, kept, { flag: 'wx', mode: 0o644 });
      changed.push(`${p.path} (rewritten to its allowed keys; original kept as ${aside})`);
    } else {
      const dest = join(worktreeGitDir, 'lazy-quarantine');
      await mkdir(dest, { recursive: true });
      const aside = join(dest, `${tag}-${relative(worktreeGitDir, p.path).replace(/[\\/]/g, '__')}`);
      await rename(p.path, aside);
      changed.push(`${p.path} (moved to ${aside})`);
    }
  }
  return changed;
}
