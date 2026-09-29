import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  reconcileExcludeText, ensureLazyExclude, LAZY_EXCLUDE_BEGIN, LAZY_EXCLUDE_END, LAZY_RUNTIME_EXCLUDE_ENTRIES,
} from '../../src/git/lazy-exclude';

const BLOCK = [LAZY_EXCLUDE_BEGIN, ...LAZY_RUNTIME_EXCLUDE_ENTRIES, LAZY_EXCLUDE_END].join('\n') + '\n';

describe('reconcileExcludeText', () => {
  test('empty file gets exactly the block', () => {
    expect(reconcileExcludeText('')).toBe(BLOCK);
  });

  test('user lines are kept verbatim and the block appended', () => {
    expect(reconcileExcludeText('# comment\n*.o\n')).toBe('# comment\n*.o\n\n' + BLOCK);
  });

  // INVARIANT: the reconcile is idempotent and replaces a stale/edited block
  // in place of adding a second one — repeated daemon starts and worktree adds
  // must converge on one block.
  test('idempotent, and a stale block is swept', () => {
    const once = reconcileExcludeText('*.o\n');
    expect(reconcileExcludeText(once)).toBe(once);
    const stale = `*.o\n\n${LAZY_EXCLUDE_BEGIN}\n.old-entry\n${LAZY_EXCLUDE_END}\nafter\n`;
    expect(reconcileExcludeText(stale)).toBe('*.o\n\nafter\n\n' + BLOCK);
  });

  test('an unterminated block keeps the user lines after it', () => {
    const broken = `*.o\n${LAZY_EXCLUDE_BEGIN}\n.lazy-lock\nmine/\n`;
    expect(reconcileExcludeText(broken)).toBe('*.o\nmine/\n\n' + BLOCK);
  });
});

describe('ensureLazyExclude', () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };

  test('writes the common dir from a linked worktree and hides the sandbox there', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-exclude-')));
    const repo = join(dir, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', join(dir, 'wt'), '-b', 'task');
    const wt = join(dir, 'wt');

    expect(await ensureLazyExclude(wt)).toBe(true);
    expect(await ensureLazyExclude(repo)).toBe(false);
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf-8')).toContain(BLOCK);

    await mkdir(join(wt, '.lazy-task-sandbox'));
    await writeFile(join(wt, '.lazy-task-sandbox', '.claude.json'), '{}');
    await writeFile(join(wt, '.lazy-lock'), '1');
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');

    // INVARIANT: .lazy/ runtime state is excluded but .lazy/plugins/ stays
    // committable — projects commit their proxy plugins there, and a blanket
    // directory exclude would make any re-include impossible.
    await mkdir(join(wt, '.lazy', 'plugins'), { recursive: true });
    await mkdir(join(wt, '.lazy', 'worktrees', 'x'), { recursive: true });
    await writeFile(join(wt, '.lazy', 'plugins', 'x.ts'), 'export default {};');
    await writeFile(join(wt, '.lazy', 'worktrees', 'x', 'f'), '1');
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('?? .lazy/plugins/x.ts');
  });
});
