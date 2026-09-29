/**
 * The two guards that keep a task supervisor from re-pointing someone else's
 * lazy tool channel (incident 2026-09-28: a test run's supervisor, started
 * inside a builder container with the builder's HOME, rewrote the builder's
 * `mcpServers.lazy` to a worktree deleted minutes later).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeMcpConfig, lazyMcpEntryOwner, ForeignMcpEntryError } from '../../src/mcp/config';
import { assertTestLaunchHasPrivateHome, TEST_AGENT_HOME_ENV } from '../../src/mcp/test-home-guard';
import { prepareTurnMcp, McpToolsUnavailableError } from '../../src/supervisor/mcp-setup';
import { TEST_PARENT_PID_ENV } from '../../src/daemon/test-parent-watch';
import type { Runner } from '../../src/runner/types';

const BUILDER_ENTRY = { command: 'lazy-agent', args: ['mcp', '--daemon-config', '/tmp/d.json', '--worktree', '/repo'] };
const taskEntry = (id: string) => ({ command: 'lazy-agent', args: ['mcp', '--task-id', id, '--worktree', `/wt/${id}`] });

const stubRunner = {
  mcpServerConfig: (taskId: string, worktreePath: string) => ({
    command: 'lazy-agent', args: ['mcp', '--task-id', taskId, '--worktree', worktreePath],
  }),
} as unknown as Runner;
const quiet = { info: () => {}, warn: () => {} };

function restoreEnv(saved: { home?: string; parent?: string; agent?: string }): void {
  for (const [key, value] of [['HOME', saved.home], [TEST_PARENT_PID_ENV, saved.parent], [TEST_AGENT_HOME_ENV, saved.agent]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('mcpServers.lazy ownership', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-mcp-owner-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  test('the owner is read off the entry: --task-id names a task, anything else is not a task', () => {
    expect(lazyMcpEntryOwner(taskEntry('t1'))).toEqual({ kind: 'task', taskId: 't1', worktree: '/wt/t1' });
    expect(lazyMcpEntryOwner(BUILDER_ENTRY)).toEqual({ kind: 'other' });
  });

  // INVARIANT (no-task-over-builder-entry): a task supervisor never replaces an
  // mcpServers.lazy entry that is not a task's (a builder's or a human's). One
  // HOME, one entry: replacing it cut a live builder off from every lazy tool.
  test("a task's write refuses to replace a builder's entry, naming both, and leaves the file alone", async () => {
    const path = join(home, '.claude.json');
    const before = JSON.stringify({ theme: 'dark', mcpServers: { lazy: BUILDER_ENTRY } });
    await writeFile(path, before);

    const err = await writeMcpConfig(taskEntry('605e9a6b')).catch(e => e);
    expect(err).toBeInstanceOf(ForeignMcpEntryError);
    expect(err.message).toContain('605e9a6b');
    expect(err.message).toContain('--daemon-config /tmp/d.json');
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  test("the owning task rewrites its own entry, and another task's entry is replaced", async () => {
    await writeMcpConfig(taskEntry('t1'));
    await writeMcpConfig({ ...taskEntry('t1'), args: [...taskEntry('t1').args, '--read-only'] });
    await writeMcpConfig(taskEntry('t2'));
    const cfg = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8'));
    expect(cfg.mcpServers.lazy.args).toContain('t2');
  });

  test('a builder-style write (no --task-id) is never refused by this rule', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { lazy: BUILDER_ENTRY } }));
    await writeMcpConfig(BUILDER_ENTRY);
  });

  test('the refusal fails the turn rather than running it toolless', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { lazy: BUILDER_ENTRY } }));
    const err = await prepareTurnMcp(stubRunner, 'task-x', '/wt/x', {}, quiet).catch(e => e);
    expect(err).toBeInstanceOf(McpToolsUnavailableError);
    expect(err.message).toContain('not a task');
  });
});

describe('a test-launched supervisor never writes the account home', () => {
  // INVARIANT (test-supervisor-private-home): with LAZY_TEST_PARENT_PID set, a
  // supervisor writes agent config only into the private HOME its harness
  // declared (LAZY_TEST_AGENT_HOME). Anything else — the real HOME a harness
  // forgot to replace — fails the turn instead of hijacking a live tool channel.
  test('refuses an undeclared or different HOME under a test parent', () => {
    expect(() => assertTestLaunchHasPrivateHome({
      env: { [TEST_PARENT_PID_ENV]: '123' }, home: '/home/user',
    })).toThrow(/private home/);
    expect(() => assertTestLaunchHasPrivateHome({
      env: { [TEST_PARENT_PID_ENV]: '123', [TEST_AGENT_HOME_ENV]: '/tmp/x' }, home: '/home/user',
    })).toThrow(/\/home\/user/);
  });

  test('allows the declared HOME under a test parent, and anything outside a test', () => {
    assertTestLaunchHasPrivateHome({ env: { [TEST_PARENT_PID_ENV]: '123', [TEST_AGENT_HOME_ENV]: '/tmp/x/' }, home: '/tmp/x' });
    assertTestLaunchHasPrivateHome({ env: {}, home: '/home/user' });
  });

  test('a test-launched supervisor on the real HOME fails the turn and writes nothing', async () => {
    const realHome = await mkdtemp(join(tmpdir(), 'lazy-real-home-'));
    const realConfig = join(realHome, '.claude.json');
    const original = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } });
    await writeFile(realConfig, original);
    const saved = { home: process.env.HOME, parent: process.env[TEST_PARENT_PID_ENV], agent: process.env[TEST_AGENT_HOME_ENV] };
    try {
      process.env[TEST_PARENT_PID_ENV] = String(process.pid);
      delete process.env[TEST_AGENT_HOME_ENV];
      process.env.HOME = realHome;
      const err = await prepareTurnMcp(stubRunner, 'task-r', '/wt/r', {}, quiet).catch(e => e);
      expect(err).toBeInstanceOf(McpToolsUnavailableError);
      expect(await readFile(realConfig, 'utf-8')).toBe(original);
    } finally {
      restoreEnv(saved);
      await rm(realHome, { recursive: true, force: true });
    }
  });

  // Unit-level only: where a declared-home turn's write lands. The end-to-end
  // proof against the test process's own HOME is test/e2e/test-home-isolation.test.ts.
  test('a declared-home turn writes only into that home, not a sibling directory', async () => {
    const realHome = await mkdtemp(join(tmpdir(), 'lazy-real-home-'));
    const privateHome = await mkdtemp(join(tmpdir(), 'lazy-private-home-'));
    const realConfig = join(realHome, '.claude.json');
    const original = JSON.stringify({ mcpServers: { lazy: BUILDER_ENTRY } });
    await writeFile(realConfig, original);
    const mtime = (await stat(realConfig)).mtimeMs;

    const saved = { home: process.env.HOME, parent: process.env[TEST_PARENT_PID_ENV], agent: process.env[TEST_AGENT_HOME_ENV] };
    try {
      process.env[TEST_PARENT_PID_ENV] = String(process.pid);
      process.env[TEST_AGENT_HOME_ENV] = privateHome;

      // The harness shape: a private HOME. The turn's config lands there.
      process.env.HOME = privateHome;
      await prepareTurnMcp(stubRunner, 'task-h', '/wt/h', {}, quiet);
      const written = JSON.parse(await readFile(join(privateHome, '.claude.json'), 'utf-8'));
      expect(written.mcpServers.lazy.args).toContain('task-h');

      // The real HOME is byte-for-byte what it was.
      expect(await readFile(realConfig, 'utf-8')).toBe(original);
      expect((await stat(realConfig)).mtimeMs).toBe(mtime);
    } finally {
      restoreEnv(saved);
      await rm(realHome, { recursive: true, force: true });
      await rm(privateHome, { recursive: true, force: true });
    }
  });
});

describe('a test-launched pair session never writes an undeclared HOME', () => {
  // INVARIANT (test-supervisor-private-home, pair path): pair replaces
  // $HOME/.claude.json wholesale with the task's sandbox copy BEFORE the turn's
  // MCP write, so the guard must run ahead of that copy too.
  test('refuses before copying the sandbox config over HOME', async () => {
    const { runInContainerPair } = await import('../../src/supervisor/pair');
    const realHome = await mkdtemp(join(tmpdir(), 'lazy-real-home-'));
    const worktree = await mkdtemp(join(tmpdir(), 'lazy-pair-wt-'));
    const realConfig = join(realHome, '.claude.json');
    const original = JSON.stringify({ mcpServers: { lazy: BUILDER_ENTRY } });
    await writeFile(realConfig, original);
    const saved = { home: process.env.HOME, parent: process.env[TEST_PARENT_PID_ENV], agent: process.env[TEST_AGENT_HOME_ENV] };
    try {
      process.env[TEST_PARENT_PID_ENV] = String(process.pid);
      delete process.env[TEST_AGENT_HOME_ENV];
      process.env.HOME = realHome;
      const err = await runInContainerPair({
        taskId: 'task-p', worktreePath: worktree, harness: 'claude-code', runnerType: 'docker', modelId: 'claude-opus-5-5',
      } as Parameters<typeof runInContainerPair>[0]).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toContain(TEST_AGENT_HOME_ENV);
      expect(await readFile(realConfig, 'utf-8')).toBe(original);
    } finally {
      restoreEnv(saved);
      await rm(realHome, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
