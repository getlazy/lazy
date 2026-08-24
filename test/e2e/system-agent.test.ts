/**
 * `lazy system agent` — readiness view, default-agent switching, API keys
 * (cursor-first-class-agent, Goal B / item 3).
 *
 * The switching tests double as the no-restart property tests: the daemon
 * re-reads config on every launch and the CLI on every invocation, so a
 * `set`/`set-key` performed while a daemon is up affects the very next
 * operation. The daemon-backed suite at the bottom proves it end-to-end.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { credentialsPath } from '../../src/agent/credentials';

describe('lazy system agent (daemonless)', () => {
  let ctx: TestContext;
  let daemonBase: string;
  let unpinDaemonBase: () => void;

  beforeEach(async () => {
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
    // Unpin only AFTER cleanup — cleanup resolves paths from this variable.
    unpinDaemonBase();
    await removeDaemonBaseDir(daemonBase);
  });

  test('status lists every registered agent and marks the default', async () => {
    const result = await ctx.lazy(['system', 'agent']);
    expectSuccess(result);
    expectOutput(result, 'claude-code');
    expectOutput(result, 'cursor');
    expectOutput(result, 'default');
    expectOutput(result, 'Default agent: claude-code');
  });

  test('set switches the default, preserving lazy.toml comments', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).toContain('agent_id = "claude-code"');

    const result = await ctx.lazy(['system', 'agent', 'set', 'cursor']);
    expectSuccess(result);
    expectOutput(result, 'Default agent is now "cursor"');
    expectOutput(result, 'no restart');
    // No key configured → the command must point at the remedy up front.
    expectOutput(result, 'lazy system agent set-key cursor');

    const after = await readFile(configPath, 'utf-8');
    expect(after).toContain('agent_id = "cursor"');
    // The init template's comment above the key survives the text edit.
    expect(after).toContain('# Default agent for task execution');

    const status = await ctx.lazy(['system', 'agent', 'status']);
    expectOutput(status, 'Default agent: cursor');
  });

  test('set refuses an unknown agent, naming the valid ones', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set', 'codex']);
    expectFailure(result);
    expectError(result, 'Unknown agent');
    expectError(result, 'claude-code');
  });

  test('set-key stores a 0600 key outside the repo that clear-key removes', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'cursor'], { input: 'key_test_123\n' });
    expectSuccess(result);
    expectOutput(result, 'Stored cursor API key');
    expectOutput(result, 'no daemon restart');

    // SECURITY INVARIANT (fix-cursor-security-musts §1): the key lives in the
    // per-project daemon dir, NOT under the project root. Every task container
    // mounts the repo read-only, so an in-repo key is readable by every agent
    // of every task — 0600 stops other host users, not the container.
    const credPath = credentialsPath(ctx.root);
    expect(credPath.startsWith(ctx.root)).toBe(false);
    expectOutput(result, credPath);
    const parsed = JSON.parse(await readFile(credPath, 'utf-8'));
    expect(parsed.cursor.api_key).toBe('key_test_123');
    expect((await stat(credPath)).mode & 0o777).toBe(0o600);

    // Nothing is left behind in the mounted tree.
    await expect(stat(join(ctx.root, '.lazy', 'agent-credentials.json'))).rejects.toThrow();

    // Status reflects the stored key, naming where it lives.
    const status = await ctx.lazy(['system', 'agent', 'status']);
    expectOutput(status, `project key (${credPath})`);

    const cleared = await ctx.lazy(['system', 'agent', 'clear-key', 'cursor']);
    expectSuccess(cleared);
    expectOutput(cleared, 'Removed the stored cursor API key');
  });

  test('set-key reads the key from piped stdin', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'cursor'], { input: 'piped_key_9\n' });
    expectSuccess(result);
    const parsed = JSON.parse(await readFile(credentialsPath(ctx.root), 'utf-8'));
    expect(parsed.cursor.api_key).toBe('piped_key_9');
  });

  // SECURITY INVARIANT (fix-cursor-security-musts §4): there is no argv form.
  // A key passed as an argument lands in shell history and is visible in `ps`
  // to every user on the machine, so the trailing-argument form was removed
  // outright rather than kept as a convenience. It is REJECTED rather than
  // ignored: a user who typed a real key there has already exposed it, and
  // needs to be told to rotate it instead of assuming it was stored.
  test('set-key rejects a key passed as an argument and says to rotate it', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'cursor', 'key_from_argv']);
    expectFailure(result);
    expectError(result, 'takes no key argument');
    expectError(result, 'shell history');
    expectError(result, 'ROTATE IT');
    // Nothing stored, and the key the user typed is not echoed back anywhere.
    await expect(stat(credentialsPath(ctx.root))).rejects.toThrow();
    expect(result.stdout + result.stderr).not.toContain('key_from_argv');
  });

  test('set-key refuses agents that have no managed key', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'claude-code']);
    expectFailure(result);
    expectError(result, 'does not use an API key');
  });

  test('system agent -h prints its own usage, not the parent help', async () => {
    const result = await ctx.lazy(['system', 'agent', '--help']);
    expectOutput(result, 'lazy system agent [status|set');
  });
});

describe('lazy system agent (daemon-backed pickup)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (cursor-first-class-agent, Goal B): a switch made while a daemon
  // is RUNNING is picked up by the next operation — never a daemon restart.
  // Config is re-read per invocation/launch; nothing caches [agent] agent_id
  // across launches. This is the property that makes direct-file config
  // editing (the `lazy protect` precedent) sufficient.
  test('a default-agent switch takes effect on the next create with the daemon running', async () => {
    const before = await ctx.lazy(['create', '--goal', 'pre-switch task']);
    expectSuccess(before);
    // Default agent → no Agent line is printed (claude-code is the norm).
    expect(before.stdout).not.toContain('Agent:');

    expectSuccess(await ctx.lazy(['system', 'agent', 'set', 'cursor']));

    const after = await ctx.lazy(['create', '--goal', 'post-switch task']);
    expectSuccess(after);
    expectOutput(after, 'Agent:');
    expectOutput(after, 'cursor');
  });
});
