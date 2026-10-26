import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';

isolateLazyEnv();

const entry = resolve(import.meta.dir, '../../src/index.ts');
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

test('fleet managed init leaves the committed checkout clean, including repeated setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-init-'));
  const repo = join(root, 'repo');
  try {
    git(root, 'init', repo);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await writeFile(join(repo, 'lazy.toml'), '[storage]\nbackend = "external"\nexternal_path = "/original/store"\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Project');
    for (let i = 0; i < 2; i++) {
      const p = Bun.spawn(['bun', 'run', entry, 'init', '--non-interactive', '--skip-auth-check', '--external-path', join(root, 'store')], {
        cwd: repo, env: { ...process.env, LAZY_TEST: '1', LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: join(root, 'store'), LAZY_MANAGED_CONFIG_PATH: join(root, 'config/lazy.toml') }, stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect({ code, err: code ? err + out : '' }).toEqual({ code: 0, err: '' });
      // INVARIANT: Teams setup never edits project files. A dirty main checkout blocks later updates.
      expect(git(repo, 'status', '--porcelain')).toBe('');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const humanEdit of [false, true]) {
  test(`managed setup recovery ${humanEdit ? 'preserves mixed human edits' : 'unblocks updates of main'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-recover-'));
    const repo = join(root, 'repo');
    const originalConfig = '[storage]\nbackend = "external"\nexternal_path = "/original/store"\n';
    const originalIgnore = 'node_modules/\n';
    const store = join(root, 'store');
    try {
      git(root, 'init', repo);
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      await writeFile(join(repo, '.gitignore'), originalIgnore);
      await writeFile(join(repo, 'lazy.toml'), originalConfig);
      git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Project');
      // The exact files the old fleet invocation left, independently specified.
      const dirtyIgnore = 'node_modules/\n.env\n.lazy-task-sandbox/\n.lazy-lock\n.lazy/\n' + (humanEdit ? 'my-private-files/\n' : '');
      const dirtyConfig = `[storage]\nbackend = "external"\nexternal_path = ${JSON.stringify(store)}\n` + (humanEdit ? '\n# my settings\n' : '');
      await writeFile(join(repo, '.gitignore'), dirtyIgnore);
      await writeFile(join(repo, 'lazy.toml'), dirtyConfig);
      const p = Bun.spawn(['bun', 'run', entry, 'init', '--non-interactive', '--skip-auth-check', '--external-path', store], {
        cwd: repo, env: { ...process.env, LAZY_TEST: '1', LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: store }, stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect({ code, err: code ? out + err : '' }).toEqual({ code: 0, err: '' });
      const { readFile } = await import('fs/promises');
      // INVARIANT: recovery accepts only byte-exact setup edits. Human input must survive unchanged.
      expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe(humanEdit ? dirtyIgnore : originalIgnore);
      expect(await readFile(join(repo, 'lazy.toml'), 'utf8')).toBe(humanEdit ? dirtyConfig : originalConfig);
      expect(git(repo, 'status', '--porcelain') === '').toBe(!humanEdit);
      if (!humanEdit) {
        // Apply an upstream commit touching both files, the operation the incident blocked.
        const upstream = join(root, 'upstream');
        git(root, 'clone', repo, upstream);
        git(upstream, 'config', 'user.email', 'test@example.com');
        git(upstream, 'config', 'user.name', 'Test');
        await writeFile(join(upstream, '.gitignore'), originalIgnore + 'dist/\n');
        await writeFile(join(upstream, 'lazy.toml'), originalConfig + '\n# upstream\n');
        git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Upstream update');
        git(repo, 'pull', '--ff-only', upstream);
        expect(git(repo, 'status', '--porcelain')).toBe('');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const driver of ['github', 'gitlab']) {
  for (const configured of [false, true]) {
    test(`managed init keeps ${driver} forge integration ${configured ? 'explicitly configured' : 'without a repository config'}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'managed-forge-'));
      const repo = join(root, 'repo');
      const configPath = join(root, 'config', 'lazy.toml');
      try {
        git(root, 'init', repo);
        git(repo, 'config', 'user.email', 'test@example.com');
        git(repo, 'config', 'user.name', 'Test');
        await writeFile(join(repo, 'README.md'), 'Project\n');
        const explicit = '[remote]\ndriver = "local"\n';
        if (configured) await writeFile(join(repo, 'lazy.toml'), explicit);
        git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Project');
        git(repo, 'remote', 'add', 'origin', `https://${driver}.com/example/project.git`);
        const env = { ...process.env, LAZY_TEST: '1', LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: join(root, 'store'), LAZY_MANAGED_CONFIG_PATH: configPath };
        async function run(args: string[]) {
          const p = Bun.spawn(['bun', ...args], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
          const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
          expect({ code, err: code ? err + out : '' }).toEqual({ code: 0, err: '' });
          return out;
        }
        await run(['run', entry, 'init', '--non-interactive', '--skip-auth-check']);
        const code = `import {loadConfig} from ${JSON.stringify(resolve(import.meta.dir, '../../src/config/loader.ts'))}; import {readProjectConfig} from ${JSON.stringify(resolve(import.meta.dir, '../../src/daemon/project-config.ts'))}; const root = process.cwd(); console.log(JSON.stringify({driver:(await loadConfig(root)).remote.driver, read:await readProjectConfig(root)}));`;
        const effective = JSON.parse(await run(['-e', code]));
        // INVARIANT: preserving a clean checkout must preserve forge integration, while explicit repository choices remain authoritative at import.
        expect(effective.driver).toBe(configured ? 'local' : driver);
        expect(effective.read.imported).toBe(!configured);
        expect(effective.read.repositoryToml).toBe(configured ? explicit : null);
        expect(effective.read.toml).toBe(configured ? explicit : `[remote]\ndriver = "${driver}"\n`);
        expect(git(repo, 'status', '--porcelain')).toBe('');
        if (!configured) {
          await writeFile(configPath, '[remote]\ndriver = "local"\n');
          await run(['run', entry, 'init', '--non-interactive', '--skip-auth-check']);
          expect(JSON.parse(await run(['-e', code])).driver).toBe('local');
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
