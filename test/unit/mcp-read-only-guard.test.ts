/**
 * INVARIANT: Write MCP tools (lazy_commit, lazy_propose, lazy_comment) must
 * reject in ask mode (LAZY_MCP_READ_ONLY=1). The handlers are the last line
 * of defense if the agent ignores the ask-system-prompt and the
 * `--disallowedTools` lockdown — without this guard a misbehaving model
 * could still mutate state during a read-only Q&A turn.
 *
 * The error message must be actionable (tell the agent to answer in text)
 * so a competent model corrects course in the same turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCommitHandler, createProposeHandler, createCommentHandler, createAddFollowUpHandler, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';

describe('MCP write handlers honor LAZY_MCP_READ_ONLY=1', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;
  let prevReadOnly: string | undefined;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-readonly-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

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
    await expect(handler({ message: 'wip' })).rejects.toThrow(/ask mode/);
    await expect(handler({ message: 'wip' })).rejects.toThrow(/lazy_commit/);
  });

  test('lazy_propose rejects with actionable message', async () => {
    const handler = createProposeHandler(ctx);
    await expect(handler({ goal: 'do thing' })).rejects.toThrow(/ask mode/);
    await expect(handler({ goal: 'do thing' })).rejects.toThrow(/lazy_propose/);
  });

  test('lazy_comment rejects with actionable message', async () => {
    const handler = createCommentHandler(ctx);
    await expect(handler({ message: 'note' })).rejects.toThrow(/ask mode/);
    await expect(handler({ message: 'note' })).rejects.toThrow(/lazy_comment/);
  });

  test('lazy_add_followup rejects with actionable message', async () => {
    const handler = createAddFollowUpHandler(ctx);
    await expect(handler({ note: 'orthogonal thing' })).rejects.toThrow(/ask mode/);
    await expect(handler({ note: 'orthogonal thing' })).rejects.toThrow(/lazy_add_followup/);
  });

  test('error message instructs the agent to write the answer as text', async () => {
    const handler = createCommitHandler(ctx);
    await expect(handler({ message: 'wip' })).rejects.toThrow(/answer.*text/i);
  });
});
