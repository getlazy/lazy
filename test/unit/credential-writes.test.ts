import { expect, test } from 'bun:test';
import { access, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { FileBackend } from '../../src/credentials/backends';
import { spawn } from '../../src/utils/spawn';
import { credentialHint, getStoredCredential, readCredentialIndex, setCredential } from '../../src/credentials/store';
import { getCredentialLockPath, replaceCredentialFile, withCredentialFileLock } from '../../src/credentials/file-updates';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getCredentialIndexPath, getCredentialsPath, getDaemonDir } from '../../src/daemon/paths';
import { pruneDaemonRuntime } from '../../src/daemon/prune';

test.each(['file', 'store', 'mixed', 'rotation'])('INVARIANT: two real %s writers preserve every unrelated record', async (target) => {
  const directory = await mkdtemp('/tmp/lazy-credential-writes-');
  const projectRoot = join(directory, 'project');
  const environment = { ...process.env, LAZY_DAEMON_BASE_DIR: join(directory, 'daemon') };
  const restore = pinDaemonBaseDir(environment.LAZY_DAEMON_BASE_DIR);
  await setCredential(projectRoot, { provider: 'unrelated', kind: 'api-key', secret: 'unrelated-secret' }, 'file');
  const barrier = join(directory, 'start');
  const workers = ['first', 'second'].map((prefix) => spawn(
    [process.execPath, resolve('test/fixtures/credential-writer.ts'), projectRoot, prefix, barrier, target],
    { env: environment, stdout: 'pipe', stderr: 'pipe' },
  ));
  try {
    await writeFile(barrier, 'start');
    for (const worker of workers) {
      const stderr = await new Response(worker.stderr).text();
      expect({ exitCode: await worker.exited, stderr }).toEqual({ exitCode: 0, stderr: '' });
    }
    const backend = new FileBackend();
    expect(await backend.get(projectRoot, 'unrelated')).toBe('unrelated-secret');
    if (target === 'rotation') {
      const stored = await getStoredCredential(projectRoot, 'shared');
      expect(stored?.value).toMatch(/^secret-(first|second)-29$/);
      const entries = await readCredentialIndex(projectRoot);
      expect(entries.length).toBe(2);
      expect(entries.find((entry) => entry.provider === 'shared')?.hint).toBe(credentialHint(stored!.value));
      return;
    }
    for (const prefix of ['first', 'second']) {
      for (let iteration = 0; iteration < 30; iteration++) {
        const provider = `${prefix}-${iteration}`;
        const removed = (target === 'mixed' || target === 'file') && iteration % 2 === 0;
        expect(await backend.get(projectRoot, provider)).toBe(removed ? null : `secret-${provider}`);
      }
    }
    if (target !== 'file') {
      const entries = await readCredentialIndex(projectRoot);
      const expected = target === 'mixed' ? 31 : 61;
      expect(entries.length).toBe(expected);
      expect(new Set(entries.map((entry) => entry.provider)).size).toBe(expected);
    }
  } finally {
    for (const worker of workers) {
      if (worker.exitCode === null) worker.kill();
      await worker.exited;
    }
    restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(['credentials.json', 'credential-index.json'])(
  'INVARIANT: killing a writer mid-write preserves complete %s and releases its lock',
  async (filename) => {
    const directory = await mkdtemp('/tmp/lazy-credential-interrupted-');
    const path = join(directory, filename);
    const barrier = join(directory, 'partial');
    const original = '{"unrelated":"original-secret"}\n';
    await writeFile(path, original, { mode: 0o600 });
    const worker = spawn(
      [process.execPath, resolve('test/fixtures/credential-writer.ts'), path, 'first', barrier, 'interrupt'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const deadline = performance.now() + 5_000;
      while (true) {
        try {
          await access(barrier);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (worker.exitCode !== null || performance.now() > deadline) {
            if (worker.exitCode === null) worker.kill('SIGKILL');
            throw new Error(`Writer did not reach the interrupted-write barrier: ${await new Response(worker.stderr).text()}`);
          }
          await Bun.sleep(5);
        }
      }
      expect(await readFile(path, 'utf8')).toBe(original);
      const temporaryFiles = (await readdir(directory)).filter((name) => name.endsWith('.tmp'));
      expect(temporaryFiles.length).toBe(1);
      expect((await stat(join(directory, temporaryFiles[0]))).mode & 0o777).toBe(0o600);
      expect(worker.exitCode).toBeNull();
      await expect(withCredentialFileLock(path, async () => {}, 30)).rejects.toThrow('Timed out waiting');
      worker.kill('SIGKILL');
      await worker.exited;
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ unrelated: 'original-secret' });
      const lockPath = await getCredentialLockPath(path);
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, started: 'recycled-pid' }));
      await withCredentialFileLock(path, () => replaceCredentialFile(path, original));
      expect(await readFile(path, 'utf8')).toBe(original);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    } finally {
      if (worker.exitCode === null) worker.kill('SIGKILL');
      await worker.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('atomic replacement tightens an existing permissive credential file', async () => {
  const directory = await mkdtemp('/tmp/lazy-credential-permissions-');
  const path = join(directory, 'credentials.json');
  try {
    await writeFile(path, '{}', { mode: 0o644 });
    await replaceCredentialFile(path, '{"secret":"value"}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ secret: 'value' });
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('credential locks exclude other callers in the same process and release after failure', async () => {
  const directory = await mkdtemp('/tmp/lazy-credential-lock-');
  const path = join(directory, 'credentials.json');
  try {
    await expect(withCredentialFileLock(path, async () => {
      await expect(withCredentialFileLock(path, async () => {}, 30)).rejects.toThrow('Timed out waiting');
      throw new Error('write failed');
    })).rejects.toThrow('write failed');
    expect(await withCredentialFileLock(path, async () => 'released')).toBe('released');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('INVARIANT: daemon pruning preserves persistent credential locks, including held locks', async () => {
  const directory = await mkdtemp('/tmp/lazy-credential-prune-');
  const restore = pinDaemonBaseDir(join(directory, 'daemon'));
  const projectRoot = join(directory, 'project');
  try {
    await setCredential(projectRoot, { provider: 'unrelated', kind: 'api-key', secret: 'unrelated-secret' }, 'file');
    for (const path of [getCredentialIndexPath(projectRoot), getCredentialsPath(projectRoot)]) {
      const lockPath = await getCredentialLockPath(path);
      const inode = (await stat(lockPath)).ino;
      await withCredentialFileLock(path, async () => {
        expect(await pruneDaemonRuntime(getDaemonDir(projectRoot))).toBe(false);
        expect((await stat(lockPath)).ino).toBe(inode);
        await expect(withCredentialFileLock(path, async () => {}, 30)).rejects.toThrow('Timed out waiting');
      });
      expect(await withCredentialFileLock(path, async () => 'released')).toBe('released');
    }
    expect((await getStoredCredential(projectRoot, 'unrelated'))?.value).toBe('unrelated-secret');
  } finally {
    restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('INVARIANT: credential locks never live under the data directory and canonical aliases share a lock', async () => {
  const directory = await mkdtemp('/tmp/lazy-credential-local-lock-');
  const dataDirectory = join(directory, 'data');
  const path = join(dataDirectory, 'credentials.json');
  try {
    const lockPath = await getCredentialLockPath(path);
    await symlink(dataDirectory, join(directory, 'alias'));
    const aliasPath = join(directory, 'alias', 'credentials.json');
    expect(await getCredentialLockPath(aliasPath)).toBe(lockPath);
    expect(lockPath.startsWith(`${directory}/`)).toBe(false);
    await withCredentialFileLock(path, async () => {
      expect(await readdir(dataDirectory)).toEqual([]);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      expect((await stat(resolve(lockPath, '..'))).mode & 0o777).toBe(0o700);
      await expect(withCredentialFileLock(aliasPath, async () => {}, 30)).rejects.toThrow('Timed out waiting');
      await replaceCredentialFile(path, '{}');
      expect(await getCredentialLockPath(path)).toBe(lockPath);
    });
    expect(await readdir(dataDirectory)).toEqual(['credentials.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(['existing', 'dangling'])('INVARIANT: %s credential-file symlinks are refused without replacing them', async (targetKind) => {
  const directory = await mkdtemp('/tmp/lazy-credential-symlink-');
  const path = join(directory, 'credentials.json');
  const target = join(directory, 'target.json');
  try {
    if (targetKind === 'existing') await writeFile(target, '{"unrelated":"original"}');
    await symlink(target, path);
    let updated = false;
    await expect(withCredentialFileLock(path, async () => { updated = true; })).rejects.toThrow('symbolic links');
    await expect(replaceCredentialFile(path, '{}')).rejects.toThrow('symbolic links');
    expect(updated).toBe(false);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    if (targetKind === 'existing') expect(await readFile(target, 'utf8')).toBe('{"unrelated":"original"}');
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('INVARIANT: a queued credential writer refuses a symlink introduced while waiting', async () => {
  const directory = await mkdtemp('/tmp/lazy-credential-queued-symlink-');
  const path = join(directory, 'credentials.json');
  const target = join(directory, 'target.json');
  let queued: Promise<void> | undefined;
  try {
    await writeFile(path, '{}');
    await writeFile(target, '{"unrelated":"original"}');
    await withCredentialFileLock(path, async () => {
      queued = withCredentialFileLock(path, () => replaceCredentialFile(path, '{"lost":true}'));
      await Bun.sleep(30);
      await unlink(path);
      await symlink(target, path);
    });
    await expect(queued!).rejects.toThrow('symbolic links');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('{"unrelated":"original"}');
  } finally {
    await queued?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
