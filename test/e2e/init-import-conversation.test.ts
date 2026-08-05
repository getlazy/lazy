/**
 * e2e: `lazy init` offers to import existing Claude Code history as builder
 * memory. Adopting lazy on a repo that already has Claude Code history should
 * mean inheriting that history — not starting from scratch.
 *
 * INVARIANT: the offer is a prompt, never a silent write. It is skipped under
 * --non-interactive; on an interactive accept it imports through the store.
 *
 * Hermetic: HOME points at a temp dir seeded with a shared
 * `~/.claude/projects/<encoded-repo>/<session>.jsonl`, so detection finds real
 * on-disk history without touching the developer's actual home.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { join, resolve } from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(cwd: string, args: string[], envOverrides?: Record<string, string | undefined>) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // A credential must be present for any command that may reach the daemon
    // (e.g. import-conversation → requireStorage). Matches the e2e harness.
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing', ...envOverrides },
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

/** Seed a shared ~/.claude/projects session for `repoRoot` under `home`. */
async function seedSharedSession(home: string, repoRoot: string, sessionId: string): Promise<void> {
  const encoded = encodeProjectPath(repoRoot);
  const dir = join(home, '.claude', 'projects', encoded);
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u0`,
      parentUuid: null,
      timestamp: '2026-07-01T10:00:00Z',
      sessionId,
      cwd: repoRoot,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content: 'Inherited history from before lazy' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a0`,
      parentUuid: `${sessionId}-u0`,
      timestamp: '2026-07-01T10:00:05Z',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Now it is builder memory.' }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

describe('lazy init — inherit Claude Code history', () => {
  let tmpDir: string;
  let homeDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
  });

  test('offers and imports existing history on an interactive accept', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-import-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-home-'));
    initGitRepo(tmpDir);
    await seedSharedSession(homeDir, tmpDir, 'aaaaaaaa-2222-3333-4444-555555555555');

    // Interactive (forced TTY) with auto-accepted prompts.
    const result = await runLazy(tmpDir, ['init'], {
      HOME: homeDir,
      LAZY_FORCE_TTY: '1',
      LAZY_PROMPT_DEFAULTS: 'accept',
      LAZY_TEST: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('existing Claude Code session(s) for this repo');
    expect(result.stdout).toContain('Imported aaaaaaaa');
    expect(result.stdout).toContain('as builder memory');

    // Verify it actually reached the store.
    const list = await runLazy(tmpDir, ['import-conversation', '--show-imported'], { HOME: homeDir });
    expect(list.stdout).toContain('aaaaaaaa');
  });

  test('does not offer under --non-interactive (never silent)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-import-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-home-'));
    initGitRepo(tmpDir);
    await seedSharedSession(homeDir, tmpDir, 'bbbbbbbb-2222-3333-4444-555555555555');

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], { HOME: homeDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('existing Claude Code session(s)');
    expect(result.stdout).not.toContain('Imported bbbbbbbb');

    // Nothing was imported silently.
    const list = await runLazy(tmpDir, ['import-conversation', '--show-imported'], { HOME: homeDir });
    expect(list.stdout).not.toContain('bbbbbbbb');
  });
});
