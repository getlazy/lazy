/**
 * E2E for `lazy_update_progress` driven for real through the MCP boundary.
 *
 * The point of the tool is that an observer can see INSIDE a long turn: the
 * agent posts a line, and every surface that renders the working substate folds
 * it in. These tests exercise the whole path — agent tool call → daemon →
 * `progress.json` → the substate readers.
 *
 * INVARIANTS under test: latest-wins (no history), truncation instead of
 * rejection, and agent-only (the builder has no current task to report on).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, fullTaskId } from '../helpers/fixtures';
import { runMcpSession, mcpPayload as payload } from '../helpers/mcp-session';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { protocolDir, PROGRESS_FILE, MAX_PROGRESS_MESSAGE_LENGTH } from '../../src/protocol';

describe('lazy_update_progress (MCP channel)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The daemon is the writer — the tool handler RPCs it, no client writes the
    // marker directly — so this only means anything through a real daemon.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an agent posts progress and the latest message wins', async () => {
    const shortId = await createTask(ctx, 'Progress reporting task');
    const taskUuid = await fullTaskId(ctx, shortId);

    const responses = await runMcpSession(ctx.root, taskUuid, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_update_progress', arguments: { message: 'reproducing the bug' } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_update_progress', arguments: { message: 'running migration 3/7' } } },
    ]);

    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    expect(payload(responses.find(r => r.id === 2)).message).toBe('reproducing the bug');
    expect(payload(responses.find(r => r.id === 3))).toMatchObject({
      message: 'running migration 3/7',
      truncated: false,
    });

    // LATEST-WINS on disk: one line, not a log. Read raw rather than through
    // readTaskProgress — the writer here is the short-lived MCP subprocess (in a
    // real turn it is the daemon), and the dead-writer tripwire correctly
    // disbelieves the file once that process has exited. That the file is
    // OVERWRITTEN, not appended to, is what this asserts.
    const raw = JSON.parse(await readFile(join(protocolDir(taskUuid), PROGRESS_FILE), 'utf-8'));
    expect(raw.message).toBe('running migration 3/7');
  });

  // INVARIANT: over-length is TRUNCATED, never rejected — a progress post is
  // fire-and-forget and must never be able to cost an agent its turn — and the
  // truncation is echoed back rather than being silent.
  test('an over-long message is truncated, not rejected', async () => {
    const shortId = await createTask(ctx, 'Verbose progress task');
    const taskUuid = await fullTaskId(ctx, shortId);

    const responses = await runMcpSession(ctx.root, taskUuid, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_update_progress', arguments: { message: 'x'.repeat(500) } } },
    ]);

    const result = payload(responses.find(r => r.id === 2));
    expect(responses.find(r => r.id === 2)?.result?.isError).toBeFalsy();
    expect(result.truncated).toBe(true);
    expect((result.message as string).length).toBe(MAX_PROGRESS_MESSAGE_LENGTH);
  });

  // INVARIANT: agent-only, like lazy_commit and lazy_add_followup — the tool is
  // defined relative to "the current task" and the builder has no current task.
  test('the builder session cannot post progress', async () => {
    await createTask(ctx, 'Builder has no current task');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_update_progress', arguments: { message: 'builder progress' } } },
    ]);

    const reply = responses.find(r => r.id === 2);
    expect(reply?.result?.isError).toBe(true);
    const text = reply?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('task context');
  });

  // Shape is validated at the boundary even though length is forgiven: an empty
  // message is a caller mistake worth naming, not a blank status line.
  test('an empty message is rejected with a clear error', async () => {
    const shortId = await createTask(ctx, 'Empty progress task');
    const taskUuid = await fullTaskId(ctx, shortId);

    const responses = await runMcpSession(ctx.root, taskUuid, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_update_progress', arguments: { message: '   ' } } },
    ]);

    const reply = responses.find(r => r.id === 2);
    expect(reply?.result?.isError).toBe(true);
    expect(reply?.result?.content?.[0]?.text ?? '').toContain('non-empty');
  });
});
