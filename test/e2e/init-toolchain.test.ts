import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(cwd: string, args: string[], envOverrides?: Record<string, string | undefined>) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...envOverrides },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function initGitRepo(cwd: string) {
  Bun.spawnSync(['git', 'init'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'Initial commit'], { cwd });
}

describe('lazy init toolchain detection', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('detects rust from Cargo.toml', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Cargo.toml'), '[package]\nname = "foo"\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: rust (auto-detected)');

    const config = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(config).toContain('toolchain = "rust"');
  });

  test('detects ruby-rails-rust from Gemfile + Cargo.toml', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Gemfile'), 'source "https://rubygems.org"\n');
    await writeFile(join(tmpDir, 'Cargo.toml'), '[package]\nname = "ext"\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: ruby-rails-rust (auto-detected)');

    const config = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(config).toContain('toolchain = "ruby-rails-rust"');
  });

  test('detects base when no marker files present', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: base (auto-detected)');

    const config = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(config).toContain('toolchain = "base"');
  });

  test('--toolchain flag overrides auto-detection', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    // Has Cargo.toml (would auto-detect as rust), but override with node
    await writeFile(join(tmpDir, 'Cargo.toml'), '[package]\nname = "foo"\n');

    const result = await runLazy(tmpDir, ['init', '--toolchain', 'node', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: node (from --toolchain flag)');

    const config = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(config).toContain('toolchain = "node"');
  });

  test('--toolchain with invalid name fails', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--toolchain', 'foobar', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown toolchain "foobar"');
  });

  test('detects node from package.json', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'package.json'), '{"name": "foo"}\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: node (auto-detected)');
  });

  test('detects dotnet from .csproj file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'App.csproj'), '<Project></Project>\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: dotnet (auto-detected)');
  });

  test('--toolchain shows in help', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));

    const result = await runLazy(tmpDir, ['init', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--toolchain');
  });

  test('detects bun from bun.lockb', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'bun.lockb'), '');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: bun (auto-detected)');
  });

  test('detects go from go.mod', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'go.mod'), 'module example.com/foo\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: go (auto-detected)');
  });

  test('detects python from requirements.txt', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'requirements.txt'), 'flask==2.0\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: python (auto-detected)');
  });

  test('detects python-ml from requirements.txt with torch', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'requirements.txt'), 'torch>=2.0\nnumpy\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: python-ml (auto-detected)');

    const config = readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8');
    expect(config).toContain('toolchain = "python-ml"');
  });

  test('detects python-ml from .ipynb files', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-toolchain-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'requirements.txt'), 'pandas\n');
    await writeFile(join(tmpDir, 'analysis.ipynb'), '{"cells": []}\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Toolchain: python-ml (auto-detected)');
  });
});
