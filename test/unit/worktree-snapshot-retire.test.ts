/**
 * Worktree snapshots have a lifecycle: once applied by an unblock (or found
 * already in the branch), or once a later turn of the session ends clean, a
 * snapshot is RETIRED and no unblock restores it again.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fsp from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { captureTurnEndWorktree, restoreWorktreeSnapshot } from '../../src/task/worktree-snapshot-restore';

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await proc.exited !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`);
}

describe('worktree snapshot lifecycle', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function setup() {
    dir = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'lazy-snapshot-retire-')));
    const store = join(dir, 'store');
    const wt = join(dir, 'wt');
    await fsp.mkdir(join(store, '.lazy'), { recursive: true });
    await fsp.mkdir(wt);
    await git(wt, 'init', '-q');
    await git(wt, 'config', 'user.email', 't@example.com');
    await git(wt, 'config', 'user.name', 'T');
    await fsp.writeFile(join(wt, 'a.txt'), 'one\n');
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-q', '-m', 'init');
    const storage = new FileStorage(store);
    const task = await storage.createTask('Snap', undefined, undefined, 'snap', undefined, undefined, 'human', { prompt: 'p' });
    const session = await storage.createSession(task.id, 'claude', 'lazy/snap', 'HEAD');
    return { storage, session, wt };
  }

  // INVARIANT: a restored snapshot is restored ONCE. A human who reads the
  // restored edits and deliberately reverts them must not get them back at the
  // next unblock — no work turn ran in between, so only the lifecycle can tell.
  test('restore consumes the snapshot; a revert then stays reverted', async () => {
    const { storage, session, wt } = await setup();
    await fsp.writeFile(join(wt, 'a.txt'), 'two\n');
    expect(await captureTurnEndWorktree(storage, session.id, 1, wt)).toBe('captured');
    await git(wt, 'checkout', '--', 'a.txt');

    const first = await restoreWorktreeSnapshot(storage, session.id, wt, 'snap');
    expect(first.warning).toBe('Restored uncommitted changes from backup.');
    expect(await fsp.readFile(join(wt, 'a.txt'), 'utf8')).toBe('two\n');
    const latest = await storage.getLatestWorktreeSnapshot(session.id);
    expect(latest?.retired_reason).toBe('consumed');
    expect(latest?.uncommitted_diff).toContain('two'); // content kept for recovery

    await git(wt, 'checkout', '--', 'a.txt'); // the human discards it on purpose
    expect(await restoreWorktreeSnapshot(storage, session.id, wt, 'snap')).toEqual({});
    expect(await fsp.readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\n');
  });

  // INVARIANT: a snapshot already in the branch is consumed SILENTLY — it is
  // the echo of the work being committed, never reported as a loss.
  test('already in the branch: consumed, no warning', async () => {
    const { storage, session, wt } = await setup();
    await fsp.writeFile(join(wt, 'a.txt'), 'two\n');
    await captureTurnEndWorktree(storage, session.id, 1, wt);
    await git(wt, 'commit', '-q', '-am', 'commit it');

    expect(await restoreWorktreeSnapshot(storage, session.id, wt, 'snap')).toEqual({});
    expect((await storage.getLatestWorktreeSnapshot(session.id))?.retired_reason).toBe('consumed');
  });

  // INVARIANT: a patch that genuinely fails stays LIVE and the warning names
  // its files — the human is pointed at a snapshot that still holds them.
  test('genuine failure: warned with files, snapshot stays live', async () => {
    const { storage, session, wt } = await setup();
    await fsp.writeFile(join(wt, 'a.txt'), 'two\n');
    await captureTurnEndWorktree(storage, session.id, 1, wt);
    await fsp.writeFile(join(wt, 'a.txt'), 'three\n');
    await git(wt, 'commit', '-q', '-am', 'diverge');

    const result = await restoreWorktreeSnapshot(storage, session.id, wt, 'snap');
    expect(result.warning).toContain('Could not restore uncommitted changes from backup');
    expect(result.warning).toContain('a.txt');
    expect((await storage.getLatestWorktreeSnapshot(session.id))?.retired_at).toBeUndefined();
  });

  // INVARIANT: a turn that ends CLEAN supersedes every live snapshot of the
  // session; the worktree moved on without those edits.
  test('a clean turn end supersedes; a superseded snapshot is never restored', async () => {
    const { storage, session, wt } = await setup();
    await fsp.writeFile(join(wt, 'a.txt'), 'two\n');
    await captureTurnEndWorktree(storage, session.id, 1, wt);
    await git(wt, 'checkout', '--', 'a.txt');
    expect(await captureTurnEndWorktree(storage, session.id, 1, wt)).toBe('superseded');
    expect((await storage.getLatestWorktreeSnapshot(session.id))?.retired_reason).toBe('superseded');

    expect(await restoreWorktreeSnapshot(storage, session.id, wt, 'snap')).toEqual({});
    expect(await fsp.readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\n');
  });

  test('retire by id keeps an earlier reason; supersede touches only live ones', async () => {
    const { storage, session } = await setup();
    await storage.createWorktreeSnapshot(session.id, 1, 'diff-a', ' M a');
    const b = await storage.createWorktreeSnapshot(session.id, 3, 'diff-b', ' M b');

    expect(await storage.retireWorktreeSnapshots(session.id, 'consumed', b.id)).toBe(1);
    expect(await storage.retireWorktreeSnapshots(session.id, 'superseded')).toBe(1);
    expect((await storage.getWorktreeSnapshotForTurn(session.id, 1))?.retired_reason).toBe('superseded');
    expect((await storage.getWorktreeSnapshotForTurn(session.id, 3))?.retired_reason).toBe('consumed');
    expect(await storage.retireWorktreeSnapshots(session.id, 'superseded')).toBe(0);
  });
});
