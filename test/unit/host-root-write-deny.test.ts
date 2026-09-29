/**
 * The project-root write boundary for host-runner agents' file tools
 * (src/runner/host-sandbox.ts, projectRootWriteDenyRules).
 *
 * Claude Code's matcher is not importable, so `denied()` below is a MODEL of
 * the semantics measured on Claude Code 2.1.282 with a fake Messages API
 * (docs/design/git-pointer-boundary.md, "Project root"): case-insensitive,
 * `*` / `?` never cross `/`, character classes support ranges only, and a
 * pattern matching a directory covers everything beneath it. The real matcher
 * is exercised on a real host by `lazy system verify-host-boundary`.
 */

import { describe, test, expect } from 'bun:test';
import {
  projectRootWriteDenyRules,
  withProjectRootWriteDenyArgs,
  PROBE_PROJECT_ROOT_SCOPE,
  type ProjectRootWriteScope,
} from '../../src/runner/host-sandbox';
import { addProjectRootWriteDenies } from '../../src/supervisor/index';
import { probeRootSettingsJson } from '../../src/runner/host-boundary-guard';
import type { Command } from '../../src/protocol/types';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, posix } from 'path';

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, end).replace(/[\\\]^]/g, (m) => `\\${m}`);
      re += `[${body}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, (m) => `\\${m}`);
  }
  // A match on a directory covers what is under it.
  return new RegExp(`^${re}(/.*)?$`, 'i');
}

function denied(rules: string[], tool: 'Edit' | 'Write', absPath: string): boolean {
  return rules
    .filter((r) => r.startsWith(`${tool}(`))
    .map((r) => r.slice(tool.length + 2, -1)) // strip `Edit(/`, `)` -> '/abs...'
    .some((g) => globToRegex(g).test(absPath));
}

const ROOT = '/home/u/proj';
const SCOPE: ProjectRootWriteScope = { projectRoots: [ROOT], dataDir: '.lazy', worktreeName: 'fix-thing' };
const RULES = projectRootWriteDenyRules(SCOPE);

describe('projectRootWriteDenyRules', () => {
  // INVARIANT: a host-runner agent's file tools cannot write the project root —
  // above all the root lazy.toml, which decides the rules of its next turn —
  // nor another task's worktree, nor lazy's own state under the data dir. The
  // root config is the only config lazy reads, so a writable root lets a turn
  // choose its successor's permissions, checks and watchdog.
  test.each([
    'lazy.toml',
    'CLAUDE.md',
    'src/index.ts',
    'new-file-created-after-launch',
    '.env',
    '.lazy/recovery/x.json',
    '.lazy/git-pointers/fix-thing/dotgit',
    '.lazy/worktrees/other-task/src/a.ts',
    '.lazy/worktrees/fix-thin/a',
    '.lazy/worktrees/fix-thingx/a',
    '.lazy/worktrees/fix-thing2/a',
    '.lazy/worktreesx/fix-thing/a',
    '.lazyx/worktrees/fix-thing/a',
    '.git/config',
    '.git/hooks',
    '.git/hooks/pre-commit',
    '.gi/x',
    '.gitx/config',
    '.l',
    'ü/x',
  ])('denies Edit and Write on %s', (rel) => {
    expect(denied(RULES, 'Edit', `${ROOT}/${rel}`)).toBe(true);
    expect(denied(RULES, 'Write', `${ROOT}/${rel}`)).toBe(true);
  });

  // INVARIANT: the task's own worktree stays writable to the file tools, and so
  // does the shared .git dir — its pointer files are the git-pointer denies'
  // business, and a blanket deny there would become a read-only bind for Bash
  // and break `git add`. A rule set that denies the worktree bricks every host
  // agent.
  test.each([
    '.lazy/worktrees/fix-thing/a.ts',
    '.lazy/worktrees/fix-thing/deep/dir/b.ts',
    '.lazy/worktrees/fix-thing/.lazy-task-sandbox/x',
    '.git/objects/ab/cdef',
    '.git/worktrees/fix-thing/index',
    '.git/config.lock',
  ])('leaves %s writable', (rel) => {
    expect(denied(RULES, 'Edit', `${ROOT}/${rel}`)).toBe(false);
    expect(denied(RULES, 'Write', `${ROOT}/${rel}`)).toBe(false);
  });

  test('does not reach outside the project root', () => {
    expect(denied(RULES, 'Edit', '/home/u/other/lazy.toml')).toBe(false);
    expect(denied(RULES, 'Edit', '/home/u/proj2/lazy.toml')).toBe(false);
  });

  // Measured: the Write tool obeys Edit(...) rules and ignores Write(...) ones,
  // so every pattern must be emitted as Edit.
  test('every pattern is emitted as an Edit rule', () => {
    const edits = RULES.filter((r) => r.startsWith('Edit(')).map((r) => r.slice(5));
    const writes = RULES.filter((r) => r.startsWith('Write(')).map((r) => r.slice(6));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits).toEqual(writes);
  });

  // Measured: negated classes are literal sets in Claude Code's matcher, so a
  // `[!x]` or `[^x]` would silently mean the opposite of what it says.
  test('never uses a negated character class', () => {
    for (const r of RULES) expect(r).not.toMatch(/\[[!^]/);
  });

  test('covers every spelling of the root', () => {
    const rules = projectRootWriteDenyRules({ ...SCOPE, projectRoots: [ROOT, '/real/proj/'] });
    expect(denied(rules, 'Edit', '/real/proj/lazy.toml')).toBe(true);
    expect(denied(rules, 'Edit', '/real/proj/.lazy/worktrees/fix-thing/a')).toBe(false);
  });

  test('honours a legacy data dir name', () => {
    const rules = projectRootWriteDenyRules({ ...SCOPE, dataDir: '.workshop' });
    expect(denied(rules, 'Edit', `${ROOT}/.workshop/worktrees/fix-thing/a`)).toBe(false);
    expect(denied(rules, 'Edit', `${ROOT}/.lazy/worktrees/fix-thing/a`)).toBe(true);
  });

  test('refuses a root or name the glob syntax cannot express exactly', () => {
    expect(() => projectRootWriteDenyRules({ ...SCOPE, projectRoots: ['/home/u/p[1]'] })).toThrow(/glob character/);
    expect(() => projectRootWriteDenyRules({ ...SCOPE, worktreeName: 'a*b' })).toThrow(/glob character/);
    expect(() => projectRootWriteDenyRules({ ...SCOPE, projectRoots: ['/home/u/{a,b}'] })).toThrow(/glob character/);
    // A trailing `^` would make the exact-name class `[^]`.
    expect(() => projectRootWriteDenyRules({ ...SCOPE, worktreeName: 'a^' })).toThrow(/glob character/);
  });
});

describe('withProjectRootWriteDenyArgs', () => {
  test('adds the rules to an existing --settings deny list and keeps the rest', () => {
    const settings = { sandbox: { enabled: true }, permissions: { deny: ['Read(//home/u/.ssh)'] } };
    const out = withProjectRootWriteDenyArgs(['--settings', JSON.stringify(settings), '--x'], SCOPE)!;
    const parsed = JSON.parse(out[1]!);
    expect(out[2]).toBe('--x');
    expect(parsed.sandbox).toEqual({ enabled: true });
    expect(parsed.permissions.deny[0]).toBe('Read(//home/u/.ssh)');
    expect(parsed.permissions.deny).toEqual(expect.arrayContaining(RULES));
  });

  test('leaves args without --settings (containers, bypass) untouched', () => {
    expect(withProjectRootWriteDenyArgs(['--foo'], SCOPE)).toEqual(['--foo']);
    expect(withProjectRootWriteDenyArgs(undefined, SCOPE)).toBeUndefined();
  });
});

describe('addProjectRootWriteDenies (supervisor)', () => {
  test('derives the scope from a task worktree, adding the realpath spelling', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'root-deny-')));
    try {
      const real = join(base, 'real');
      await mkdir(join(real, '.lazy', 'worktrees', 'my-task'), { recursive: true });
      await symlink(real, join(base, 'link'));
      const cmd = { agent_extra_args: ['--settings', JSON.stringify({ permissions: { deny: [] } })] } as unknown as Command;
      await addProjectRootWriteDenies(cmd, join(base, 'link', '.lazy', 'worktrees', 'my-task'));
      const deny: string[] = JSON.parse((cmd as { agent_extra_args: string[] }).agent_extra_args[1]!).permissions.deny;
      for (const root of [join(base, 'link'), real]) {
        expect(denied(deny, 'Edit', `${root}/lazy.toml`)).toBe(true);
        expect(denied(deny, 'Edit', `${root}/.lazy/worktrees/my-task/a`)).toBe(false);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('does nothing outside a lazy task worktree or without host settings', async () => {
    const args = ['--settings', '{"permissions":{"deny":[]}}'];
    const cmd = { agent_extra_args: [...args] } as unknown as Command;
    await addProjectRootWriteDenies(cmd, '/somewhere/else');
    expect((cmd as { agent_extra_args: string[] }).agent_extra_args).toEqual(args);
    const container = { agent_extra_args: ['--x'] } as unknown as Command;
    await addProjectRootWriteDenies(container, '/p/.lazy/worktrees/t');
    expect((container as { agent_extra_args: string[] }).agent_extra_args).toEqual(['--x']);
  });
});

describe('boundary guard project-root probe settings', () => {
  // INVARIANT: the guard probes the rules projectRootWriteDenyRules emits, not
  // a hand-maintained copy, so it cannot verify a boundary nobody ships.
  test('are the emitted rules for the probe placeholder scope', () => {
    expect(JSON.parse(probeRootSettingsJson()).permissions.deny).toEqual(
      projectRootWriteDenyRules(PROBE_PROJECT_ROOT_SCOPE),
    );
  });
});

describe('home dir write rules', () => {
  const HOME = '/home/u';
  const HOME_RULES = projectRootWriteDenyRules({ ...SCOPE, homeDirs: [HOME] });

  // INVARIANT: a host-runner agent's file tools cannot write the user's home
  // outside the way down to its own worktree. The fixed sensitive-path list
  // names only a few stores; ~/.gitconfig (core.fsmonitor), ~/.zshenv and
  // ~/Library/LaunchAgents each run code outside the sandbox, and the boundary
  // guard's `deny / write-TOOL` vector writes straight into $HOME.
  test.each([
    '.gitconfig',
    '.zshenv',
    '.bash_profile',
    'Library/LaunchAgents/evil.plist',
    '.config/git/config',
    '.local/bin/git',
    'lazy-escape-123.txt',
    'proj2/lazy.toml',
    'pro/x',
    'other/proj/x',
    '.npm/other',
    '.lazy/host-boundary-guard.json',
  ])('denies ~/%s', (rel) => {
    expect(denied(HOME_RULES, 'Edit', `${HOME}/${rel}`)).toBe(true);
  });

  // INVARIANT: the home rules keep the way down to the worktree, or they would
  // deny the worktree itself and brick every host agent.
  test.each([
    'proj/.lazy/worktrees/fix-thing/a.ts',
    'proj/.git/objects/ab/cd',
    '.npm/_logs/debug.log',
  ])('leaves ~/%s writable', (rel) => {
    expect(denied(HOME_RULES, 'Edit', `${HOME}/${rel}`)).toBe(false);
  });

  test('still applies the project-root rules under home', () => {
    expect(denied(HOME_RULES, 'Edit', `${HOME}/proj/lazy.toml`)).toBe(true);
    expect(denied(HOME_RULES, 'Edit', `${HOME}/proj/.lazy/worktrees/other/x`)).toBe(true);
  });

  test('denies all of home when the project lives elsewhere', () => {
    const rules = projectRootWriteDenyRules({ ...SCOPE, projectRoots: ['/srv/proj'], homeDirs: [HOME] });
    expect(denied(rules, 'Edit', `${HOME}/proj/.lazy/worktrees/fix-thing/a`)).toBe(true);
    expect(denied(rules, 'Edit', '/srv/proj/.lazy/worktrees/fix-thing/a')).toBe(false);
  });

  test('keeps the root under every home spelling', () => {
    const rules = projectRootWriteDenyRules({
      ...SCOPE, projectRoots: [ROOT, '/real/home/u/proj'], homeDirs: [HOME, '/real/home/u'],
    });
    expect(denied(rules, 'Edit', '/real/home/u/proj/.lazy/worktrees/fix-thing/a')).toBe(false);
    expect(denied(rules, 'Edit', '/real/home/u/.gitconfig')).toBe(true);
  });
});

/**
 * Claude Code's glob-to-regex step for the macOS Seatbelt profile, copied from
 * its 2.1.282 bundle. On macOS every glob `Edit` deny also becomes a Seatbelt
 * `(regex …)` write deny for Bash, JSON.stringified into the profile. It
 * escapes `.^$+{}()|\` and rewrites `*` / `?` even inside a character class.
 */
function claudeSeatbeltRegex(glob: string): string {
  return '^' + glob
    .replace(/[.^$+{}()|\\]/g, '\\$&')
    .replace(/\[([^\]]*?)$/g, '\\[$1')
    .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__GLOBSTAR_SLASH__/g, '(.*/)?')
    .replace(/__GLOBSTAR__/g, '.*') + '$';
}

/** The deny regex as a POSIX bracket reads it: a backslash in a class is literal. */
function posixBrackets(re: string): RegExp {
  let out = '';
  let inClass = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i]!;
    if (!inClass && c === '\\') { out += c + re[++i]; continue; }
    if (!inClass && c === '[') { inClass = true; out += c; if (re[i + 1] === '^') { out += '^'; i++; } continue; }
    if (inClass && c === ']') { inClass = false; out += c; continue; }
    out += inClass && c === '\\' ? '\\\\' : c;
  }
  return new RegExp(out.slice(0, -1) + '(/.*)?$');
}

describe('rules survive Claude Code\'s macOS Seatbelt conversion', () => {
  const RULES_H = projectRootWriteDenyRules({ ...SCOPE, homeDirs: ['/home/u'] });
  const globs = [...new Set(RULES_H.map((r) => r.replace(/^(Edit|Write)\(\//, '').slice(0, -1)))];

  // INVARIANT: no emitted pattern carries a character JSON.stringify escapes.
  // Claude Code writes the Seatbelt regex with JSON.stringify, and a `\u0001`
  // is not an SBPL string escape: the class starting at U+0001 is what left
  // Bash unable to run (`root / control` BLOCKED) on a Mac.
  test('no control characters, quotes or backslashes reach the profile', () => {
    for (const g of globs) {
      expect(JSON.stringify(claudeSeatbeltRegex(g))).not.toMatch(/\\u00[01]/);
      expect(g).not.toMatch(/[\u0000-\u001f"\\]/);
    }
  });

  // INVARIANT: the conversion leaves every class intact — no `*`/`?` rewritten
  // inside it, no escaped character as a range endpoint (a POSIX bracket reads
  // `\(` as a backslash, which moves the range end).
  test('classes carry no character the conversion rewrites at a range edge', () => {
    for (const g of globs) {
      for (const cls of g.match(/\[[^\]]*\]/g) ?? []) {
        expect(cls).not.toMatch(/[*?]/);
        expect(cls.slice(1, -1)).not.toMatch(/[.^$+{}()|\\-]-|-[.^$+{}()|\\]/);
      }
    }
  });

  const keptH = ['/home/u/proj/.lazy/worktrees/fix-thing/a.ts', '/home/u/proj/.git/index', '/home/u/proj/.git/objects/ab/cd'];
  const deniedH = ['/home/u/proj/lazy.toml', '/home/u/.gitconfig', '/home/u/proj/.lazy/worktrees/fix-thin/a', '/home/u/proj/.lazy/recovery/x', '/home/u/-x', '/home/u/.env'];

  // INVARIANT: Bash (Seatbelt) and the file tools deny the same paths — the
  // worktree and `.git` stay writable so `git add` works, the rest is denied —
  // whichever way the engine reads a backslash in a class.
  test.each([['JS', (r: string) => new RegExp(r)], ['POSIX', posixBrackets]] as const)(
    'the %s reading keeps the worktree and .git and denies the rest', (_n, compile) => {
      const regexes = globs.map((g) => compile(claudeSeatbeltRegex(g).slice(0, -1) + '(/.*)?$'));
      for (const p of keptH) expect(regexes.filter((r) => r.test(p)).map(String)).toEqual([]);
      for (const p of deniedH) expect(regexes.some((r) => r.test(p))).toBe(true);
    },
  );
});

describe('non-glob rules as Claude Code resolves them', () => {
  // INVARIANT: no non-glob rule resolves to a directory holding the worktree.
  // Claude Code normalizes (and realpaths) a rule without * ? [ ], and on macOS
  // turns it into a Seatbelt `(subpath …)` write deny for Bash; a `<root>/.`
  // rule became `(subpath <root>)` and Bash could not write its own worktree
  // (`root / control` BLOCKED on a Mac).
  test.each([
    ['/home/u', '/home/u/proj'],
    ['/home/My Home', '/home/My Home/my proj'],
  ])('home %s, root %s', (home, root) => {
    const rules = projectRootWriteDenyRules({ ...SCOPE, projectRoots: [root], homeDirs: [home] });
    const literal = rules.map((r) => r.replace(/^(Edit|Write)\(\//, '').slice(0, -1)).filter((g) => !/[*?[\]]/.test(g));
    const kept = [`${root}/.lazy/worktrees/fix-thing/a.ts`, `${root}/.git/index`, `${root}/.git/objects/ab/cd`];
    for (const g of literal) {
      const sub = posix.normalize(g);
      for (const p of kept) expect(p === sub || p.startsWith(`${sub}/`)).toBe(false);
    }
    for (const r of rules) expect(r).not.toContain('"');
  });
});

describe('exact-prefix rules stay globs', () => {
  // INVARIANT: every complement rule is a glob to Claude Code (contains * ? or
  // [ ]). A non-glob rule is realpathed, so a planted symlink named like an
  // exact prefix (`~/pr` -> the project) would become, on macOS, a Seatbelt
  // subpath deny over the worktree. Only the fixed `.git/config` and
  // `.git/hooks` denies are literal, and those are meant to be exact.
  test('only the .git config/hooks denies are literal paths', () => {
    const rules = projectRootWriteDenyRules({ ...SCOPE, homeDirs: ['/home/u'] });
    const literal = [...new Set(rules.map((r) => r.replace(/^(Edit|Write)\(\//, '').slice(0, -1)).filter((g) => !/[*?[\]]/.test(g)))];
    expect(literal.sort()).toEqual([`${ROOT}/.git/config`, `${ROOT}/.git/hooks`]);
  });

  test('an exact prefix still denies exactly that name', () => {
    const rules = projectRootWriteDenyRules({ ...SCOPE, homeDirs: ['/home/u'] });
    expect(denied(rules, 'Edit', '/home/u/pr')).toBe(true);
    expect(denied(rules, 'Edit', '/home/u/pr/x')).toBe(true);
    expect(denied(rules, 'Edit', `${ROOT}/.lazy/worktrees/fix-thin`)).toBe(true);
  });
});
