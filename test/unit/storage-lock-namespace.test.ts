/**
 * Which recorded lock holders this side may judge, reclaim or must refuse
 * (judgeHolderNamespace, src/utils/process-identity.ts). A store is reached
 * from more than one pid namespace on Lazy Teams; only a holder that may
 * really be running out of sight is refused. A holder from an earlier boot or
 * a container gone since is dead and is reclaimed — whatever its pid now names
 * here.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { StorageLock, UnjudgeableStorageLockError } from '../../src/utils/storage-lock';
import { judgeHolderNamespace, processNamespaceId } from '../../src/utils/process-identity';
import { readRestoreInProgress, restoreMarkerPathFor } from '../../src/storage/store-backup';

const isLinux = process.platform === 'linux';
let dir: string;
const ENV = ['LAZY_MANAGED', 'LAZY_MANAGED_BACKEND'];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'lock-ns-')));
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(dir, { recursive: true, force: true });
});

async function own(): Promise<{ boot: string; ns: string }> {
  const id = (await processNamespaceId())!;
  const m = /^linux:([^:]+):(.+)$/.exec(id)!;
  return { boot: m[1], ns: m[2] };
}

const lockFile = () => join(dir, '.storage-lock');

describe.skipIf(!isLinux)('a lock from another pid namespace', () => {
  // INVARIANT: a lock left by this machine before a reboot or crash (another
  // boot id, no guest flag) is DEAD and is reclaimed even by a lock that
  // refuses foreign holders. Refusing it wedged every upgrade-start backup and
  // every store-backup/restore after a reboot until the lock was removed by hand.
  test('an earlier boot\'s lock is reclaimed — even when its pid is alive here', async () => {
    const { ns } = await own();
    // process.pid is certainly alive here: a recycled pid must not make it look held.
    await writeFile(lockFile(), JSON.stringify({ pid: process.ppid, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: `linux:00000000-earlier-boot:${ns}` }));
    const lock = new StorageLock(dir, dir, { foreignHolder: 'refuse', acquireTimeoutMs: 500 });
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile(), 'utf-8')).pid).toBe(process.pid);
    lock.release();
  });

  // INVARIANT: a lock a project's machine holds (holder_guest, another kernel)
  // may be alive where the host cannot see; a lock that refuses foreign holders
  // refuses it and leaves it exactly as it was.
  test('a guest\'s lock seen from the host is refused, untouched', async () => {
    const content = JSON.stringify({ pid: 999_999, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: 'linux:00000000-guest-boot:pid:[4026531836]', holder_guest: true });
    await writeFile(lockFile(), content);
    const lock = new StorageLock(dir, dir, { foreignHolder: 'refuse', acquireTimeoutMs: 500 });
    await expect(lock.acquire()).rejects.toBeInstanceOf(UnjudgeableStorageLockError);
    expect(await readFile(lockFile(), 'utf-8')).toBe(content);
  });

  // INVARIANT: an ordinary (judge-mode) open outside a project's machine never
  // reclaims that machine's lock either. Its pid is judged meaningless here, so
  // a live guest daemon's lock would be taken and two writers would run.
  test('a guest\'s lock seen from the host is refused by an ordinary open too', async () => {
    const content = JSON.stringify({ pid: 999_999, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: 'linux:00000000-guest-boot:pid:[4026531836]', holder_guest: true });
    await writeFile(lockFile(), content);
    const lock = new StorageLock(dir, dir, { acquireTimeoutMs: 500 });
    await expect(lock.acquire()).rejects.toBeInstanceOf(UnjudgeableStorageLockError);
    expect(await readFile(lockFile(), 'utf-8')).toBe(content);
  });

  test('same kernel, a pid namespace with no process left (a recreated container) is dead; ours is judgeable', async () => {
    const { boot, ns } = await own();
    // INVARIANT: only the initial pid namespace can see into its siblings. From
    // inside a container a neighbour's live namespace also shows no processes,
    // so an "empty" one is not evidence of death there: it is refused (foreign).
    const canSee = ns === 'pid:[4026531836]';
    expect(await judgeHolderNamespace({ namespace: `linux:${boot}:pid:[1]` })).toBe(canSee ? 'dead' : 'foreign');
    expect(await judgeHolderNamespace({ namespace: `linux:${boot}:${ns}` })).toBe('judgeable');
    expect(await judgeHolderNamespace({ namespace: null })).toBe('judgeable');
  });

  test('from inside a project\'s machine: the host\'s holder is foreign, its own earlier boot is dead', async () => {
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'microvm';
    const { ns } = await own();
    expect(await judgeHolderNamespace({ namespace: `linux:00000000-host-boot:${ns}` })).toBe('foreign');
    expect(await judgeHolderNamespace({ namespace: `linux:00000000-earlier-guest-boot:${ns}`, guest: true })).toBe('dead');
  });
});

describe.skipIf(!isLinux)('a holder in a still-populated sibling namespace', () => {
  const INITIAL = 'pid:[4026531836]';
  const SIB = 'pid:[4026539999]';
  const BOOT = '11111111-boot';
  const theirs = `linux:${BOOT}:${SIB}`;
  const seamFor = (procRoot: string, started = '100') => ({
    procRoot,
    ownNamespace: `linux:${BOOT}:${INITIAL}`,
    readIdentity: async () => ({ pid: 1, state: 'S', started, startedSource: 'proc' as const, command: 'lazy' }),
  });
  let proc: string;
  // Every real /proc lists init (pid 1) unless it hides other users' processes.
  beforeEach(async () => { proc = await mkdtemp(join(tmpdir(), 'fake-proc-')); await addProc(1, INITIAL, '1'); });
  afterEach(async () => { await rm(proc, { recursive: true, force: true }); });
  // A fake /proc entry: its namespace link (null = unreadable) and its NSpid line (null = unreadable status).
  async function addProc(pid: number, link: string | null, nspid: string | null) {
    await mkdir(join(proc, String(pid), 'ns'), { recursive: true });
    if (link !== null) await symlink(link, join(proc, String(pid), 'ns', 'pid'));
    if (nspid !== null) await writeFile(join(proc, String(pid), 'status'), `Name:\tx\nNSpid:\t${nspid}\n`);
  }
  const holder = (pid: number, started = '100') => ({ pid, started, startedSource: 'proc' as const });

  // INVARIANT: only the initial pid namespace judges a sibling; from inside a
  // nested one (this container) the answer is foreign, never "empty, so dead".
  test('a nested side refuses a sibling namespace', async () => {
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7) }, { ownNamespace: `linux:${BOOT}:pid:[4026532952]` })).toBe('foreign');
  });

  // INVARIANT: a dead holder in a container whose namespace still has other
  // processes is dead, so a version-change start on the host is not wedged.
  test('holder pid gone from a still-populated namespace is dead', async () => {
    await addProc(500, SIB, '500 1');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7) }, seamFor(proc))).toBe('dead');
  });

  test('holder pid present with the recorded start identity is foreign; a recycled pid is dead', async () => {
    await addProc(501, SIB, '501 7');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7, '100') }, seamFor(proc, '100'))).toBe('foreign');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7, '100') }, seamFor(proc, '999'))).toBe('dead');
  });

  test('a populated namespace with no recorded holder identity is foreign', async () => {
    await addProc(500, SIB, '500 1');
    expect(await judgeHolderNamespace({ namespace: theirs }, seamFor(proc))).toBe('foreign');
  });

  // INVARIANT: a namespace link this side may not read is not evidence of an
  // empty namespace; the process is matched through its status instead.
  test('an unreadable namespace link is never read as an empty namespace', async () => {
    await addProc(502, null, '502 7');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7, '100') }, seamFor(proc, '100'))).toBe('foreign');
    await rm(join(proc, '502'), { recursive: true });
    await addProc(503, null, '503 9');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7) }, seamFor(proc))).toBe('dead');
    expect(await judgeHolderNamespace({ namespace: theirs }, seamFor(proc))).toBe('foreign');
  });

  // INVARIANT: an unreadable-link process is never "the" holder. Inner pids
  // collide across containers, so a mismatching identity there proves nothing
  // about the real holder in another container: the answer is foreign.
  test('two unreadable nested processes with the same inner pid are foreign, even when the first mismatches', async () => {
    await addProc(510, null, '510 7');
    await addProc(511, null, '511 7');
    const seam = { ...seamFor(proc), readIdentity: async (pid: number) => ({ pid, state: 'S', started: pid === 510 ? '999' : '100', startedSource: 'proc' as const, command: 'lazy' }) };
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7, '100') }, seam)).toBe('foreign');
  });

  test('a readable mismatch does not prove the holder gone while an unreadable candidate exists', async () => {
    await addProc(520, SIB, '520 7');
    await addProc(521, null, '521 7');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7, '100') }, seamFor(proc, '999'))).toBe('foreign');
  });

  // INVARIANT: a process this side may not inspect at all (procfs `hidepid=1`:
  // neither its namespace link nor its status) may be the holder, so it is never
  // read as absent.
  test('a listed process with neither namespace link nor status readable is foreign', async () => {
    await addProc(530, null, null);
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7) }, seamFor(proc))).toBe('foreign');
  });

  // INVARIANT: a listing without pid 1 (procfs `hidepid=2` hides other users'
  // processes entirely) proves nothing about what is missing from it.
  test('a /proc listing without init is foreign', async () => {
    await rm(join(proc, '1'), { recursive: true });
    await addProc(500, SIB, '500 1');
    expect(await judgeHolderNamespace({ namespace: theirs, holder: holder(7) }, seamFor(proc))).toBe('foreign');
  });
});

describe('a holder on another OS kernel', () => {
  const MAC = 'darwin:AAAAAAAA-mac-boot';
  const CONTAINER = 'linux:11111111-vm-boot:pid:[4026532952]';
  // INVARIANT: a macOS host daemon and a Linux container sharing its store run
  // SIDE BY SIDE on different kernels, so a mismatch of OS kind is never "an
  // earlier boot". Reading it as dead let a container-side store backup or
  // restore reclaim a live Mac daemon's lock (and the reverse).
  test('a macOS holder seen from Linux, and a Linux holder seen from macOS, are foreign', async () => {
    expect(await judgeHolderNamespace({ namespace: MAC }, { ownNamespace: CONTAINER })).toBe('foreign');
    expect(await judgeHolderNamespace({ namespace: CONTAINER }, { ownNamespace: MAC })).toBe('foreign');
  });

  // INVARIANT: an earlier boot of the SAME machine stays reclaimable on both
  // OSes — refusing it wedged every backup/restore after a reboot.
  test('an earlier boot of the same kind of kernel is still dead', async () => {
    expect(await judgeHolderNamespace({ namespace: 'darwin:BBBBBBBB-earlier' }, { ownNamespace: MAC })).toBe('dead');
    expect(await judgeHolderNamespace({ namespace: 'linux:22222222-earlier:pid:[4026532952]' }, { ownNamespace: CONTAINER })).toBe('dead');
  });

  test('the refusal names the exact command that clears a stale lock, quoted for the shell', () => {
    expect(new UnjudgeableStorageLockError('/store/.storage-lock', 42, MAC).message).toContain('rm /store/.storage-lock\n');
    expect(new UnjudgeableStorageLockError("/my store/it's/.storage-lock", 42, MAC).message).toContain("rm '/my store/it'\\''s/.storage-lock'");
  });

  // The namespace of the OTHER OS kind than the one this test runs on.
  const otherOs = process.platform === 'linux' ? MAC : CONTAINER;

  // INVARIANT: a store backup/restore (foreignHolder 'refuse') never reclaims a
  // lock taken on another OS kernel, and leaves it exactly as it was.
  test('a refusing lock refuses a holder on the other OS kind, untouched', async () => {
    const content = JSON.stringify({ pid: 999_999, acquired_at: '2026-01-01T00:00:00Z', holder_namespace: otherOs });
    await writeFile(lockFile(), content);
    const lock = new StorageLock(dir, dir, { foreignHolder: 'refuse', acquireTimeoutMs: 500 });
    await expect(lock.acquire()).rejects.toBeInstanceOf(UnjudgeableStorageLockError);
    expect(await readFile(lockFile(), 'utf-8')).toBe(content);
  });

  // INVARIANT: a restore marker written on another OS kernel cannot be judged
  // here, so it reads as possibly-running, never as an interrupted restore.
  test('a restore marker from the other OS kind is not judgeable', async () => {
    await writeFile(restoreMarkerPathFor(dir), JSON.stringify({ pid: 999_999, holder_namespace: otherOs, started_at: 'x', backup: 'b', staging: 's', moved_aside_to: null }));
    const r = await readRestoreInProgress(dir);
    expect(r?.judgeable).toBe(false);
    expect(r?.alive).toBe(false);
  });
});
