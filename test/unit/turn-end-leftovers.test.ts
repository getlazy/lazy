import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectTurnEndLeftovers } from '../../src/supervisor/leftovers';

const dirs: string[] = [];
function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
}
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'turn-end-'));
  dirs.push(d);
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'f.txt'), 'base\n');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'base');
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('detectTurnEndLeftovers', () => {
  // INVARIANT: a worktree parked mid-merge records no uncommitted paths — they are
  // merge conflicts, not loose work — while ordinary dirt is still reported.
  test('ordinary dirt is reported', async () => {
    const d = repo();
    writeFileSync(join(d, 'loose.txt'), 'x\n');
    expect(await detectTurnEndLeftovers(d)).toEqual({ paths: ['loose.txt'], midMerge: false });
  });

  test('mid-merge records nothing and says why', async () => {
    const d = repo();
    git(d, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(d, 'f.txt'), 'side\n');
    git(d, 'commit', '-qam', 'side');
    git(d, 'checkout', '-q', 'main');
    writeFileSync(join(d, 'f.txt'), 'mine\n');
    git(d, 'commit', '-qam', 'mine');
    git(d, 'merge', '--no-edit', 'side');
    expect(await detectTurnEndLeftovers(d)).toEqual({ paths: null, midMerge: true });
  });
});
