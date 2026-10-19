import { afterAll, describe, expect, test } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realIdentity from '../../src/utils/process-identity';

const real = { ...realIdentity };
let duringJudgement: (() => void) | null = null;
await mockModule('../../src/utils/process-identity', () => ({
  ...real,
  judgeHolderNamespace: async (...args: Parameters<typeof real.judgeHolderNamespace>) => {
    const verdict = await real.judgeHolderNamespace(...args);
    duringJudgement?.();
    duringJudgement = null;
    return verdict;
  },
}));

const { StorageLock } = await import('../../src/utils/storage-lock');

const dir = await mkdtemp(join(tmpdir(), 'lock-race-'));
afterAll(async () => {
  restoreMockedModules();
  await rm(dir, { recursive: true, force: true });
});

describe('reclaiming a stale storage lock', () => {
  // INVARIANT: a process reclaiming a stale lock removes only the file it judged
  // stale. Judging awaits, and a racing process may meanwhile have reclaimed the
  // same stale lock and written its own live one; unlinking that lets two writers run.
  test('never removes a lock another process took while this one was judging', async () => {
    const lockPath = join(dir, '.storage-lock');
    // A dead holder from an earlier boot of this kind of kernel: stale.
    await writeFile(lockPath, JSON.stringify({ pid: 999999, acquired_at: new Date().toISOString() }));
    // The racer is a real live process carrying its recorded start identity, so
    // it is judged alive by the primary pid+start-time test. (It used to be
    // process.ppid with no identity, which fell to the "is that command a lazy
    // process" backstop — whatever launched `bun test` decided the outcome, and
    // under a plain shell script the racer read as dead and was reclaimed.)
    const holder = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const identity = await real.readProcessIdentity(holder.pid);
      expect(identity?.started).toBeTruthy();
      const racer = JSON.stringify({
        pid: holder.pid,
        acquired_at: new Date().toISOString(),
        holder_started_at: identity!.started,
        holder_start_source: identity!.startedSource,
      });
      duringJudgement = () => writeFileSync(lockPath, racer);
      const lock = new StorageLock(dir, dir, { acquireTimeoutMs: 300 });
      await expect(lock.acquire()).rejects.toThrow(/Failed to acquire storage lock/);
      expect(await readFile(lockPath, 'utf-8')).toBe(racer);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
});
