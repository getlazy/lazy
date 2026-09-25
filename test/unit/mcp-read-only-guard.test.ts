/**
 * INVARIANT: Write MCP tools (lazy_commit, lazy_comment, lazy_review) must
 * reject in a read-only turn (LAZY_MCP_READ_ONLY=1 — ask and review). The
 * handlers are the last line of defense if the agent ignores the system
 * prompt and the harness write lockdown — without this guard a misbehaving
 * model could still mutate state during a read-only turn.
 *
 * The error message must be actionable (tell the agent to answer in text)
 * so a competent model corrects course in the same turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCommitHandler, createCommentHandler, createRaiseHandler, createReviewHandler, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

describe('MCP write handlers honor LAZY_MCP_READ_ONLY=1', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;
  let prevReadOnly: string | undefined;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-readonly-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: 'abc12345', worktreePath: testDir, storage };

    prevReadOnly = process.env.LAZY_MCP_READ_ONLY;
    process.env.LAZY_MCP_READ_ONLY = '1';
  });

  afterEach(async () => {
    if (prevReadOnly === undefined) {
      delete process.env.LAZY_MCP_READ_ONLY;
    } else {
      process.env.LAZY_MCP_READ_ONLY = prevReadOnly;
    }
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test('lazy_commit rejects with actionable message', async () => {
    const handler = createCommitHandler(ctx);
    await expect(handler({ message: 'wip' })).rejects.toThrow(/read-only turn/);
    await expect(handler({ message: 'wip' })).rejects.toThrow(/lazy_commit/);
  });

  test('lazy_comment rejects with actionable message', async () => {
    const handler = createCommentHandler(ctx);
    await expect(handler({ message: 'note' })).rejects.toThrow(/read-only turn/);
    await expect(handler({ message: 'note' })).rejects.toThrow(/lazy_comment/);
  });

  test('lazy_raise rejects with actionable message', async () => {
    const handler = createRaiseHandler(ctx);
    const args = { content: 'orthogonal thing', blocking: false };
    await expect(handler(args)).rejects.toThrow(/read-only turn/);
    await expect(handler(args)).rejects.toThrow(/lazy_raise/);
  });

  test('lazy_review rejects with actionable message', async () => {
    const handler = createReviewHandler(ctx);
    await expect(handler({ task_id: 'abc12345' })).rejects.toThrow(/read-only turn/);
    await expect(handler({ task_id: 'abc12345' })).rejects.toThrow(/lazy_review/);
  });

  test('error message instructs the agent to write the answer as text', async () => {
    const handler = createCommitHandler(ctx);
    await expect(handler({ message: 'wip' })).rejects.toThrow(/answer.*text/i);
  });
});
