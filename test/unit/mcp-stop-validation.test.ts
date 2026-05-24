/**
 * INVARIANT: `lazy_stop` requires a non-empty `reason`. The reason is recorded
 * as a human turn note and surfaced in `lazy_show` — an empty reason would
 * destroy the audit trail of why the agent was halted, which is the whole
 * point of the stop ceremony.
 *
 * The MCP tool must reject missing/empty reasons BEFORE any state mutation,
 * mirroring the daemon-side `stopTask` precondition.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';

describe('lazy_stop input validation', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-stop-mcp-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test('rejects missing reason', async () => {
    const handler = createAllHandlers(ctx).get('lazy_stop')!;
    await expect(handler({ task_id: 'abc12345' })).rejects.toThrow(/reason/);
  });

  test('rejects empty reason', async () => {
    const handler = createAllHandlers(ctx).get('lazy_stop')!;
    await expect(handler({ task_id: 'abc12345', reason: '' })).rejects.toThrow(/reason/);
  });

  test('rejects whitespace-only reason', async () => {
    const handler = createAllHandlers(ctx).get('lazy_stop')!;
    await expect(handler({ task_id: 'abc12345', reason: '   ' })).rejects.toThrow(/reason/);
  });
});
