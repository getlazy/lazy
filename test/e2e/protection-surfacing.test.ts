/**
 * E2E tests for READ-ONLY protection surfacing.
 *
 * `[protection]` used to be invisible until an accept was refused. These tests
 * pin the two halves of the fix:
 *
 *  1. When a project protects something, every read surface SAYS so — `lazy
 *     show`, `lazy status`, `lazy list`, and MCP `lazy_show` — including
 *     whether a `lazy approve` is already recorded and pending.
 *  2. When a project protects nothing, the output is byte-for-byte what it was.
 *     Surfacing is additive; a stock project's `list`/`show` must not grow a
 *     marker, a column, or a line that a script would trip over.
 *
 * INVARIANT: these surfaces are read-only. There is no `lazy_protect` /
 * `lazy_approve` tool and nothing here creates one — arranging your own gates
 * is a human act (docs/surface-asymmetries.md).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runMcpSession } from '../helpers/mcp-session';

const PASSPHRASE = 'test-approval-passphrase';

/**
 * Opt in to branch protection (OFF by default) and enroll the passphrase.
 *
 * The `[protection]` section is EDITED in place rather than the file rewritten:
 * `lazy init` also wrote `external_path` into this lazy.toml, and a stub file
 * would silently point every command at an empty default store.
 */
async function enableProtection(ctx: TestContext, extraProtectionToml = ''): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  if (!toml.includes('[protection]')) {
    throw new Error('Expected lazy init template to contain a [protection] section');
  }
  const updated = toml.replace('[protection]\n', `[protection]\nenabled = true\n${extraProtectionToml}`);
  expect(updated).not.toBe(toml);
  await writeFile(tomlPath, updated);
  await writeFile(join(ctx.root, '.lazy', 'approve-passphrase'), `${PASSPHRASE}\n`);
}

/** List `taskCode` in [protection].protected_tasks WITHOUT enabling protection. */
async function listProtectedTaskOnly(ctx: TestContext, taskRef: string): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  const updated = toml.replace('[protection]\n', `[protection]\nprotected_tasks = ["${taskRef}"]\n`);
  expect(updated).not.toBe(toml);
  await writeFile(tomlPath, updated);
}

/** Create a task and run one mocked turn so it has a branch and a session. */
async function startedTask(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Add a file');
  const started = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(started);
  expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
  return taskId;
}

describe('protection surfacing (read-only)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // A real daemon: `start` hands off to the supervisor asynchronously and the
    // reconciler is what moves the task out of `working`.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy show reports the branch gate and how to unlock it', async () => {
    await enableProtection(ctx);
    const taskId = await startedTask(ctx, 'Show branch gate');

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expect(result.stdout).toContain('Protected: yes (branch gate)');
    expect(result.stdout).toContain('the repo default branch');
    expect(result.stdout).toContain('No approval recorded');
    expect(result.stdout).toContain(`lazy approve ${taskId}`);
  }, 60000);

  test('lazy show reports a recorded approval as pending', async () => {
    await enableProtection(ctx);
    const taskId = await startedTask(ctx, 'Show pending approval');

    expectSuccess(await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` }));

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expect(result.stdout).toContain('Protected: yes (branch gate)');
    expect(result.stdout).toContain('Approval pending');
    expect(result.stdout).not.toContain('No approval recorded');
  }, 60000);

  test('lazy status reports protection in the same words as show', async () => {
    await enableProtection(ctx);
    const taskId = await startedTask(ctx, 'Status branch gate');

    const result = await ctx.lazy(['status', taskId]);
    expectSuccess(result);
    expect(result.stdout).toContain('Protected: yes (branch gate)');
  }, 60000);

  test('lazy list marks protected tasks and prints the legend', async () => {
    await enableProtection(ctx);
    const taskId = await startedTask(ctx, 'List marker task');

    const before = await ctx.lazy(['list']);
    expectSuccess(before);
    expect(before.stdout).toContain('[P]');
    expect(before.stdout).not.toContain('[P][A]');
    expect(before.stdout).toContain('protected — accepting needs');

    expectSuccess(await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` }));

    const after = await ctx.lazy(['list']);
    expectSuccess(after);
    expect(after.stdout).toContain('[P][A]');
    expect(after.stdout).toContain('approval recorded and pending');
  }, 60000);

  // A task the human wrote into [protection].protected_tasks while the master
  // switch is off is NOT gated. Saying nothing would leave them believing a
  // gate is armed; showing a `[P]` marker would be a lie in the other
  // direction. `show` explains, `list` stays clean.
  test('a listed task with protection disabled reads as "listed, but disabled"', async () => {
    const taskId = await startedTask(ctx, 'Listed but disabled');
    await listProtectedTaskOnly(ctx, taskId);

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expect(show.stdout).toContain('but protection is disabled');

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expect(list.stdout).not.toContain('[P]');
  }, 60000);

  // INVARIANT: surfacing is ADDITIVE. A project that protects nothing must see
  // exactly the output it saw before this feature existed — no marker, no
  // legend, no `Protected:` line for a script to trip over.
  test('an unprotected project shows no markers and no Protected line', async () => {
    const taskId = await startedTask(ctx, 'Unprotected task');

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expect(show.stdout).not.toContain('Protected:');

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expect(list.stdout).not.toContain('[P]');
    expect(list.stdout).not.toContain('protected — accepting needs');
  }, 60000);

  // The builder sees the same gate the human sees — read-only, so it can plan
  // around a refusal instead of discovering it.
  test('MCP lazy_show carries the protection object', async () => {
    await enableProtection(ctx);
    const taskId = await startedTask(ctx, 'MCP protection field');
    expectSuccess(await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` }));

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
      { method: 'tools/call', id: 2, params: { name: 'lazy_show', arguments: { task_id: taskId } } },
    ]);

    const reply = responses.find(r => r.id === 2);
    expect(reply).toBeDefined();
    const text = reply!.result?.content?.map(c => c.text).join('\n') ?? '';
    const payload = JSON.parse(text) as { protection?: Record<string, unknown> };
    expect(payload.protection).toBeDefined();
    expect(payload.protection!.gated).toBe(true);
    expect(payload.protection!.markers).toBe('[P][A]');
    expect((payload.protection!.branch_gate as { source: string }).source).toBe('default-branch');
    expect(payload.protection!.approval_pending).not.toBeNull();
  }, 60000);
});
