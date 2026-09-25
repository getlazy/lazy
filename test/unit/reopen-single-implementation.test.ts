import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { reopenTask } from '../../src/daemon/task-lifecycle';

/**
 * INVARIANT: the reopen sequence (reason comment → reopen to blocked-or-backlog
 * → session reset) exists ONCE, as `reopenTask` in src/daemon/task-lifecycle.ts.
 * It used to exist three times — CLI in-process, MCP `lazy_reopen`, and the web
 * task page's daemon service — and the copies had already drifted (the MCP copy
 * wrote a redundant status update; the CLI ordered the reason comment last).
 *
 * All three entry points must route through the one function: the CLI and MCP
 * via `queryReopenTask` (the RPC-or-fallback wrapper over `handleReopenTask`,
 * which calls it), the web service by calling it directly (it runs in-daemon).
 * Nothing outside the storage layer may run `storage.reopenTask` itself.
 */
describe('reopen has a single implementation', () => {
  const root = join(import.meta.dir, '..', '..');
  const read = (rel: string) => readFile(join(root, rel), 'utf-8');

  test('the shared daemon function exists', () => {
    expect(typeof reopenTask).toBe('function');
  });

  test('CLI `lazy reopen` routes through queryReopenTask, not its own storage sequence', async () => {
    const src = await read('src/cli/commands/reopen.ts');
    expect(src).toContain('queryReopenTask(');
    expect(src).not.toContain('storage.reopenTask(');
    expect(src).not.toContain('storage.createComment(');
    expect(src).not.toContain('storage.resetSession(');
  });

  test('MCP `lazy_reopen` routes through queryReopenTask, not its own storage sequence', async () => {
    const src = await read('src/mcp/tools.ts');
    expect(src).toContain('queryReopenTask(');
    expect(src).not.toContain('storage.reopenTask(');
  });

  test('the web task page service calls the task-lifecycle function directly', async () => {
    const src = await read('src/daemon/task-edit-service.ts');
    expect(src).toContain("reopenTask as daemonReopenTask,");
    expect(src).not.toContain('storage.reopenTask(');
  });

  test('the RPC route and its fallback both resolve to the shared function', async () => {
    const handlers = await read('src/daemon/rpc-handlers.ts');
    // handleReopenTask parses params and calls the imported task-lifecycle
    // reopenTask; the dispatch table routes the 'reopenTask' command to it.
    expect(handlers).toContain('return reopenTask(projectRoot, reopenParams);');
    expect(handlers).toContain("case 'reopenTask': return handleReopenTask(projectRoot, params);");

    const fallback = await read('src/daemon/rpc-fallback.ts');
    expect(fallback).toContain("tryRpc<ReopenTaskRpcResult>('reopenTask'");
    expect(fallback).toContain('handleReopenTask(root, params)');
  });
});
