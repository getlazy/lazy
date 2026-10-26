import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'bun';
import { readOpenedNoFollow, readWorktreeBytesNoFollow } from '../../src/review/worktree-read';

// INVARIANT: what is read is judged by the opened handle, never by an earlier
// lstat of an agent-writable path — a symlink, FIFO or device swapped in
// between the two must be refused, not followed, hung on, or read unbounded.
describe('no-follow reads through one handle', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-read-'));
    await writeFile(join(dir, 'real.png'), new Uint8Array([1, 2, 3]));
    await symlink(join(dir, 'real.png'), join(dir, 'link.png'));
    expect(spawnSync(['mkfifo', join(dir, 'pipe.png')]).exitCode).toBe(0);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test('reads a regular file', async () => {
    expect(await readOpenedNoFollow(join(dir, 'real.png'), 10)).toEqual({ kind: 'content', bytes: new Uint8Array([1, 2, 3]) });
  });

  test('refuses a symlink at the final component', async () => {
    expect(await readOpenedNoFollow(join(dir, 'link.png'), 10)).toEqual({ kind: 'notRegular' });
  });

  test('refuses a FIFO without blocking', async () => {
    expect(await readOpenedNoFollow(join(dir, 'pipe.png'), 10)).toEqual({ kind: 'notRegular' });
  });

  test('refuses a device', async () => {
    expect(await readOpenedNoFollow('/dev/zero', 10)).toEqual({ kind: 'notRegular' });
  });

  test('honours the cap on the handle', async () => {
    expect(await readOpenedNoFollow(join(dir, 'real.png'), 2)).toEqual({ kind: 'tooLarge', size: 3 });
    expect(await readWorktreeBytesNoFollow(dir, 'real.png', 2)).toEqual({ kind: 'tooLarge', size: 3 });
  });
});
