/**
 * E2E: structured turn report + justify tools.
 *
 * INVARIANT: lazy_report is a reporting channel only — it does NOT change task
 * status and does NOT end a turn (no fuse / liveness coupling). Skipping the
 * tool degrades to today's prose path. Justification never auto-approves.
 *
 * See docs/design/structured-turn-report.md §6.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, worktreePathFor } from '../helpers/storage';
import { runMcpSession, mcpPayload } from '../helpers/mcp-session';

async function createStartedBlockedTask(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktreePath = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

  return taskId;
}

describe('structured turn report', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy_report stores sections in agent order; lazy show exposes them', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Structured report order');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            // Deliberately non-canonical order — MCP/storage must preserve it.
            // Human-facing CLI/web then apply the presentation policy.
            sections: [
              { kind: 'how_to_verify', body: 'Run bun test test/e2e/structured-turn-report.test.ts' },
              { kind: 'what_was_done', body: 'Shipped the report tool' },
              { kind: 'commentary', body: 'First commentary' },
              { kind: 'commentary', body: 'Second commentary (duplicate kind ok)' },
            ],
          },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_show',
          arguments: { task_id: taskId },
        },
      },
    ], { timeoutMs: 60_000 });

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    const report = mcpPayload(responses.find(r => r.id === 2));
    const sections = report.sections as Array<{ kind: string; body: string }>;
    expect(sections.map(s => s.kind)).toEqual([
      'how_to_verify',
      'what_was_done',
      'commentary',
      'commentary',
    ]);
    expect(sections[0]!.body).toContain('structured-turn-report');

    const show = mcpPayload(responses.find(r => r.id === 3));
    const turnReport = show.turn_report as { sections: Array<{ kind: string; body: string }> };
    expect(turnReport).toBeTruthy();
    expect(turnReport.sections.map(s => s.kind)).toEqual([
      'how_to_verify',
      'what_was_done',
      'commentary',
      'commentary',
    ]);

    const cliShow = await ctx.lazy(['show', taskId]);
    expectSuccess(cliShow);
    expectOutput(cliShow, 'Turn report');
    expectOutput(cliShow, 'How to verify');
    // Human-facing CLI applies the same tier policy as web: legacy
    // what_was_done keeps the "What was done" label and ranks with behavior
    // (before how_to_verify). MCP show still returns agent order (above).
    expectOutput(cliShow, 'What was done');
    expect(cliShow.stdout.indexOf('What was done')).toBeLessThan(
      cliShow.stdout.indexOf('How to verify'),
    );
  }, 90000);

  // INVARIANT: reporting channel never changes status / ends a turn.
  test('lazy_report does not change task status', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Report non-triggering');
    const worktree = worktreePathFor(ctx.root, taskId);
    const statusBefore = readTaskStatus(ctx.root, taskId);
    expect(statusBefore).toBe('blocked');

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Only reporting' }],
          },
        },
      },
    ], { timeoutMs: 60_000 });

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    mcpPayload(responses.find(r => r.id === 2));
    expect(readTaskStatus(ctx.root, taskId)).toBe(statusBefore);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 90000);

  test('skip lazy_report — prose path still visible via show turns', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Prose degradation');
    // No lazy_report call — agent turn prose from the mock remains the report.
    const show = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(show);
    // Mock agent response body is present as turn content (today's path).
    expect(show.stdout.length).toBeGreaterThan(0);
    // Structured report section must be absent when the tool was never called.
    expect(show.stdout).not.toMatch(/Turn report/);
  }, 90000);

  test('lazy_justify_protected records keep reason visible on show', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Justify protected');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_justify_protected',
          arguments: {
            file: 'CHANGELOG.md',
            reason: 'Added the user-visible line for this ship',
          },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_show',
          arguments: { task_id: taskId },
        },
      },
    ], { timeoutMs: 60_000 });

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    const decision = mcpPayload(responses.find(r => r.id === 2));
    expect(decision.scope).toBe('protected');
    expect(decision.file).toBe('CHANGELOG.md');
    expect(decision.decision).toBe('keep');
    expect(String(decision.reason)).toContain('user-visible');

    const show = mcpPayload(responses.find(r => r.id === 3));
    const decisions = show.file_decisions as Array<{ scope: string; target: string; reason: string }>;
    expect(decisions.some(d => d.scope === 'protected' && d.target === 'CHANGELOG.md')).toBe(true);

    // Status unchanged — justify is not approval.
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 90000);

  test('lazy_justify_maintain records skip reason', async () => {
    const taskId = await createStartedBlockedTask(ctx, 'Justify maintain');
    const worktree = worktreePathFor(ctx.root, taskId);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_justify_maintain',
          arguments: {
            group: 'lazy.toml.example',
            reason: 'No config keys added',
          },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_show',
          arguments: { task_id: taskId },
        },
      },
    ], { timeoutMs: 60_000 });

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    const decision = mcpPayload(responses.find(r => r.id === 2));
    expect(decision.scope).toBe('maintain');
    expect(decision.group).toBe('lazy.toml.example');
    expect(String(decision.reason)).toContain('No config');

    const show = mcpPayload(responses.find(r => r.id === 3));
    const decisions = show.file_decisions as Array<{ scope: string; target: string }>;
    expect(decisions.some(d => d.scope === 'maintain' && d.target === 'lazy.toml.example')).toBe(true);
  }, 90000);
});
