/**
 * Accept's question about the task branch on origin (src/remote/origin-branch-probe.ts).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { probeOriginBranch } from '../../src/remote/origin-branch-probe';

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

describe('probing a branch on origin', () => {
  let dir: string | null = null;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

  // INVARIANT: an unreachable origin is never reported as "branch absent".
  // Accept treats absent as nothing-to-bring-in; reading unreachable that way
  // squashes past commits pushed to the task and drops them.
  test('present, absent and unreachable are told apart', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-probe-')));
    const bare = join(dir, 'origin.git');
    const work = join(dir, 'work');
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    git(dir, 'init', '-q', '-b', 'main', work);
    git(work, 'config', 'user.email', 't@e'); git(work, 'config', 'user.name', 't');
    await writeFile(join(work, 'a'), '1');
    git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
    git(work, 'remote', 'add', 'origin', bare);
    git(work, 'push', '-q', 'origin', 'main');

    expect(await probeOriginBranch('origin', 'main', work)).toEqual({ kind: 'present' });
    expect(await probeOriginBranch('origin', 'lazy/never-pushed', work)).toEqual({ kind: 'absent' });
    git(work, 'remote', 'set-url', 'origin', join(dir, 'gone.git'));
    expect((await probeOriginBranch('origin', 'main', work)).kind).toBe('unreachable');
  });
});
