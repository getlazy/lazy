/**
 * `scripts/publish-lazy-daemon-image.sh --export-context` is what the
 * Docker-free smolvm build runs from, so it must describe exactly the build
 * the Docker path would run — and need no Docker to do it.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtemp, readFile, rm, stat, realpath, symlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/publish-lazy-daemon-image.sh');
const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

/** A PATH with git and the basics, and no docker anywhere on it. */
async function dockerFreePath(): Promise<string> {
  const bin = await realpath(await mkdtemp(join(tmpdir(), 'no-docker-bin-')));
  dirs.push(bin);
  for (const tool of ['git', 'tar', 'sort', 'awk', 'sha256sum', 'shasum', 'mktemp', 'mkdir', 'rm', 'cat', 'sed', 'tr', 'uname', 'dirname', 'basename', 'head', 'cut', 'date', 'bash', 'env', 'grep', 'wc', 'printf', 'ls', 'bun']) {
    const found = Bun.which(tool);
    if (found) await symlink(found, join(bin, tool)).catch(() => {});
  }
  return bin;
}

async function run(args: string[]) {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: await dockerFreePath() } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

describe('publish-lazy-daemon-image.sh --export-context', () => {
  test('writes the context and the same build description --dry-run computes, with no docker on PATH', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'export-ctx-')));
    dirs.push(dir);
    const dry = await run(['--dry-run', '--platform', 'linux/arm64']);
    expect(dry.code).toBe(0);
    const fingerprint = /lazySourceFingerprint=([0-9a-f]{16})/.exec(dry.out)![1];

    const r = await run(['--export-context', join(dir, 'x'), '--platform', 'linux/arm64']);
    expect(r.code).toBe(0);
    const args = (await readFile(join(dir, 'x/build-args'), 'utf8')).split('\n');
    expect(args.slice(0, 2)).toEqual(['--platform', 'linux/arm64']);
    expect(args).toContain(`LAZY_SOURCE_FINGERPRINT=${fingerprint}`);
    expect(args).toContain(`ghcr.io/getlazy/lazy-daemon:sha-${fingerprint}`);
    expect((await readFile(join(dir, 'x/dockerfile'), 'utf8')).trim()).toBe('lazy-teams/deploy/daemon-image/Dockerfile');
    expect((await readFile(join(dir, 'x/image-ref'), 'utf8')).trim()).toBe(`ghcr.io/getlazy/lazy-daemon:sha-${fingerprint}`);
    expect((await stat(join(dir, 'x/context/lazy-teams/deploy/daemon-image/Dockerfile'))).isFile()).toBe(true);
  });

  for (const extra of [['--save', '/tmp/x.tar'], ['--push'], ['--platform', 'linux/arm64,linux/amd64']]) {
    test(`refuses ${extra[0]}${extra[1] ? ' ' + extra[1] : ''}: it builds nothing`, async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'export-ctx-')));
      dirs.push(dir);
      const platform = extra.includes('--platform') ? [] : ['--platform', 'linux/arm64'];
      const r = await run(['--export-context', join(dir, 'x'), ...platform, ...extra]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/--export-context builds nothing|multi-platform build/);
      await expect(stat(join(dir, 'x/build-args'))).rejects.toThrow();
    });
  }

  test('refuses a directory that already holds a context', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'export-ctx-')));
    dirs.push(dir);
    await mkdir(join(dir, 'x/context'), { recursive: true });
    const r = await run(['--export-context', join(dir, 'x'), '--platform', 'linux/arm64']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('already exists');
  });
});
