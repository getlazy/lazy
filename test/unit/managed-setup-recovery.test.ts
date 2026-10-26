import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, symlink, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { recoverManagedSetup } from '../../src/git/managed-setup';

function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', ...args], { cwd: root });
  if (p.exitCode) throw new Error(p.stderr.toString());
}

for (const scenario of ['staged', 'staged-only', 'symlink', 'mode', 'invalid-utf8', 'untracked']) {
  test(`managed recovery leaves ${scenario} changes untouched`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-recovery-'));
    const oldManaged = process.env.LAZY_MANAGED;
    const oldStore = process.env.LAZY_MANAGED_STORAGE_PATH;
    try {
      process.env.LAZY_MANAGED = '1';
      process.env.LAZY_MANAGED_STORAGE_PATH = join(root, 'store');
      git(root, 'init'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'Test');
      const file = join(root, '.gitignore');
      await writeFile(file, 'node_modules/\n');
      if (scenario !== 'untracked') git(root, 'add', '.gitignore');
      git(root, 'commit', '--allow-empty', '-m', 'Project');
      await writeFile(file, 'node_modules/\n.env\n.lazy-task-sandbox/\n.lazy-lock\n.lazy/\n');
      if (scenario === 'staged' || scenario === 'staged-only') git(root, 'add', '.gitignore');
      if (scenario === 'staged-only') await writeFile(file, 'node_modules/\n');
      if (scenario === 'mode') await chmod(file, 0o755);
      if (scenario === 'invalid-utf8') await writeFile(file, Buffer.from([0xff, 0xfe]));
      if (scenario === 'symlink') {
        await rm(file);
        await writeFile(join(root, 'outside'), 'precious\n');
        await symlink(join(root, 'outside'), file);
      }
      const before = await readFile(file);
      const result = await recoverManagedSetup(root, true);
      // INVARIANT: a plausible setup edit is insufficient when staged, linked, or otherwise changed. Never discard human work.
      expect(result.restored).toEqual([]);
      expect(result.untouched).toEqual(['.gitignore']);
      expect(await readFile(file)).toEqual(before);
    } finally {
      if (oldManaged === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = oldManaged;
      if (oldStore === undefined) delete process.env.LAZY_MANAGED_STORAGE_PATH; else process.env.LAZY_MANAGED_STORAGE_PATH = oldStore;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const file of ['.gitignore', 'lazy.toml']) {
  test(`managed recovery restores non-UTF-8 committed ${file} byte-for-byte`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-blob-'));
    const saved = [process.env.LAZY_MANAGED, process.env.LAZY_MANAGED_STORAGE_PATH];
    try {
      const store = join(root, 'store');
      process.env.LAZY_MANAGED = '1';
      process.env.LAZY_MANAGED_STORAGE_PATH = store;
      git(root, 'init'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'Test');
      const suffix = file === '.gitignore' ? '' : '[storage]\nbackend = "external"\nexternal_path = "/author/store"\n';
      const original = Buffer.concat([Buffer.from([35, 32, 0xff, 10]), Buffer.from(suffix)]);
      await writeFile(join(root, file), original);
      git(root, 'add', file); git(root, 'commit', '-m', 'Original bytes');
      expect((await recoverManagedSetup(root, true)).untouched).toEqual([]);
      // Historical init decoded UTF-8 before writing, replacing the invalid comment byte.
      const dirty = file === '.gitignore'
        ? '# \ufffd\n.env\n.lazy-task-sandbox/\n.lazy-lock\n.lazy/\n'
        : `# \ufffd\n[storage]\nbackend = "external"\nexternal_path = ${JSON.stringify(store)}\n`;
      await writeFile(join(root, file), dirty);
      const recovered = await recoverManagedSetup(root, true);
      // INVARIANT: recovering setup must restore the committed bytes, not replacement characters produced by text decoding.
      expect(recovered.restored).toEqual([file]);
      expect(await readFile(join(root, file))).toEqual(original);
      const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root });
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toBe('');
    } finally {
      if (saved[0] === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved[0];
      if (saved[1] === undefined) delete process.env.LAZY_MANAGED_STORAGE_PATH; else process.env.LAZY_MANAGED_STORAGE_PATH = saved[1];
      await rm(root, { recursive: true, force: true });
    }
  });
}
