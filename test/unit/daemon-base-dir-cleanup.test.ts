import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupPinnedDaemonBaseDir, makeDaemonBaseDir, pinDaemonBaseDir } from '../helpers/daemon-base-dir';

// INVARIANT: failed hardware teardown must restore the outer daemon directory,
// while daemon cleanup still runs under the fixture's pin to find its pidfile.
for (const prior of [undefined, '/outer-daemon-base']) {
  test(`failed cleanup restores ${prior ?? 'an unset daemon directory'}`, async () => {
    const original = process.env.LAZY_DAEMON_BASE_DIR;
    const dir = await makeDaemonBaseDir();
    if (prior === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prior;
    const unpin = pinDaemonBaseDir(dir);
    const failure = new Error('machine deletion failed');
    const calls: string[] = [];
    try {
      await expect(cleanupPinnedDaemonBaseDir(dir, unpin, async () => {
        calls.push('daemon');
        expect(process.env.LAZY_DAEMON_BASE_DIR).toBe(dir);
        await writeFile(join(dir, 'daemon-cleaned'), 'done');
        calls.push('machine');
        throw failure;
      })).rejects.toBe(failure);
      expect(calls).toEqual(['daemon', 'machine']);
      expect(process.env.LAZY_DAEMON_BASE_DIR).toBe(prior);
      expect(await Bun.file(join(dir, 'daemon-cleaned')).exists()).toBe(false);
    } finally {
      unpin();
      if (original === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// INVARIANT: removing the fixture directory may fail too; restoring the pin
// must happen first so the next suite never inherits that failure's directory.
test('a directory removal error still restores the daemon environment', async () => {
  const original = process.env.LAZY_DAEMON_BASE_DIR;
  const root = await mkdtemp(join(tmpdir(), 'lazy-daemon-cleanup-'));
  const file = join(root, 'file');
  await writeFile(file, 'not a directory');
  const dir = join(file, 'child');
  const unpin = pinDaemonBaseDir(dir);
  try {
    await expect(cleanupPinnedDaemonBaseDir(dir, unpin, async () => {})).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(process.env.LAZY_DAEMON_BASE_DIR).toBe(original);
  } finally {
    unpin();
    await rm(root, { recursive: true, force: true });
  }
});
