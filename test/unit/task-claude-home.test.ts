import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  extractClaudePreferenceSeed,
  ensureTaskClaudeConfig,
  activateTaskClaudeConfig,
  persistTaskSessionClaudeConfig,
  taskSandboxClaudeConfigPath,
} from '../../src/task/claude-home';
import { SANDBOX_DIR } from '../../src/utils/sandbox';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

describe('task claude home', () => {
  let dir: string;
  let sandboxPath: string;
  let worktreePath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-task-claude-home-'));
    worktreePath = join(dir, 'wt');
    sandboxPath = join(worktreePath, SANDBOX_DIR);
    await mkdir(sandboxPath, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = join(dir, 'home');
    await mkdir(process.env.HOME, { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  });

  test('extractClaudePreferenceSeed copies only safe keys and defaults onboarding', () => {
    const seed = extractClaudePreferenceSeed({
      theme: 'dark',
      hasCompletedOnboarding: true,
      mcpServers: { evil: { command: 'x' } },
      claudeAiOauth: { accessToken: 'secret' },
    });
    expect(seed).toEqual({ theme: 'dark', hasCompletedOnboarding: true });
  });

  test('extractClaudePreferenceSeed sets hasCompletedOnboarding when absent', () => {
    expect(extractClaudePreferenceSeed({ theme: 'light' })).toEqual({
      theme: 'light',
      hasCompletedOnboarding: true,
    });
  });

  test('ensureTaskClaudeConfig seeds from host preferences on first write', async () => {
    await writeFile(
      join(process.env.HOME!, '.claude.json'),
      JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true }),
    );

    const path = await ensureTaskClaudeConfig(sandboxPath);
    const persisted = JSON.parse(await readFile(path, 'utf-8'));
    expect(persisted.theme).toBe('dark');
    expect(persisted.hasCompletedOnboarding).toBe(true);
    expect(persisted.mcpServers).toBeUndefined();
  });

  test('ensureTaskClaudeConfig does not re-seed once the sandbox file exists', async () => {
    const path = taskSandboxClaudeConfigPath(sandboxPath);
    await writeFile(path, JSON.stringify({ theme: 'from-sandbox' }) + '\n');
    await writeFile(
      join(process.env.HOME!, '.claude.json'),
      JSON.stringify({ theme: 'from-host' }),
    );

    await ensureTaskClaudeConfig(sandboxPath);
    expect(JSON.parse(await readFile(path, 'utf-8')).theme).toBe('from-sandbox');
  });

  test('activateTaskClaudeConfig copies sandbox state onto ephemeral container home', async () => {
    await writeFile(
      taskSandboxClaudeConfigPath(sandboxPath),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }) + '\n',
    );

    await activateTaskClaudeConfig(worktreePath);

    const container = JSON.parse(
      await readFile(join(process.env.HOME!, '.claude.json'), 'utf-8'),
    );
    expect(container.hasCompletedOnboarding).toBe(true);
    expect(container.theme).toBe('dark');
  });

  test('persistTaskSessionClaudeConfig folds UI state back and drops lazy MCP entry', async () => {
    const persistedPath = taskSandboxClaudeConfigPath(sandboxPath);
    await writeFile(persistedPath, JSON.stringify({ theme: 'dark' }) + '\n');

    await writeFile(
      join(process.env.HOME!, '.claude.json'),
      JSON.stringify({
        theme: 'light',
        hasCompletedOnboarding: true,
        mcpServers: {
          lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', '/tmp/gone.json'] },
          other: { command: 'x' },
        },
      }) + '\n',
    );

    expect(await persistTaskSessionClaudeConfig(worktreePath, () => {})).toBe(true);

    const persisted = JSON.parse(await readFile(persistedPath, 'utf-8'));
    expect(persisted.theme).toBe('light');
    expect(persisted.hasCompletedOnboarding).toBe(true);
    expect(persisted.mcpServers).toEqual({ other: { command: 'x' } });
  });
});

describe('pair container resume contract', () => {
  test('session jsonl path matches encodeProjectPath(worktree)', () => {
    const worktree = '/repo/.lazy/worktrees/some-task';
    const sessionId = 'sess-abc';
    const jsonl = join(
      worktree,
      SANDBOX_DIR,
      '.claude',
      'projects',
      encodeProjectPath(worktree),
      `${sessionId}.jsonl`,
    );
    expect(jsonl).toContain('sess-abc.jsonl');
    expect(jsonl).toContain(encodeProjectPath(worktree));
  });
});
